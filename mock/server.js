/* Pure browser-side mock server: the JS version of mock_server.py
 *
 * Outer wrapper (packet.proto)
 *   f1  packet_type   1 = Response, 2 = Request / KeepAlive
 *   f2  msg_id
 *   f3  payload (the concrete business proto)
 *   f6  ? the server fills in 2 in KeepAlive replies
 *   f7  uid (internal uid assigned by the server)
 *   f8  ? fixed at 1
 *   f11 seq (echoes the seq from the request)
 *   f12 ? the client always fills in 4001
 *   f24 DataChange: user-data increments pushed back (save operations only succeed through this)
 *   f27 server downstream counter
 *   f29 client version number
 *
 * Convention: response msg_id = request msg_id + 1; KeepAlive(20019) is the exception and is echoed as-is.
 */
(function (global) {
  'use strict';

  var MJ = global.__mj || (global.__mj = {});
  var P = MJ.proto;
  var U = MJ.userdata;
  var DATA = MJ.data;

  var UID = 349804;                 // Server-internal uid (as returned by the server in packet captures)
  var CLIENT_VERSION = '1.1.107241726.0';

  var LOG = { enabled: true, unhandled: [] };

  /** Request-rate statistics: msgId -> { n, last }, used to locate "spammy" messages */
  var REQ_STATS = {};

  /** Details of recent 100141 requests (used to diagnose spam) */
  var LAST_QUERIES = [];

  /** Match parameters: can be overridden with URL query strings, or changed in the console via __mj.config before re-entering a match.
   *    ?mjPlayers=3   3-player (North is pulled automatically on draw)
   *    ?mjSeed=12345  fixed wall random seed, for reproducibility
   *    ?mjSpeed=0.4   AI thinking-delay multiplier, 0 = instant
   */
  var CONFIG = MJ.config || (MJ.config = {
    players: 4, matchLength: 'east', akaCount: 1, speed: 1, seed: undefined, autoHuman: false
  });
  (function readQuery() {
    try {
      var q = new URLSearchParams(global.location ? global.location.search : '');
      if (q.get('mjPlayers')) {
        CONFIG.players = parseInt(q.get('mjPlayers'), 10);
        CONFIG.playersExplicit = true;   // An explicit value overrides the gameType in the match request
      }
      if (q.get('mjLength')) {
        CONFIG.matchLength = q.get('mjLength') === 'hanchan' ? 'hanchan' : 'east';
        CONFIG.matchLengthExplicit = true;
      }
      if (q.get('mjMatchDelay')) CONFIG.matchDelay = parseInt(q.get('mjMatchDelay'), 10);
      if (q.get('mjSeed')) CONFIG.seed = parseInt(q.get('mjSeed'), 10);
      if (q.get('mjSpeed')) CONFIG.speed = parseFloat(q.get('mjSpeed'));
      if (q.get('mjAka')) CONFIG.akaCount = parseInt(q.get('mjAka'), 10);
      if (q.get('mjAutoHuman')) CONFIG.autoHuman = parseInt(q.get('mjAutoHuman'), 10) !== 0;
    } catch (e) { /* Not a browser environment */ }
  })();

  function nameOf(mid) { return (DATA.names && DATA.names[mid]) || '?'; }
  function nowS() { return Math.floor(Date.now() / 1000); }
  function nowMs() { return Date.now(); }

  function log() {
    if (!LOG.enabled) return;
    console.log.apply(console, arguments);
  }

  // Reconnect/session diagnostics must survive mock.quiet(): after a stuck reconnection the question is "where did it stop",
  // and these marks answer exactly that (WS back -> 20162 -> replay done -> live push).
  function stampLog(line) {
    // Host sinks already timestamp each record; do not nest a second clock in the message.
    console.log(line.trimStart());
  }

  // Recording/replay library: msg_id -> payload
  var REPLAY = {};
  for (var k in DATA.replayB64) {
    if (Object.prototype.hasOwnProperty.call(DATA.replayB64, k)) {
      REPLAY[k] = P.b64decode(DATA.replayB64[k]);
    }
  }

  // Mutable lobby user data: save operations change it directly here and push the increment back through wrapper f24
  var USERDATA = new U.UserData(P.b64decode(DATA.userdataB64), UID);

  /* ================================================================== *
   * Root cause of the 100141 spam: DT39(Task)'s "refresh point" is a timestamp, and the one in the snapshot had already expired
   * ------------------------------------------------------------------
   * schema (protos/src/user_info/user_info.proto):
   *   TaskInfo{1:ResidentTask} -> ResidentTask{3:map<int32,SingleTaskRecycleData>}
   *   SingleTaskRecycleData{1:recycleType(1=daily,2=weekly), 2:score,
   *                         3:refreshTime(next refresh point), 4:realRefreshTime(last actual refresh)}
   *
   * The client logic is "now >= refreshTime -> local task data expired -> send 100141 to query DT39".
   * The mock replied "same version + 0 rows", so the client's local refreshTime stayed in the past, and it
   * queried again immediately: this is the endless loop of 43B requests / 27B responses (independent of whether the module exists).
   * When the real server reaches a refresh point, it recomputes tasks, bumps the version, and sends a "future refreshTime";
   * the client converges in one round, which is why in real captures DT39 is only polled occasionally rather than spammed.
   *
   * Fix: at startup (and each time DT39 is queried), push expired refresh points to the next refresh point,
   * and bump the module version. A client with cliVer < srvVer gets the whole module plus the future refresh point,
   * so it stops re-requesting this interface. Idempotent: no change when nothing has expired.
   * ================================================================== */
  var TZ_OFFSET = 8 * 3600;                 // Refresh points are computed at 00:00 UTC+8

  function dayIndex(ts) { return Math.floor((ts + TZ_OFFSET) / 86400); }
  function dayStart(d) { return d * 86400 - TZ_OFFSET; }
  function dayOfWeek(d) { return (d + 4) % 7; }      // 0 = Sunday (1970-01-01 was a Thursday)

  /** Next refresh point: type 2 = weekly (next Monday 00:00), otherwise daily (next day 00:00) */
  function nextRefreshPoint(rtype, now) {
    var d = dayIndex(now);
    if (Number(rtype) === 2) {
      var dow = dayOfWeek(d) || 7;                   // 1..7, 7 = Sunday
      return dayStart(d + (8 - dow));
    }
    return dayStart(d + 1);
  }

  /** Start of the current cycle (written to realRefreshTime: the time of the last actual refresh) */
  function curPeriodStart(rtype, now) {
    var d = dayIndex(now);
    if (Number(rtype) === 2) {
      var dow = dayOfWeek(d) || 7;
      return dayStart(d - (dow - 1));
    }
    return dayStart(d);
  }

  function tsText(ts) {
    try { return new Date(Number(ts) * 1000).toLocaleString(); }
    catch (e) { return String(ts); }
  }

  /** Rewrite one SingleTaskRecycleData; returns null if not expired (no change) */
  function fixRecycleValue(valBytes, mapKey, now) {
    var d = P.dict(valBytes);
    var rtype = Number(d[1] != null ? d[1] : mapKey) || 1;
    var old = Number(d[3] || 0);
    if (old > now) return null;                      // Refresh point still in the future -> nothing to do
    var to = nextRefreshPoint(rtype, now);
    var nb = P.setVarint(valBytes, 3, to);           // refreshTime -> next refresh point
    nb = P.setVarint(nb, 4, curPeriodStart(rtype, now));  // realRefreshTime -> start of this cycle
    return { bytes: nb, rtype: rtype, from: old, to: to };
  }

  /** Iterate ResidentTask.f3 (recycles map entries); rewrite the expired ones; returns null if nothing changed */
  function fixResidentTask(bytes, now, report) {
    var fs = P.parse(bytes), w = P.W(), changed = false;
    for (var i = 0; i < fs.length; i++) {
      var fn = fs[i][0], wt = fs[i][1], val = fs[i][2];
      if (fn === 3 && wt === 2) {
        var mapKey = Number(P.dict(val)[1] || 0);
        var ent = P.parse(val), ew = P.W(), entChanged = false;
        for (var j = 0; j < ent.length; j++) {
          var efn = ent[j][0], ewt = ent[j][1], ev = ent[j][2];
          if (efn === 2 && ewt === 2) {
            var r = fixRecycleValue(ev, mapKey, now);
            if (r) {
              ew.s(2, r.bytes);
              entChanged = true;
              r.key = mapKey;
              report.push(r);
              continue;
            }
          }
          P.reencode(ew, efn, ewt, ev);
        }
        if (entChanged) { w.s(3, ew.bytes()); changed = true; continue; }
      }
      P.reencode(w, fn, wt, val);
    }
    return changed ? w.bytes() : null;
  }

  /** DT39 Task: push expired refresh points into the future and bump the version. Returns whether anything changed (idempotent) */
  function fixTaskRefreshTime(why) {
    var mod = USERDATA.modules[39];
    if (!mod || !mod.order || !mod.order.length) return false;
    var now = nowS(), report = [], changed = false;
    for (var oi = 0; oi < mod.order.length; oi++) {
      var key = mod.order[oi], data = mod.rows[key];
      if (!data || !data.length) continue;
      var fs = P.parse(data), w = P.W(), rowChanged = false;
      for (var i = 0; i < fs.length; i++) {
        var fn = fs[i][0], wt = fs[i][1], val = fs[i][2];
        if (fn === 1 && wt === 2) {                  // TaskInfo.residentTask
          var nb = fixResidentTask(val, now, report);
          if (nb) { w.s(1, nb); rowChanged = true; continue; }
        }
        P.reencode(w, fn, wt, val);
      }
      if (rowChanged) { mod.rows[key] = w.bytes(); changed = true; }
    }
    if (changed) {
      // The version must increase monotonically with the days: every reload starts fixing from the snapshot baseline (21530),
      // so if it only went +1, the version after the next day's reload would still be 21531 — the client cache also has 21531,
      // so it gets no new data while its local refresh point has expired -> spam starts again.
      // Here the increment is weighted by the number of days already crossed, guaranteeing that the version after a next-day reload is always higher than the client cache.
      var gap = 0;
      for (var g = 0; g < report.length; g++) {
        if (report[g].from > 0) {
          gap = Math.max(gap, dayIndex(now) - dayIndex(report[g].from));
        }
      }
      mod.version = (mod.version || 0) + 1 + Math.max(0, gap);
      for (var r = 0; r < report.length; r++) {
        log('[mock] DT39 刷新点修正(%s)：key=%s %s  refreshTime %s -> %s  (DT39 v%d)',
          why, report[r].key, Number(report[r].rtype) === 2 ? '每周' : '每日',
          tsText(report[r].from), tsText(report[r].to), mod.version);
      }
    }
    return changed;
  }
  fixTaskRefreshTime('启动');

  function uuid4() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function randomSeed() {
    if (global.crypto && global.crypto.getRandomValues) {
      var values = new Uint32Array(1);
      global.crypto.getRandomValues(values);
      return values[0];
    }
    return Math.floor(Math.random() * 0x100000000);
  }

  function seededRng(seed) {
    var state = Number(seed) >>> 0;
    return function () {
      state = state + 0x6D2B79F5 | 0;
      var t = state;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }


  // ---------------------------------------------------------------- Session
  function Session() {
    this.counter = 0;           // f27
    this.uid = UID;
    this.version = CLIENT_VERSION;
    this.sessionId = uuid4();
    this.loggedIn = false;
    this.tableId = 0;
    this.seat = -1;
    this.socket = null;         // The bound FakeWebSocket, used when the server pushes actively
    this._needsResync = false;
    this.lastSeq = 0;           // seq of the most recent request, reused for active pushes
    this.riichi = null;         // Riichi mahjong match session (created lazily)
    // For disconnect-reconnect recovery (see HANDLERS[20162]):
    this.table = null;          // Table snapshot { sanma, self, robots }, written when 20403 matchmaking completes
    this.walletChanges = null;  // Item increments from a one-round settlement, sent in the f24 of the next leave-table / play-again reply
    this.handFrames = [];       // 20018 notification frames sent in this match; replayed in order after reconnect to rebuild the position
    this.matchTimer = null;       // Cancellable matchmaking-completion timer
    this.engineStartTimer = null; // Timer that starts the engine after the table is formed; it must also be cancellable
    this.matchToken = 0;          // Prevents an old timer from opening a table by mistake after re-matching
  }

  /** Actively push one frame from the server (not triggered by a request, e.g. match events produced by the AI's draws/discards).
   *  Delivered asynchronously: a synchronous callback would re-enter on the client's send() call stack and disrupt Unity's message queue. */
  Session.prototype.push = function (msgId, payload, ptype, extra, seq, delivered) {
    var sock = this.socket;
    if (!sock || sock.readyState !== OPEN) return;
    var self = this;
    // The f27 downstream sequence number is assigned only at actual delivery; if it were wrapped early and sent later,
    // the dispatcher's immediate heartbeat response would overtake it, and the client would receive reversed order such as 38 then 37.
    // The f11 RPC seq still takes the argument from the push call and must not read the lastSeq of later requests.
    setTimeout(function () {
      if (self.socket !== sock || sock.readyState !== OPEN) return;
      var frame = self.wrap(msgId, payload, seq === undefined ? null : seq, ptype || 1, extra);
      var counter = self.counter;
      sock._deliver(frame);
      if (delivered) delivered(counter);
    }, 0);
  };

  /** Release attached resources when the connection closes */
  Session.prototype.destroy = function () {
    this.cancelClientSync();
    if (this._resyncTimer) { clearTimeout(this._resyncTimer); this._resyncTimer = null; }
    if (this.matchTimer) { clearTimeout(this.matchTimer); this.matchTimer = null; }
    if (this.engineStartTimer) { clearTimeout(this.engineStartTimer); this.engineStartTimer = null; }
    this.matchToken += 1;
    if (this.riichi) {
      try { this.riichi.stop(); } catch (e) { /* ignore */ }
      this.riichi = null;
    }
    this.socket = null;
  };

  /** Whether a match is in progress; disconnect auto-play, reconnect and replay all share this criterion. */
  Session.prototype.liveMatch = function () {
    return !!(this.tableId && this.riichi && !this.riichi.matchOver);
  };

  /** Only transport loss or unfinished recovery freezes the human clock. */
  Session.prototype.updateHumanPresence = function () {
    var present = this.socket && this.socket.readyState === OPEN && !this.replaying && !this._needsResync;
    if (this.riichi && this.riichi.engine) this.riichi.engine.setHumanPresent(!!present);
  };
  /** Pause the session (keep the engine for reuse after reconnect). */
  Session.prototype.suspend = function () {
    this.cancelClientSync();
    this.socket = null;
    if (this.liveMatch()) this._needsResync = true;
    this.updateHumanPresence();
  };

  /** On reconnect, attach the old session's engine to the new WS */
  Session.prototype.resume = function (socket) {
    this.cancelClientSync();
    var self = this;
    if (this.socket !== socket) this.shopReplies = new Map();
    if (this.socket !== socket && this.riichi && this.riichi.resetClientSettings) {
      this.riichi.resetClientSettings();
    }
    this.socket = socket;
    this._canReload = false; this._clientIdentified = false;
    this.replaying = false;
    this._replayStarted = false;
    if (this._resyncTimer) { clearTimeout(this._resyncTimer); this._resyncTimer = null; }
    // Timing marks for the reconnect chain: WS back -> login/userdata -> 20162 -> replay done. They show where the wait comes from.
    this._reconnectAt = nowMs();
    if (this.liveMatch()) stampLog('[mock] 重连：会话已接管，下推暂停，等待客户端 20162');
    else stampLog('[mock] 连接：会话已接管，无进行中对局');

    // After reconnecting, the client must first log in and pull user data before it sends 20162 to ask "am I still in a match?";
    // in the captures this gap is about 4 seconds. During this time the engine keeps running, and if pushes went live, the client would
    // first see "the current turn" and then the replayed "start of the match", and the table would be scrambled.
    // So on reconnect, pushes are suspended and queued, then filled in order when 20162 triggers the replay.
    if (this.liveMatch()) {
      this.replaying = true;
      this._needsResync = true;
      this.updateHumanPresence();
      // Do not charge an invisible table if the client never requests synchronization. Retry the connection instead.
      this._resyncTimer = setTimeout(function () {
        self._resyncTimer = null;
        if (!self.replaying) return;
        stampLog('[mock] 重连后 10s 未收到 20162，保持冻结并重试连接');
        if (self.socket && self.socket.readyState === OPEN) self.socket.close(1012, 'resync-timeout');
      }, 10000);
    }
    this.updateHumanPresence();
    if (this.riichi) {
      // The engine's emit must be able to push to the new WS. The riichi engine uses an emit callback, so the engine has to be rebuilt
      // Only keep the riichi reference here; Server.prototype.push then sends through the socket.
    }
  };

  /** Host-only messages are connection-scoped; they never enter the game's binary dispatcher. */
  Session.prototype.clientControl = function (control, socket) {
    if (!control || socket !== this.socket || socket.readyState !== OPEN) return false;
    if (typeof control.mjClientId === 'string' && /^[a-z0-9-]{1,128}$/.test(control.mjClientId)) {
      if (this._clientIdentified) return this._clientId === control.mjClientId;
      this._canReload = this._tableClientId === control.mjClientId;
      this._clientId = control.mjClientId; this._clientIdentified = true;
      return true;
    }
    if (Number.isSafeInteger(control.mjClockReady)) {
      var engine = this.riichi && this.riichi.engine;
      if (!engine || this.replaying || this._needsResync || engine.humanClockState()?.id !== control.mjClockReady) return false;
      var started = engine.markHumanReady(control.mjClockReady);
      this._tableClientId = this._clientId;
      return started;
    }
    return this.ackClientSync(control.mjSyncAck, socket);
  };

  /** Pack one downstream frame. extra: extra wrapper fields { fn: value } */
  Session.prototype.wrap = function (msgId, payload, seq, ptype, extra) {
    this.counter += 1;
    var w = P.W();
    w.v(1, ptype || 1);
    w.v(2, msgId);
    if (payload && payload.length) w.s(3, payload);
    if (extra && extra[6] !== undefined) w.v(6, extra[6]);
    w.v(7, this.uid);
    w.v(8, 1);
    // f11 = RPC request sequence number: only response frames echo the client's request seq (pass a number, including 0).
    // Server-initiated notifications (20408/NtfToPrepare/...) pass null and do not write f11,
    // otherwise the client would mistake them for a late response to matchmaking and ignore them, getting stuck on the matchmaking screen.
    if (seq !== null && seq !== undefined) w.v(11, seq);
    if (extra && extra[12] !== undefined) w.v(12, extra[12]);
    if (extra && extra[24] !== undefined) w.s(24, extra[24]);
    w.v(27, this.counter);
    if (msgId === 20163 && this._clientSync && !this._clientSync.counter) this._clientSync.counter = this.counter;
    if (extra && extra[29] !== undefined) w.s(29, extra[29]);
    return w.bytes();
  };

  // ---------------------------------------------------------- Common utilities
  /** Attach data-change increments to the wrapper f24 of a response frame. */
  function withChange(midRsp, changes, body) {
    if (!changes) return [[midRsp, body || new Uint8Array(0), 1, null]];
    var pkt = USERDATA.changeNotify(changes);
    for (var dt in changes) {
      if (!Object.prototype.hasOwnProperty.call(changes, dt)) continue;
      log('     [DataChange] %s(%s) v=%d %d 行',
        U.DT_NAMES[dt] || '?', dt, USERDATA.modules[dt].version, changes[dt].length);
    }
    return [[midRsp, body || new Uint8Array(0), 1, { 24: pkt }]];
  }

  // ---------------------------------------------------------- Per-message handlers
  var HANDLERS = {};

  function handleShop(sess, payload, seq, mid, perform) {
    var key = mid + ':' + seq;
    if (!(payload instanceof Uint8Array)) return [[mid + 1, P.W().v(1, 1).bytes(), 1, null]];
    var signature = payload.slice();
    if (!sess.shopReplies) sess.shopReplies = new Map();
    if (seq && sess.shopReplies.has(key)) {
      var cached = sess.shopReplies.get(key);
      return P.eq(cached.signature, signature) ? cached.response : [[mid + 1, P.W().v(1, 1).bytes(), 1, null]];
    }
    var response;
    try {
      if (!MJ.shop) throw new Error('商店模块未加载');
      var result = perform();
      var body = P.W().v(1, result.error);
      if (!result.error && result.rewards) {
        body.v(2, result.itemId).v(3, result.quantity);
        for (var reward of result.rewards) body.s(4, P.W().v(1, reward[0]).v(2, reward[1]).bytes());
      }
      response = withChange(mid + 1, result.changes, body.bytes());
    } catch (error) {
      log('  [shop] 拒绝请求: %s', error.message);
      response = [[mid + 1, P.W().v(1, 1).bytes(), 1, null]];
    }
    if (seq) {
      sess.shopReplies.set(key, { signature: signature, response: response });
      if (sess.shopReplies.size > 64) sess.shopReplies.delete(sess.shopReplies.keys().next().value);
    }
    return response;
  }

  HANDLERS[100500] = function (sess, payload, seq) {
    return handleShop(sess, payload, seq, 100500, function () {
      var fields = P.parse(payload), d = {}, seen = new Set();
      for (var field of fields) {
        if (![1, 2, 3, 4, 7].includes(field[0])) continue;
        if (field[1] !== 0 || seen.has(field[0])) throw new Error('非法购买字段');
        seen.add(field[0]); d[field[0]] = field[2];
      }
      if (fields.some(function (field) { return (field[0] === 6 || field[0] === 8) && field[2].length; })) {
        throw new Error('不支持模组或付费换装购买');
      }
      return MJ.shop.purchase(USERDATA, {
        shopType: d[1], itemId: d[2], quantity: d[3], exchangeCount: d[4], gearIndex: d[7] || 0
      });
    });
  };

  HANDLERS[100502] = function (sess, payload, seq) {
    return handleShop(sess, payload, seq, 100502, function () {
      P.parse(payload); // Empty business messages must also guarantee a valid protobuf structure.
      return MJ.shop.refreshShop(USERDATA);
    });
  };

  /** 20001 KGameServerLoginRequest -> 20002 */
  HANDLERS[20001] = function (sess) {
    USERDATA.normalizeOfflineLobby();
    sess.loggedIn = true;
    var w = P.W();
    w.s(2, P.W().v(1, sess.uid).bytes());   // user { uid }
    w.v(63, nowS());                        // server time
    w.s(65, sess.sessionId);                // session uuid
    // In-progress match flag: the official server returns f22=1 when the client is still inside an unfinished hand,
    // and the client uses this to send 20162 (Offline2OnlineRequest) to resume the match; without this bit, the client
    // concludes "the table no longer exists" and immediately sends 20102 to return to the lobby (see capture/dongfeng1 frames 10-12).
    // Only set it when this session really has an unfinished match (tableId exists), so normal login/lobby is not affected.
    if (sess.tableId) w.v(22, 1);
    return [[20002, w.bytes(), 1, null]];
  };

  /** 20019 KGameServerKeepAlive -> return the server's millisecond timestamp with the same id */
  HANDLERS[20019] = function (sess) {
    var body = P.W().v(1, nowMs()).bytes();
    return [[20019, body, 2, { 6: 2, 12: 4001, 29: sess.version }]];
  };

  /** 100141 QueryUserDataRequest -> 100142
   *
   *  Incremental protocol (consistent with the official server; see proto/user_info/user_data.proto
   *  QueryUserDataSingleTypeResponse.version):
   *    · no version given / uint64-max "all" sentinel -> return the whole module (including the server's current version)
   *    · a specific version Vc is given:
   *        - Vc >= server version -> return 0 rows in the header; version uses the server's authoritative value
   *          (not echoing the client version, otherwise the client would never learn the real version)
   *        - Vc <  server version -> return the whole module directly, so the client gets the latest data and version in one round and converges
   *
   *  The old implementation echoed the client version back and always returned 0 rows; when the IndexedDB cache disagreed with the snapshot version,
   *  the client never received the latest data, causing an endless re-query loop that could only be "reset" by dropping the WebSocket.
   *  It now converges to the server's authoritative version, so one query syncs, with no disconnect needed.
   */
  HANDLERS[100141] = function (sess, payload) {
    // Refresh daily popup guards before reporting authoritative module versions.
    USERDATA.normalizeOfflineLobby();
    // The profile version now converges to the server's authoritative value; normal burst queries must also be answered.
    // No longer reset the cache by disconnecting, otherwise the local service would wrongly hand a user still in a game over to the AI.
    var queries = [];
    try {
      var fs = P.parse(payload);
      for (var i = 0; i < fs.length; i++) {
        if (fs[i][0] !== 2 || fs[i][1] !== 2) continue;
        var q = P.dict(fs[i][2]);
        if (q[1] == null) continue;
        queries.push([q[1], q[2] == null ? -1 : q[2]]);
      }
    } catch (e) { /* Degrade to a full response when parsing fails */ }

    // Time self-healing: when DT39 is involved, first push expired refresh points into the future (idempotent). This way the response carries
    // the future refreshTime plus a higher version, so the client converges in one round; it also self-heals after idling across days.
    var touchTask = !queries.length;
    for (var qi = 0; qi < queries.length; qi++) {
      if (Number(queries[qi][0]) === 39) touchTask = true;
    }
    if (touchTask) fixTaskRefreshTime('100141');
    if (MJ.shop && (!queries.length || queries.some(function (query) { return Number(query[0]) === 30; }))) {
      MJ.shop.synchronizeShop(USERDATA);
    }

    if (!queries.length) return [[100142, USERDATA.serialize(), 1, null]];

    var w = P.W();
    for (var h = 0; h < USERDATA.headParts.length; h++) {
      P.reencode(w, USERDATA.headParts[h][0], USERDATA.headParts[h][1], USERDATA.headParts[h][2]);
    }
    var dataCount = 0, missCount = 0, details = [];
    for (var k = 0; k < queries.length; k++) {
      var dt = queries[k][0];
      // cliVer may be a BigInt (the uint64 full-sentinel), so convert it to a number uniformly to avoid comparison/encoding exceptions
      var raw = queries[k][1];
      var cliVer = (typeof raw === 'bigint') ? Number(raw) : (raw == null ? -1 : Number(raw));
      var mod = USERDATA.modules[dt];

      if (mod == null) {
        // The module does not exist in the mock snapshot (e.g. dt=3 is not in userdataB64).
        // The old implementation returned "no version header", so the client could never judge itself synced -> endless re-query loop (spam).
        // Fix: echo the client version (or 0), so the client can converge normally and stop polling.
        var hv = (cliVer > 0 && cliVer < 1e18) ? cliVer : 0;
        w.s(3, P.W().v(1, dt).v(2, hv).bytes());
        missCount++;
        details.push(dt + '(缺失)cli=' + cliVer + '->' + hv);
        continue;
      }

      var isFull = (cliVer < 0) || (cliVer >= 1e18);   // No version given / uint64-max full sentinel
      if (isFull) {
        w.s(3, mod.serialize());                        // Whole module (with the server's current version)
        dataCount++;
        details.push(dt + ':全量->v' + mod.version);
      } else if (cliVer < mod.version) {
        w.s(3, mod.serialize());                        // Client is behind -> give the whole module, one-shot sync
        dataCount++;
        details.push(dt + ':cli=' + cliVer + '<srv=' + mod.version + '->下发整模块');
      } else {
        // Already up to date / ahead: echo the client version with 0 rows (consistent with the official server, which also echoes the client version)
        w.s(3, P.W().v(1, dt).v(2, cliVer).bytes());
        details.push(dt + ':cli=' + cliVer + '=srv->0行');
      }
    }
    var mode = (queries.length && (queries[0][1] >= 1e18 || queries[0][1] < 0))
      ? '全量' : '增量';
    if (queries.length <= 4) {
      log('  [100141] %s：%s', mode, details.join('  '));
    } else {
      log('  [100141] %s：%d 个 dt 请求，%d 个带数据下发，缺失=%d',
        mode, queries.length, dataCount, missCount);
    }
    return [[100142, w.bytes(), 1, null]];
  };

  /** 100903 KtaskClientEventRequest -> 100904 */
  HANDLERS[100903] = function (sess, payload) {
    var d = P.dict(payload);
    var evtType = d[1] || 0;
    var changes = USERDATA.bumpModule(39);   // DT39 Task version+1
    log('     [task] clientEvent type=' + evtType + ' -> DT39 ver bump');
    return withChange(100904, changes);
  };

  function payloadText(bytes) {
    var fields;
    try { fields = P.parse(bytes); } catch (e) { return ''; }
    for (var i = 0; i < fields.length; i++) {
      if (fields[i][1] !== 2 || !(fields[i][2] instanceof Uint8Array)) continue;
      var value = P.fromUtf8(fields[i][2]);
      if (value && !/[\u0000-\u001f\u007f]/.test(value)) return value;
      value = payloadText(fields[i][2]);
      if (value) return value;
    }
    return '';
  }

  function validNickname(value) {
    var nickname = String(value || '').trim();
    return nickname && !/[\u0000-\u001f\u007f]/.test(nickname) ? nickname : null;
  }

  /** Nickname pre-validation: the client's length/character rules take precedence; the local service also rejects blank and control characters as a fallback. */
  HANDLERS[100151] = function (sess, payload) {
    var nickname = validNickname(payloadText(payload));
    return [[100152, P.W().v(1, nickname ? 0 : 2).bytes(), 1, null]];
  };

  // Rename card from the general store; the original client does not send a rename request without a rename card.
  var RENAME_CARD_ID = 60007;

  /** Change basic profile fields. Request ModifySingleBasicFieldRequest { 1:field type, 2:UserBasicField },
   *  type 1/5 = nickname, 2 = greeting. The client callback (the lambda of DataMgr_BasicInfo.ModifyBaseInfoRequest)
   *  requires a reply { 1:result code, 2:original request } and dispatches UI events by the f2.f1 type; without f2 the rename window
   *  does not close and the nickname does not refresh. A rename consumes 1 rename card; the data updates DT1/DT6 through f24. */
  HANDLERS[100007] = function (sess, payload) {
    var type = 0;
    try { type = P.dict(payload)[1] || 0; } catch (e) { type = 0; }
    if (type !== 1 && type !== 5) return offlineUnavailable(sess, 100008);
    var nickname = validNickname(payloadText(payload));
    if (!nickname) return [[100008, P.W().v(1, 2).s(2, payload).bytes(), 1, null]];
    var changes = [USERDATA.updateNickname(nickname)];
    if (USERDATA.inventoryCount(6, RENAME_CARD_ID) > 0) {
      changes.push(USERDATA.changeInventory([{ dtype: 6, id: RENAME_CARD_ID, count: -1 }]));
    }
    if (sess.localProfile) sess.localProfile.nickname = nickname;
    if (typeof sess.onNicknameChange === 'function') sess.onNicknameChange(nickname);
    return withChange(100008, mergeChanges(null, changes), P.W().v(1, 0).s(2, payload).bytes());
  };

  /** 100003 KClientLobbyModifyGameSettingRequest -> 100004 */
  HANDLERS[100003] = function (sess, payload) {
    var d = P.dict(payload);
    var gs = (d[2] instanceof Uint8Array) ? d[2] : null;
    var changes = gs ? USERDATA.updateGameSetting(gs) : null;
    log('     [setting] ModifyGameSetting -> DT2 %s',
      changes ? 'OK v' + USERDATA.modules[2].version : '（无 GameSetting 字段）');
    return withChange(100004, changes);
  };

  /** 100204 WearMahjongWarriorSculptRequest { 1:SculptId, 2:WarriorId } -> 100205
   *  The Response itself is an empty message; what actually makes the client accept it is the f24 increment in the wrapper. */
  HANDLERS[100204] = function (sess, payload) {
    var d = P.dict(payload);
    var sculptId = d[1] || 0, warriorId = d[2] || 0;
    var changes = USERDATA.wearSculpt(warriorId, sculptId);
    log('     雀士 %s 换皮肤 -> %s %s', warriorId, sculptId,
      changes ? 'OK' : '（找不到该雀士）');
    return withChange(100205, changes);
  };

  /** 100011 SelectEquipmentInUseRequest { 1: repeated Entry{1:DataType,2:Value} } -> 100012
   *  Changing avatar / in-match warrior / skin / scene (background + interior) all go through this.
   *
   *  The real response shape, confirmed against the official packet capture (capture/live4):
   *    body = SelectEquipmentInUseResponse { 2: <request payload echoed verbatim> }
   *    f24  = DataChangeNotify { 1: UserDataChange{ DT1 full row, ct=MODIFY, ver+N } }
   *  Previously the body was empty and f24 lacked one layer of f1, so the client could not accept it and the UI could not switch. */
  HANDLERS[100011] = function (sess, payload) {
    var pairs = [];
    var fs = P.parse(payload);
    for (var i = 0; i < fs.length; i++) {
      if (fs[i][0] !== 1 || fs[i][1] !== 2) continue;
      var inner = P.parse(fs[i][2]);
      var dt = null, val = 0;
      for (var k = 0; k < inner.length; k++) {
        if (inner[k][0] === 1) dt = inner[k][2];
        else if (inner[k][0] === 2) val = inner[k][2];
      }
      if (dt !== null) pairs.push([dt, val]);
    }
    log('     使用中装备 -> %s', pairs.map(function (p) {
      return (U.DT_NAMES[p[0]] || '?') + '(' + p[0] + ')=' + p[1];
    }).join(', '));

    var changes = USERDATA.selectEquipment(pairs);
    // Echo: put the request payload into f2 unchanged (byte-identical to the official server)
    var body = payload && payload.length
      ? P.W().s(2, payload).bytes()
      : new Uint8Array(0);
    return withChange(100012, changes, body);
  };

  /** 20007 GetTableList -> 20008 empty table list (offline there are no real rooms) */
  HANDLERS[20007] = function () {
    return [[20008, P.W().v(1, 0).bytes(), 1, null]];
  };

  /** 20009 EnterTable -> 20010 + 20011 broadcast */
  HANDLERS[20009] = function (sess) {
    sess.tableId = 100001;
    var body = P.W().v(1, 0).v(2, sess.tableId).bytes();
    var bc = P.W().v(1, sess.tableId).v(2, sess.uid).bytes();
    return [[20010, body, 1, null], [20011, bc, 1, null]];
  };

  /** 20012 EnterSeat -> 20013 + 20014 broadcast */
  HANDLERS[20012] = function (sess) {
    sess.seat = 0;
    var body = P.W().v(1, 0).v(2, sess.seat).bytes();
    var bc = P.W().v(1, sess.tableId).v(2, sess.uid).v(3, sess.seat).bytes();
    return [[20013, body, 1, null], [20014, bc, 1, null]];
  };

  /** 21401 -> 21402: directly replay the recorded response */
  HANDLERS[21401] = function () {
    return [[21402, REPLAY[21402] || new Uint8Array(0), 1, null]];
  };

  /** 100620 KclientSignInReq -> 100621 */
  HANDLERS[100620] = function (sess, payload) {
    var changes = USERDATA.dailySignIn();
    log('     跨日签到 -> SignIn 时间戳刷新%s', changes ? ' OK' : '（无 SignIn 模块）');
    return withChange(100621, changes);
  };

  // ------------------------------------------- Online-only peripheral features (unavailable offline)
  // The original client does not automatically turn business error codes into prompt text; the peripheral request explicitly fails
  // (LobbyStatusCode 10 CommandServiceNotAvailable), then the native 20106
  // DisplayDebugLogNotify{1:Log} triggers the client's built-in ShowTips toast.
  var OFFLINE_UNAVAILABLE_TEXT = '离线模式下此功能不可用';
  var OFFLINE_UNAVAILABLE_IDS = [
    // Friends, viewing others' profiles
    100040, 100042, 100046, 100047, 100048, 100143,
    // Warrior affinity growth, profiles, gacha
    100206, 100208, 100210, 100300,
    // Top-up, VIP, Steam payments
    100400, 100403, 100405, 100407, 100409, 100420, 100422, 100424,
    // Rankings, events, mail, announcements, newbie check-in
    100505, 100508, 100510, 100512, 100514,
    100602, 100604, 100606, 100608, 100701, 102100, 102102,
    // Friendly rooms
    20500, 20502, 20504, 20506, 20508, 20510, 20512, 20514, 20516, 20518,
    20520, 20522, 20524, 20526, 20528,
    // Custom tournaments
    21001, 21003, 21005, 21007, 21009, 21011, 21101, 21103, 21105, 21107,
    21109, 21111, 21113, 21115, 21117, 21119, 21121, 21123, 21125, 21127,
    21129, 21131, 21133, 21135, 21137, 21139, 21141, 21143, 21145, 21147,
    21150, 21152, 21154,
    // Reward tournament sign-up and start; the 21401 tournament list still replays recorded data, and the client requests it automatically when entering the lobby
    21403, 21405, 21414, 21417
  ];
  function offlineUnavailable(sess, responseMid) {
    sess.push(20106, P.W().s(1, OFFLINE_UNAVAILABLE_TEXT).bytes(), 1, null);
    return [[responseMid, P.W().v(1, 10).bytes(), 1, null]];
  }
  OFFLINE_UNAVAILABLE_IDS.forEach(function (mid) {
    HANDLERS[mid] = function (sess) { return offlineUnavailable(sess, mid + 1); };
  });
  // Reward-tournament group rankings, match records and schedules: the client has a native prompt for 30 CommonNotRoomInfo
  // "The match info is no longer valid" (WeeklyCompetitionMgr.DoWeeklyCompetitionErrCode).
  [21407, 21409, 21411].forEach(function (mid) {
    HANDLERS[mid] = function () {
      return [[mid + 1, P.W().v(1, 30).bytes(), 1, null]];
    };
  });

  // ------------------------------------------- Riichi match channel (20018)
  // The payload of 20018 (kGameServerLogicData) is KRiichiMsg (riichi.proto):
  //   f1   = msgType (RiichiMsg enum)
  //   f3   = server millisecond timestamp
  //   f100 = payload (serialized bytes of the concrete Req*/Rsp*/Ntf* message)
  // This only unwraps the envelope → passes it to the in-browser match engine (mock/riichi.js) → re-wraps the engine's pushed
  // events as KRiichiMsg and sends them via 20018. The full match logic (dealing / draw-discard / melds / riichi / win /
  // draw / renchan / points) and the AI all run in the browser; no local service is required.
  var RIICHI_NAMES = {
    1: 'ReqPrepare', 2: 'RspPrepare', 3: 'ReqPlayCard', 4: 'RspPlayCard',
    5: 'ReqQiangCard', 6: 'RspQiangCard', 7: 'ReqSetInternalState', 8: 'RspSetInternalState',
    9: 'ReqCloseOfflineTip', 10: 'RspCloseOfflineTip', 11: 'ReqClickUI', 12: 'RspClickUI',
    1001: 'NtfToPrepare', 1002: 'NtfPrepare', 1003: 'NtfGameStart', 1004: 'NtfSendCard',
    1005: 'NtfPlayCard', 1006: 'NtfQiangCard', 1007: 'NtfQiangCardEnd', 1008: 'NtfGameStop',
    1009: 'NtfOfflineToolTip'
  };

  function riichiName(mt) { return RIICHI_NAMES[mt] || String(mt); }

  var RIICHI_NTF_TO_PREPARE = 1001;   // First frame of each hand; the disconnect replay cache is split at it
  var RIICHI_NTF_GAME_START = 1003;   // Deal-start frame, used to tell whether this hand has started

  /** Pack the KRiichiMsg envelope (field order consistent with the official server: 1, 3, 100) */
  function encodeKRiichi(msgType, inner) {
    return P.W().v(1, msgType).v(3, nowMs())
      .s(100, inner || new Uint8Array(0)).bytes();
  }

  /** Lazily create this connection's match session */
  function getRiichi(sess) {
    if (sess.riichi) return sess.riichi;
    var R = MJ.riichi;
    if (!R || !R.RiichiSession) {
      console.error('[mock] 未加载 mock/riichi.js，20018 对局通道不可用');
      return null;
    }
    // Seat → uid; must exactly match the uids sent in 20408 TableInfo / 20014 EnterSeatBc:
    // the client finds itself in the NtfToPrepare roster by userID; a mismatch discards the whole match.
    var robots = sess.table && sess.table.robots ? sess.table.robots : [];
    // A restored match carries its own settings; the URL/global config only applies to newly matched tables.
    var players = sess.table ? (sess.table.sanma ? 3 : 4) : CONFIG.players;
    var uids = [sess.uid];
    var styles = [null];
    for (var i = 0; i + 1 < players; i++) {
      var r = robots[i];
      var def = r && MJ.npc ? MJ.npc.npcById(r.npc) : null;
      uids.push(r ? r.uid : 10000 + i);
      styles.push(def ? def.style : null);
    }

    var restore = sess.restore || null;
    sess.restore = null;
    sess.riichi = new R.RiichiSession({
      players: players,
      // Three-player starting score 35000 (in the capture, score/initScore in NtfGameStart are 35000)
      startScore: players === 3 ? 35000 : 25000,
      // A one-round match plays a single hand; other rules are the same as the ranked match
      maxHands: sess.table && sess.table.oneRound ? 1 : undefined,
      matchLength: sess.table ? sess.table.matchLength : CONFIG.matchLength,
      replayLog: restore ? restore.log : null,
      humanPresent: restore ? restore.present : !!(sess.socket && sess.socket.readyState === OPEN && !sess._needsResync),
      deferHumanClock: true,
      onHumanClock: function (clock) {
        if (typeof sess.onHumanClock === 'function') sess.onHumanClock(clock);
      },
      // The table snapshot plus the human-decision log is enough to rebuild this match after a reload or restart.
      onRecord: function (log) {
        if (typeof sess.onMatchRecord === 'function' && sess.table) sess.onMatchRecord({ v: 1, table: sess.table, log: log });
      },
      akaCount: CONFIG.akaCount,
      speed: CONFIG.speed,
      seed: sess.table && sess.table.seed != null ? sess.table.seed : CONFIG.seed,
      uids: uids,
      autoHuman: CONFIG.autoHuman,
      // Ranked rooms: Qihang/Zhumeng basic, Chengfeng intermediate, Yulong advanced.
      aiLevel: sess.rankRoomId === 4 ? 'advanced' : sess.rankRoomId === 1 || sess.rankRoomId === 2 ? 'basic' : 'intermediate',
      aiStyles: styles,
      selfLoveLevel: sess.table && sess.table.self ? sess.table.self.loveLevel || 0 : 0,
      internalState: sess.internalState || {},
      // Keep live outcomes; only explicit debug enables protocol/window/AI details.
      debug: LOG.enabled,
      log: stampLog,
      onSettingsChange: function (state) {
        sess.internalState = state;
        if (typeof sess.onSettingsChange === 'function') sess.onSettingsChange(state);
      },
      onFinalResult: function (scores, engine, humanWin) {
        var oneRound = sess.table && sess.table.oneRound;
        if (oneRound) return settleOneRound(sess, oneRound, humanWin);
        if (typeof sess.onFinalResult === 'function') {
          var result = sess.onFinalResult(scores, engine);
          // Local rank / record / coin data changes are sent in the f24 of the leave-table or play-again reply.
          if (result && result.changes) sess.walletChanges = mergeChanges(sess.walletChanges, result.changes);
          return result;
        }
        return null;
      },
      onFinish: function (scores, engine) {
        clearMatchRecord(sess);
        if (typeof sess.onMatchFinish === 'function') sess.onMatchFinish(scores, engine);
      },
      // Single `log` key on purpose: RiichiSession hands this same callback to the engine (browser_entry sets
      // `eng.log = this.log`), so a second key here silently replaced the engine's logger and every hand/claim line
      // vanished from the log file.
      onFrame: function (ev, bytes) {
        log('  => 20018 %s %dB', riichiName(ev), bytes.length);
        // Rsp* (even msgType and <1000) are responses to the client's Req*; they must echo the request seq;
        // Ntf* (>=1000) are active notifications and carry no seq.
        var isRsp = (ev < 1000 && ev % 2 === 0);
        // Disconnect-reconnect recovery: cache this hand's notification frames. NtfToPrepare(1001) is the first frame of each hand,
        // and reaching it turns the page. Rsp* are answers to uplink requests; replaying them is meaningless, so they are not cached.
        // Note: this is independent of sess.push. During a disconnect, push loses frames because the socket is closed,
        // but the cache still records them, so after reconnect the AI's draw/discard progress during the disconnect can be filled in for the client.
        if (ev >= 1000) {
          if (ev === RIICHI_NTF_TO_PREPARE) sess.handFrames = [];
          sess.handFrames.push([ev, bytes]);
          // Replay in progress: new frames are only enqueued, and replayHand catches up with them in index order,
          // so historical frames and new frames do not interleave and scramble the client's match.
          if (sess.replaying) return;
        }
        sess.push(20018, encodeKRiichi(ev, bytes), 1, null, isRsp ? (sess._reqSeq || 0) : null);
      }
    });
    return sess.riichi;
  }

  /** 20162 KGameServerOffline2OnlineRequest -> 20163
   *  When the client's login response (20002) carries f22=1 (in-progress match flag), it sends this after connecting,
   *  asking "am I still in a hand that isn't finished?". The mock's 20002 must include f22=1 to trigger this branch
   *  (see HANDLERS[20001]); without it, the client concludes the table no longer exists and sends 20102 to return to the lobby.
   *
   *  What is fixed here is "after reconnect, misjudged as no match", not every cause of Bye! disconnects.
   *  BestHTTP WebSocket.Close() with no arguments defaults to reason "Bye!", so this cannot identify the sole close call site.
   *  BH_NetworkManager.ForceCloseWhenTimeout is a possible path;
   *  Heartbeats, notification delivery order and client-side handling timing must also be checked; do not assume the server is fault-free.
   *
   *  What can be fixed is "after reconnect": the official server returns f4=TableInfo here, so the client knows it is still in the match
   *  and keeps waiting for the server to sync the match; but here it used to unconditionally reply "no match", so the client concluded the match
   *  no longer existed, then sent 20102 FinishGameStop to return to the lobby. That is what the user saw as
   *  "Bye! → reconnect → exit the match directly".
   *
   *  Note: f3 is always -1; in the captures it is also -1 while a match is in progress, so the criterion is whether f4 is present, not f3. */
  HANDLERS[20162] = function (sess, payload, seq) {
    // A match restored from a saved record is still replaying: answer once the engine has caught up.
    if (sess.restoring) {
      var restoring = sess.restoring;
      restoring.then(function () {
        if (sess.restoring === restoring) sess.restoring = null;
        var out = HANDLERS[20162](sess, payload, seq);
        sess.push(out[0][0], out[0][1], out[0][2], out[0][3], seq);
      });
      return [];
    }
    var live = !!(sess.table && sess.liveMatch());
    if (live) { sess._needsResync = true; sess.updateHumanPresence(); }
    stampLog('  [resync] 收到 20162，距 WS 恢复 ' + (sess._reconnectAt == null ? -1 : nowMs() - sess._reconnectAt) +
      'ms，进行中=' + (live ? 1 : 0));

    var w = P.W();
    w.v(1, sess.uid);
    w.tag(3, 0);
    w.raw([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    // Match in progress: include the full table
    if (live) w.s(4, encTableInfo(sess, true));
    w.v(5, 3);                                    // roomID (original value from the mahjong capture)

    // Riichi: when a snapshot can be safely restored at the current cut point, put the position snapshot in f100 per the original protocol so the client takes the Reload path,
    // and then only the new frames after the cut point are sent; cut points such as the prepare phase, 0 tiles left, or the robbing-kan window still use a full-hand replay.
    var cut = -1;
    if (live && sess._canReload && !sess._replayStarted && sess.riichi && sess.riichi.reloadScene) {
      var scene = sess.riichi.reloadScene(sess.handFrames);
      if (scene) {
        w.s(100, scene);
        cut = sess.handFrames.length;
      }
    }

    if (live && !sess._replayStarted) {
      sess._replayStarted = true;
      var pendingSync = sess.beginClientSync(cut >= 0);
      pendingSync.waitingTable = !sess._canReload;
      stampLog('  [resync] 有进行中对局，回 TableInfo，' + (cut >= 0
        ? '附局面快照，只补发其后的新帧' : '准备重放本局 ' + sess.handFrames.length + ' 帧'));
      // After 20163 the official server actively pushes NtfPrepare/NtfGameStart to resync the match.
      // We have no "arbitrary position snapshot", so we use an equivalent: replay all notification frames of this hand from NtfToPrepare onward in order,
      // and the client walks through them to reach the current position itself.
      // Frames produced by AI draws/discards during the disconnect are also in the cache (onFrame bookkeeping and push are independent), and are filled in too.
      //
      // Live pushes must be suspended [immediately] here: they cannot wait until replayHand actually starts. During this interval,
      // while the client switches back to the table, the engine keeps drawing and discarding, and those new frames would go out before the replay,
      // so the client would see "the current turn" before "the start of the match", and the match would be scrambled.
      sess.replaying = true;
      if (sess._resyncTimer) { clearTimeout(sess._resyncTimer); sess._resyncTimer = null; }
      var cutFrames = sess.handFrames, syncSocket = sess.socket;
      setTimeout(function () {
        if (sess.socket !== syncSocket || sess._clientSync !== pendingSync) return;
        if (pendingSync.waitingTable) {
          // A new Unity page is still in the lobby. Reuse the real table-entry handshake;
          // never send GameStart/history until its own ReqPrepare proves the table loaded.
          sess.push(20408, P.W().s(2, encTableInfo(sess, false)).bytes(), 1, null);
          for (var seat = 0; seat < sess.table.robots.length; seat++) {
            var robot = sess.table.robots[seat];
            sess.push(20164, P.W().v(1, robot.uid).bytes(), 1, null);
            sess.push(20014, P.W().s(1, encTableUser(seat + 1, robot, true)).v(2, sess.table.roomType || 7).bytes(), 1, null);
          }
          var prepareFrame = sess.handFrames.find(function (frame) { return frame[0] === RIICHI_NTF_TO_PREPARE; });
          if (prepareFrame) sess.push(20018, encodeKRiichi(prepareFrame[0], prepareFrame[1]), 1, null);
          stampLog('[resync] 新页面等待牌桌准备，再重放本局');
        } else replayHand(sess, sess.handFrames === cutFrames ? cut : 0);
      }, 150);
    } else if (!live) {
      stampLog('  [resync] 无进行中对局');
    }
    return [[20163, w.bytes(), 1, null]];
  };

  Session.prototype.cancelClientSync = function () {
    if (this._clientSync) clearTimeout(this._clientSync.timer);
    this._clientSync = null;
  };
  Session.prototype.beginClientSync = function (reload) {
    this.cancelClientSync();
    var self = this, socket = this.socket;
    var sync = this._clientSync = { id: uuid4(), socket: socket, counter: 0, pending: 0, end: false };
    if (socket && socket._sync) socket._sync({ phase: 'start', id: sync.id, reload: !!reload });
    sync.timer = setTimeout(function () {
      if (self._clientSync !== sync || self.socket !== socket) return;
      stampLog('[resync] 客户端未确认恢复完成，保持冻结并重试 id=' + sync.id);
      if (socket.close) socket.close(1012, 'client recovery confirmation timeout');
    }, 30000);
    stampLog('[resync] 等待客户端消费确认 id=' + sync.id + ' snapshot=' + !!reload);
    return sync;
  };
  Session.prototype.ackClientSync = function (ack, socket) {
    var sync = this._clientSync;
    if (!sync || sync.socket !== socket || this.socket !== socket || socket.readyState !== OPEN ||
        !sync.end || !ack || ack.id !== sync.id || ack.counter !== sync.counter) return false;
    if (sync.frames !== this.handFrames || sync.index !== this.handFrames.length) {
      var from = sync.frames === this.handFrames ? sync.index : 0;
      this.beginClientSync(false);
      replayHand(this, from);
      return false;
    }
    this.cancelClientSync();
    this._tableClientId = this._clientId;
    this.replaying = false; this._replayStarted = false;
    playerBack(this);
    if (socket._sync) socket._sync({ phase: 'complete', id: sync.id });
    stampLog('[resync] 客户端消费完成 id=' + sync.id + ' counter=' + sync.counter);
    return true;
  };

  /** Disconnect-reconnect: resend this hand's cached 20018 notification frames in order so the client rebuilds the position.
   *
   *  During the replay, onFrame only does bookkeeping and no live push (sess.replaying); new frames are queued at the tail,
   *  otherwise "historical frames being replayed" and "new frames just produced by the engine" would interleave and scramble the client's match.
   *  Here we walk the live array sess.handFrames by index; the engine appends as it runs, and we are done once caught up. */
  /** The client shows the table again: a turn frozen while the player was away gets its clock back now, not on reconnect,
   *  because login and the resync take a few seconds. */
  function playerBack(sess) {
    if (!sess.socket || sess.socket.readyState !== OPEN || sess.replaying) return;
    sess._needsResync = false;
    sess.updateHumanPresence();
    stampLog("[resync] 同步门禁解除：" + JSON.stringify({ present: !!sess.riichi?.engine?.humanPresent }));
  }

  function replayHand(sess, from) {
    var syncSocket = sess.socket;
    var frames = sess.handFrames || [];
    var sync = sess._clientSync;
    if (!sync || sync.socket !== syncSocket || !syncSocket || syncSocket.readyState !== OPEN) return;
    function finishDelivery() {
      if (sess._clientSync !== sync || sess.socket !== syncSocket || !sync.caught || sync.pending) return;
      sync.end = true;
      stampLog('[resync] 重放已投递，等待客户端完成 id=' + sync.id + ' counter=' + sync.counter);
      if (syncSocket._sync) syncSocket._sync({ phase: 'end', id: sync.id, counter: sync.counter });
    }

    // Whether this hand has been dealt. If dealt, skip NtfToPrepare: the client would reply
    // with ReqPrepare, presetting the engine's _prepared to true, so the next hand would deal without waiting for the client.
    // If still in the prepare phase (no NtfGameStart), replay it as-is so the client sends ReqPrepare again.
    var skipToPrepare = false;
    for (var k = 0; k < frames.length; k++) {
      if (frames[k][0] === RIICHI_NTF_GAME_START) { skipToPrepare = true; break; }
    }

    stampLog('  [resync] 开始重放（已开牌=' + skipToPrepare + ' 起点=' + from + '/' + frames.length + ' 帧）');
    var replayStart = nowMs();
    // Batch push: send BATCH frames per batch with BATCH_GAP ms between batches. The client queues consumption in the main-thread Update,
    // handling only a few frames per tick so it does not time out again (Bye!); batching also cuts the whole hand's replay time
    // from "8 ms per frame" to close to the real server (the real server sends the position snapshot f100 in 20163, almost instantly).
    var BATCH = 6, BATCH_GAP = 6;
    // If a 20163.f100 snapshot was already sent, catch up from the snapshot cut point; if the hand has changed in the meantime (cache reset by NtfToPrepare), catch up from the start.
    var i = from > 0 && from <= frames.length ? from : 0;
    (function next() {
      if (sess.socket !== syncSocket || sess._clientSync !== sync || syncSocket.readyState !== OPEN) return;
      var sent = 0;
      while (i < sess.handFrames.length && sent < BATCH) {
        var f = sess.handFrames[i];
        i++;
        if (!(skipToPrepare && f[0] === RIICHI_NTF_TO_PREPARE)) {
          sync.pending++;
          sess.push(20018, encodeKRiichi(f[0], f[1]), 1, null, null, function (counter) {
            if (sess._clientSync !== sync) return;
            sync.counter = counter; sync.pending--;
            finishDelivery();
          });
        }
        sent++;
      }
      if (i >= sess.handFrames.length) {
        sync.index = i; sync.frames = sess.handFrames; sync.caught = true;
        stampLog('  [resync] 重放已排队，历史进度 ' + i + '/' + sess.handFrames.length + ' 帧，耗时 ' + (nowMs() - replayStart) + 'ms，计时仍冻结');
        finishDelivery();
        return;
      }
      setTimeout(next, BATCH_GAP);
    })();
  }

  // ------------------------------------------- Ranked matchmaking → start of match (20403)
  // The real start-of-match sequence from the capture (capture/dongfeng1/ws.jsonl lines 616-631):
  //   C->S 20403 RankingMatchRequest{ srm{ gameType, roomType, roomID, matchSource } }
  //   S->C 20404 RankingMatchResponse{}                    ← empty packet, just an ack
  //   ...about 1.5-2.4s matchmaking wait...
  //   S->C 20408 RankingMatchResultNotify{ tableInfo }      ← room formed, containing only self
  //   S->C 20164 UserOfflineNotify{ userID }  ┐ one per opponent,
  //   S->C 20014 EnterSeatBC{ tableUserInfo } ┘ meaning "this player is offline-managed and seated"
  //   S->C 20018 NtfToPrepare → the client replies ReqPrepare, and the match begins
  // Key point: the client must first receive 20408 + 20014 to build the table before it switches to the match scene.
  // Without these two steps, the subsequent 20018 frames are dropped outright (the client is still in the lobby scene).

  var GAME_TYPE = { SANMA: 4002, YONMA: 4001 };
  // Only riichi mahjong matchmaking requests are handled; other game types (Sichuan 50xx / Dou Dizhu 4101 / Guandan 4111 etc.) show "offline unavailable"
  var RIICHI_GAME_TYPES = { 4001: true, 4002: true };

  // Offline opponents are the 19 NPCs in mockjs/npc_roster.mjs (fixed character/skin and play style each), exposed as MJ.npc.

  /** Read the local player's currently selected equipment from USERDATA and assemble a SimpleInGameSummaryInfo.
   *  Read dynamically at each match, so that a change of character/skin in the lobby takes effect in the next match. */
  function getSelfProfile(sess, sanma) {
    var localRank = sess && sess.localProfile ? sess.localProfile.ranks[sanma ? 'sanma' : 'yonma'] : null;
    var profile = {
      uid: UID, nick: sess && sess.localProfile ? sess.localProfile.nickname : 'player', head: 1009, frame: 2001, title: 3001,
      bang: 140009, warrior: 1, skin: 1001, level: localRank ? localRank.level : 1, likability: 6, pt: localRank ? localRank.point : 0
    };
    try {
      var row = USERDATA.row(1, '0');         // DT_BASIC_INFO
      if (row) {
        var basic = P.get(row, 1);
        var nickname = basic && P.get(basic, 1);
        if (nickname instanceof Uint8Array && nickname.length) profile.nick = P.fromUtf8(nickname);
        var equip = P.get(row, 2);             // UserBasicEquipment map
        if (equip && equip.length) {
          var fs = P.parse(equip);
          var map = {};
          for (var i = 0; i < fs.length; i++) {
            if (fs[i][0] !== 1 || fs[i][1] !== 2) continue;
            var e = P.dict(fs[i][2]);
            map[e[1]] = e[2] || 0;
          }
          if (map[11]) profile.head = map[11];        // DT_HEAD
          if (map[12]) profile.frame = map[12];       // DT_HEAD_FRAME
          if (map[13]) profile.title = map[13];       // DT_TITLE
          if (map[14]) profile.bang = map[14];        // DT_LIZHI
          if (map[26]) profile.warrior = map[26];     // DT_MAHJONG_WARRIOR
        }
      }
      // Read the current skin from the warrior data row (sculptId)
      var wRow = USERDATA.row(26, profile.warrior);
      if (wRow) {
        var inner = P.get(wRow, 3);                   // MahjongWarriorData
        if (inner) {
          var sculptId = P.get(inner, 3);             // SculptId
          if (sculptId) profile.skin = sculptId;
          profile.loveLevel = P.get(inner, 5) || 0;   // Affinity level (shown on the settlement panel)
        }
      }
    } catch (e) {
      log('  [profile] 读取用户装备失败，使用默认值: ' + e.message);
    }
    return profile;
  }

  /** SimpleInGameSummaryInfo */
  function encProfile(p) {
    var w = P.W();
    w.v(1, p.uid);
    w.s(2, p.nick);
    w.v(3, p.head);
    w.v(4, p.frame);
    w.v(5, p.title);
    w.v(6, p.bang);
    w.v(7, p.warrior);
    w.v(8, p.skin);
    if (p.level) w.v(9, p.level);
    if (p.likability) w.v(10, p.likability);
    if (p.pt) w.v(13, p.pt);
    return w.bytes();
  }

  /** TableUserInfo */
  function encTableUser(seat, p, isRobot) {
    var w = P.W();
    if (seat) w.v(1, seat);                 // seat 0 uses the proto default values, consistent with the capture
    w.s(2, encProfile(p));
    w.v(3, p.uid);
    if (isRobot) w.v(7, 1);
    return w.bytes();
  }


  /** Random 20-character match ID, in the form d9s4grlhjab6eqidh2jg */
  function randGameId(rng) {
    var cs = 'abcdefghijklmnopqrstuvwxyz0123456789', s = '';
    for (var i = 0; i < 20; i++) s += cs.charAt(Math.floor(rng() * cs.length));
    return s;
  }

  /** TableInfo: all data is taken from sess.table (the table snapshot written when 20403 matchmaking forms).
   *  The local player's profile is read dynamically from USERDATA, so a change of character/skin in the lobby takes effect in the next match.
   *
   *  withRobots=false (20403 matchmaking): only the local player; opponents are then seated one by one by 20014.
   *  withRobots=true (20163 disconnect recovery): all seats at once. On reconnect the client does not go
   *  through the seating flow again; the real server's 20163.f4 in the capture carries all four TableUserInfo. */
  function encTableInfo(sess, withRobots) {
    var t = sess.table;
    var w = P.W()
      .v(1, t.sanma ? GAME_TYPE.SANMA : GAME_TYPE.YONMA)
      .v(2, sess.tableId || 1)
      .v(3, t.sanma ? 3 : 4)
      .s(4, encTableUser(0, t.self, false));
    if (withRobots) {
      for (var i = 0; i < t.robots.length; i++) {
        w.s(4, encTableUser(i + 1, t.robots[i], true));
      }
    }
    return w
      // common_define.TableInfo: 5 subType (East 0 / hanchan 1 / one-round 3), 6 roomType (echoed from the request), 8 roomID.
      .v(5, t.oneRound ? 3 : t.matchLength === 'hanchan' ? 1 : 0)
      .v(6, t.roomType || 7)
      .v(8, t.roomId || 1)
      .s(9, t.logId)
      .s(10, t.gameId)
      // Older clients also read the same identifiers from these two fields.
      .s(11, t.logId)
      .s(12, t.gameId)
      .bytes();
  }

  /** 20403 KgameServerRankingMatchRequest -> 20404; then forms the table asynchronously and starts the match */
  HANDLERS[20403] = function (sess, payload) {
    var srm = {};
    try {
      var d = P.dict(payload);
      if (d[1] instanceof Uint8Array) srm = P.dict(d[1]);
    } catch (e) { /* Use default values */ }
    if (d && d[1] instanceof Uint8Array) {
      log('  [match] request=%s', Array.prototype.map.call(d[1], function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join(''));
    }

    // This project only supports single-player riichi: Sichuan, Dou Dizhu, Guandan and other games show "offline unavailable"
    if (!RIICHI_GAME_TYPES[srm[1]]) {
      log('  [match] gameType=%s 非立直，离线不可用', srm[1]);
      return offlineUnavailable(sess, 20404);
    }

    // The gameType in the request decides 3- vs 4-player; the URL parameter ?mjPlayers takes priority
    var sanma = srm[1] === GAME_TYPE.SANMA;
    if (CONFIG.playersExplicit) sanma = CONFIG.players === 3;
    else CONFIG.players = sanma ? 3 : 4;
    if (!CONFIG.matchLengthExplicit) CONFIG.matchLength = Number(srm[2] || 0) === 1 ? 'hanchan' : 'east';
    var oneRound = null;
    if (Number(srm[3]) === MJ.oneRound.ONE_ROUND_ROOM_TYPE) {
      var orRoom = MJ.oneRound.oneRoundRoom(Number(srm[4] || 0), Number(srm[5] || 0));
      if (!orRoom || !MJ.oneRound.canAffordOneRound(USERDATA, orRoom)) {
        log('  [match] 一局战 roomID=%s roomLevel=%s 拒绝：配置不存在或报名费不足', srm[4], srm[5]);
        return [[20404, P.W().v(1, 1).bytes(), 1, null]];
      }
      oneRound = { id: orRoom.id, cost: orRoom.cost, rewards: orRoom.rewards };
    }
    sess.rankRoomId = !oneRound && [1, 2, 3, 4].includes(Number(srm[4])) ? Number(srm[4]) : null;

    log('  [match] gameType=%s roomType=%s roomID=%s -> %s麻%s',
      srm[1], srm[3], srm[4], sanma ? '三' : '四',
      oneRound ? '一局战(' + oneRound.id + ')' : CONFIG.matchLength === 'hanchan' ? '半庄' : '东风');

    sess.tableId = 1;
    sess.seat = 0;
    clearMatchRecord(sess);

    // On re-matching (re-clicking after cancel, or a leftover from the previous hand), the old session must be dropped,
    // otherwise ensureEngine would get the previous hand's engine and would not push NtfToPrepare again.
    if (sess.riichi) {
      try { sess.riichi.stop(); } catch (e) { /* ignore */ }
      sess.riichi = null;
    }

    if (sess.matchTimer) clearTimeout(sess.matchTimer);
    if (sess.engineStartTimer) { clearTimeout(sess.engineStartTimer); sess.engineStartTimer = null; }
    var matchToken = ++sess.matchToken;
    var delay = CONFIG.matchDelay != null ? CONFIG.matchDelay : 1500;
    sess.matchTimer = setTimeout(function () {
      sess.matchTimer = null;
      if (sess.matchToken !== matchToken) return;
      if (!sess.socket || sess.socket.readyState !== OPEN) return;

      // 1) Table formed: read the local player's equipment dynamically
      var selfProfile = getSelfProfile(sess, sanma);
      var matchSeed = CONFIG.seed != null ? Number(CONFIG.seed) >>> 0 : randomSeed();
      var matchRng = seededRng(matchSeed);
      // Table snapshot: on reconnect, 20162 must replay the table from this (room number / opponents / equipment must not change)
      sess.table = {
        sanma: sanma,
        matchLength: CONFIG.matchLength,
        seed: matchSeed,
        roomId: Number(srm[4] || 1),
        roomType: Number(srm[3] || 0),
        rankRoomId: sess.rankRoomId,
        oneRound: oneRound,
        self: selfProfile,
        robots: [],
        logId: String(5118685 + Math.floor(matchRng() * 1000)),
        gameId: randGameId(matchRng)
      };
      sess.handFrames = [];
      log('  [match] => 20408 RankingMatchResultNotify (warrior=%s skin=%s seed=%s)',
        selfProfile.warrior, selfProfile.skin, matchSeed);
      sess.push(20408, P.W().s(2, encTableInfo(sess, false)).bytes(), 1, null);

      // 2) Each opponent is "offline-managed + seated" one by one: randomly assigned warriors
      var n = (sanma ? 3 : 4) - 1;
      var robots = MJ.npc.pickNpcs(matchRng, {
        count: n, humanWarrior: selfProfile.warrior,
        roomId: oneRound ? null : sess.rankRoomId, humanLevel: selfProfile.level
      });
      for (var i = 0; i < n; i++) {
        var r = robots[i];
        var seat = i + 1;
        sess.table.robots.push(r);
        log('  [match] => 20164/20014 seat%d %s(%d) warrior=%s', seat, r.nick, r.uid, r.warrior);
        sess.push(20164, P.W().v(1, r.uid).bytes(), 1, null);
        sess.push(20014, P.W().s(1, encTableUser(seat, r, true)).v(2, sess.table.roomType || 7).bytes(), 1, null);
      }

      // 3) Table ready, start the engine: it will actively push NtfToPrepare(1001)
      var engineStartDelay = CONFIG.engineStartDelay != null ? CONFIG.engineStartDelay : 200;
      sess.engineStartTimer = setTimeout(function () {
        sess.engineStartTimer = null;
        if (sess.matchToken !== matchToken || !sess.tableId) return;
        if (!sess.socket || sess.socket.readyState !== OPEN) return;
        var g = getRiichi(sess);
        if (g && g.ensureEngine) g.ensureEngine();
      }, engineStartDelay);
    }, delay);

    // The one-round "play again" does not go through 20102 leave-table; rewards / entry-fee increments not sent in the previous hand arrive with this reply.
    return withChange(20404, takeWalletChanges(sess));
  };

  // ------------------------------------------- One-round settlement
  /** Merge several { dtype: [[key, data, ct], ...] } increments; for the same row keep only the last one. */
  function mergeChanges(base, list) {
    var out = base || null;
    var items = Array.isArray(list) ? list : [list];
    for (var i = 0; i < items.length; i++) {
      var ch = items[i];
      if (!ch) continue;
      for (var dt in ch) {
        if (!Object.prototype.hasOwnProperty.call(ch, dt)) continue;
        if (!out) out = {};
        var rows = out[dt] || [];
        for (var j = 0; j < ch[dt].length; j++) {
          var row = ch[dt][j];
          rows = rows.filter(function (r) { return r[0] !== row[0]; });
          rows.push(row);
        }
        out[dt] = rows;
      }
    }
    return out;
  }

  function takeWalletChanges(sess) {
    var changes = sess.walletChanges;
    sess.walletChanges = null;
    return changes;
  }

  /** One-round match end: the entry fee and han rewards are credited once; the increments are sent in the f24 of the leave-table reply; rank and record are not written.
   *  The return value is written by the engine into the human seat's GameStopUserInfo.itemRewardLevel/itemRewards,
   *  and the client's GameEndResultView.TryShowOneRoundGameReward shows the reward window based on it. */
  function settleOneRound(sess, room, humanWin) {
    var result;
    try {
      result = MJ.oneRound.settleOneRound(USERDATA, room, humanWin);
    } catch (e) {
      // If the balance is spent elsewhere after the match starts, no debt is recorded and no reward is paid.
      log('  [oneRound] 结算失败：%s', e.message);
      return null;
    }
    if (result.changes) sess.walletChanges = result.changes;
    log('  [oneRound] %s 结算：奖励档 %d，报名费 %s，奖励 %s', room.id, result.itemRewardLevel,
      JSON.stringify(room.cost), JSON.stringify(result.itemRewards));
    return { itemRewardLevel: result.itemRewardLevel, itemRewards: result.itemRewards };
  }

  function clearMatchRecord(sess) {
    if (typeof sess.onMatchRecord === 'function') sess.onMatchRecord(null);
  }

  /** Rebuild a match from its saved record ({ table, log }) into a session that has no match yet.
   *  The engine replays the log at speed 0, so the AI's moves after the player's last decision are repeated exactly and the table
   *  stops at the player's next decision, frozen (no timeout) until the client re-syncs the table (playerBack).
   *  finish=true hands the player's seat to the neutral AI once the replay has caught up and plays the match out instantly.
   *  Resolves when the replay has caught up (finish: when the match is over). */
  function restoreMatch(sess, record, opts) {
    opts = opts || {};
    if (!record || !record.table || !Array.isArray(record.log)) throw new TypeError('invalid match record');
    sess.table = record.table;
    sess.tableId = 1;
    sess.seat = 0;
    sess.rankRoomId = record.table.rankRoomId || null;
    sess.handFrames = [];
    sess.restore = { log: record.log, present: false };
    var g = getRiichi(sess);
    if (!g) throw new Error('riichi backend not loaded');
    var finished = new Promise(function (resolve) {
      var onFinish = g.onFinish;
      g.onFinish = function (scores, engine) { onFinish.call(g, scores, engine); resolve(); };
    });
    // Frames produced while replaying only fill the hand cache; the client gets them through 20162 like any reconnect.
    sess.replaying = true;
    var eng = g.ensureEngine();
    var caughtUp = g.replayDone.then(function () {
      if (!opts.finish) return;
      eng.speed = 0;
      eng.setHumanAutoplay(true);
      return finished;
    });
    sess.restoring = caughtUp;
    return caughtUp.then(function () {
      if (sess.restoring === caughtUp) sess.restoring = null;
    });
  }

  /** 20405 cancel matchmaking -> 20406 */
  HANDLERS[20405] = function (sess) {
    log('  [match] 取消匹配');
    if (sess.matchTimer) { clearTimeout(sess.matchTimer); sess.matchTimer = null; }
    if (sess.engineStartTimer) { clearTimeout(sess.engineStartTimer); sess.engineStartTimer = null; }
    sess.matchToken += 1;
    sess.tableId = 0;
    sess.seat = -1;
    sess.table = null;
    return [[20406, new Uint8Array(0), 1, null]];
  };

  /** 20025 LeaveTable -> 20026: the player clicks "return to lobby" during the match or on the settlement screen */
  HANDLERS[20025] = function (sess) {
    log('  [leave] 离桌');
    clearMatchRecord(sess);
    if (sess.matchTimer) { clearTimeout(sess.matchTimer); sess.matchTimer = null; }
    if (sess.engineStartTimer) { clearTimeout(sess.engineStartTimer); sess.engineStartTimer = null; }
    sess.matchToken += 1;
    sess.tableId = 0; sess.seat = -1;
    sess.table = null; sess.handFrames = []; sess.replaying = false; sess._replayStarted = false;
    if (sess.riichi) { try { sess.riichi.stop(); } catch (e) {} sess.riichi = null; }
    return withChange(20026, takeWalletChanges(sess));
  };

  /** 20102 ClientFinishGameStopRequest -> 20103
   *  Real capture: after isFinal settlement the client sends this message to confirm exit; the server replies 20103 and then returns to the lobby. */
  HANDLERS[20102] = function (sess) {
    log('  [finish] 客户端确认结算完成，退出对局');
    clearMatchRecord(sess);
    if (sess.matchTimer) { clearTimeout(sess.matchTimer); sess.matchTimer = null; }
    if (sess.engineStartTimer) { clearTimeout(sess.engineStartTimer); sess.engineStartTimer = null; }
    sess.matchToken += 1;
    sess.tableId = 0; sess.seat = -1;
    sess.table = null; sess.handFrames = []; sess.replaying = false; sess._replayStarted = false;
    if (sess.riichi) { try { sess.riichi.stop(); } catch (e) {} sess.riichi = null; }
    return withChange(20103, takeWalletChanges(sess), P.W().v(1, 0).bytes());
  };

  /** 20018 uplink: handed to the engine; all reply frames are pushed asynchronously via sess.push */
  HANDLERS[20018] = function (sess, payload, seq) {
    // If already left the table (tableId=0 after the 20102 settlement confirmation / 20025 return to lobby), do not lazily create a session again,
    // otherwise the ReqPrepare left on the settlement screen would spawn a new match out of nowhere.
    // The real server gives zero response to 20018 uplinks in this state (see the final section of capture/dongfeng1/ws.jsonl).
    if (!sess.tableId) { log('  <riichi> 已离桌，忽略 20018 上行'); return []; }
    var r = getRiichi(sess);
    if (!r) return [];
    var d = P.dict(payload);
    var msgType = d[1] || 0;
    var inner = (d[100] instanceof Uint8Array) ? d[100] : new Uint8Array(0);
    log('  <riichi> %s %dB', riichiName(msgType), inner.length);
    // Record this request's seq so the Rsp* frames the engine pushes synchronously can echo it (e.g. ReqPrepare -> RspPrepare)
    sess._reqSeq = seq || 0;
    r.handleClient(msgType, inner);
    var sync = sess._clientSync;
    if (msgType === 1 && sync && sync.waitingTable) {
      sync.waitingTable = false;
      replayHand(sess, 0);
    }
    return [];
  };

  // ------------------------------------------------------------ Request dispatch
  function dispatch(sess, raw) {
    var fields;
    try {
      fields = P.parse(raw);
    } catch (e) {
      console.warn('[mock] 无法解析的帧 %dB: %s', raw.length, e.message);
      return [];
    }
    var d = {};
    for (var i = 0; i < fields.length; i++) d[fields[i][0]] = fields[i][2];
    var mid = d[2];
    var seq = d[11] || 0;
    var payload = (d[3] instanceof Uint8Array) ? d[3] : new Uint8Array(0);
    if (d[29] instanceof Uint8Array) sess.version = P.fromUtf8(d[29]);
    sess.lastSeq = seq;

    var st = REQ_STATS[mid];
    if (!st) st = REQ_STATS[mid] = { n: 0, last: 0, prev: 0 };
    var _now = nowMs();
    st.prev = st.last;
    st.last = _now;
    st.n++;

    var fn = HANDLERS[mid];
    var out, tag;
    if (!fn) {
      if (REPLAY[mid + 1]) {
        out = [[mid + 1, REPLAY[mid + 1], 1, null]];
        tag = 'replay';
      } else {
        out = [[mid + 1, P.W().v(1, 1).bytes(), 1, null]];
        tag = 'unsupported';
        LOG.unhandled.push({
          msgId: mid, name: nameOf(mid), seq: seq,
          payload: payload, t: nowMs()
        });
        if (LOG.unhandled.length > 200) LOG.unhandled.shift();
      }
    } else {
      try {
        out = fn(sess, payload, seq);
        tag = 'handled';
      } catch (e) {
        console.error('[mock] handler 异常 (mid=%s):', mid, e);
        out = [[mid + 1, new Uint8Array(0), 1, null]];
        tag = 'error';
      }
    }
    // Successful keepalives have no diagnostic value; failures and all other outcomes remain visible.
    if (LOG.enabled || mid !== 20019 || tag !== 'handled') {
      console.log('[request] ' + JSON.stringify({ mid: mid, name: nameOf(mid), seq: seq,
        bytes: raw.length, result: tag, replies: out.map(function (reply) { return reply[0]; }) }));
    }
    log('  <- %s %s seq=%s %dB [%s]', mid, nameOf(mid), seq, raw.length, tag);

    var frames = [];
    for (var j = 0; j < out.length; j++) {
      var frame = sess.wrap(out[j][0], out[j][1], seq, out[j][2], out[j][3]);
      frames.push(frame);
      log('  -> %s %s %dB', out[j][0], nameOf(out[j][0]), frame.length);
    }
    return frames;
  }

  // ------------------------------------------------------- FakeWebSocket
  var CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

  // The previous match session (reused on disconnect-reconnect, so the match is not lost when the client actively closes the WS)
  var _lastSession = null;

  function FakeWebSocket(url, protocols) {
    var self = this;
    this.url = String(url);
    this.protocol = Array.isArray(protocols) ? (protocols[0] || '') : (protocols || '');
    this.extensions = '';
    this.readyState = CONNECTING;
    this.bufferedAmount = 0;
    this.binaryType = 'blob';
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._listeners = {};
    // Reconnect: reuse the old riichi match session
    if (_lastSession && (_lastSession.riichi || _lastSession.liveMatch())) {
      this._session = _lastSession;
      this._session.resume(this);
      _lastSession = null;
      log('[mock] 重连复用旧会话（保留对局引擎） %s', this.url);
    } else {
      if (_lastSession) { _lastSession.destroy(); _lastSession = null; }
      this._session = new Session();
      // The in-browser host (web-host.js) attaches the local profile and save callbacks to each new session.
      if (typeof MJ.server.onSessionCreated === 'function') MJ.server.onSessionCreated(this._session);
    }
    this._session.socket = this;

    log('[mock] 建立虚拟连接 %s', this.url);
    // Trigger open asynchronously to simulate the real handshake timing (a synchronous trigger would fire before the caller has bound onopen)
    setTimeout(function () {
      if (self.readyState !== CONNECTING) return;
      self.readyState = OPEN;
      self._emit('open', { type: 'open', target: self });
    }, 0);
  }

  FakeWebSocket.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
  };

  FakeWebSocket.prototype.removeEventListener = function (type, fn) {
    var arr = this._listeners[type];
    if (!arr) return;
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };

  FakeWebSocket.prototype.dispatchEvent = function (ev) {
    this._emit(ev.type, ev);
    return true;
  };

  FakeWebSocket.prototype._emit = function (type, ev) {
    var stopped = false;
    ev.stopImmediatePropagation = function () { stopped = true; };
    // The host interceptor is installed before Unity assigns onmessage. It must consume control frames first.
    var arr = (this._listeners[type] || []).slice();
    for (var i = 0; i < arr.length && !stopped; i++) {
      try { arr[i].call(this, ev); } catch (e) { console.error('[mock] listener ' + type, e); }
    }
    var on = this['on' + type];
    if (!stopped && typeof on === 'function') {
      try { on.call(this, ev); } catch (e) { console.error('[mock] on' + type, e); }
    }
  };

  /** Wrap the response in the form the client expects, according to binaryType. */
  FakeWebSocket.prototype._deliver = function (bytes) {
    var self = this;
    var data;
    if (this.binaryType === 'arraybuffer') {
      // Copy an independent ArrayBuffer so the caller does not hold our internal view
      data = bytes.slice().buffer;
    } else {
      data = new Blob([bytes]);
    }
    self._emit('message', {
      type: 'message', data: data, target: self,
      origin: self.url, lastEventId: '', source: null, ports: []
    });
  };

  FakeWebSocket.prototype._sync = function (message) {
    this._emit('message', { type: 'message', data: JSON.stringify({ mjSync: message }), target: this });
  };

  FakeWebSocket.prototype.send = function (payload) {
    if (this.readyState !== OPEN) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError');
    }
    var bytes;
    if (payload instanceof ArrayBuffer) bytes = new Uint8Array(payload);
    else if (ArrayBuffer.isView(payload)) {
      bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    } else if (typeof payload === 'string') {
      if (payload.length <= 1024) {
        try {
          var control = JSON.parse(payload);
          if (control && (control.mjSyncAck || control.mjClientId || control.mjClockReady)) { this._session.clientControl(control, this); return; }
        } catch (e) { /* Non-control strings follow the original dispatch path. */ }
      }
      bytes = P.utf8(payload);
    }
    else {
      console.warn('[mock] 不支持的发送类型', payload);
      return;
    }
    // Copy it, to prevent the caller from reusing the same buffer, which would make later parsing read dirty data
    bytes = bytes.slice();

    var self = this;
    var frames = dispatch(this._session, bytes);
    if (!frames.length) return;
    // Async delivery, simulating network round trips; a synchronous callback would scramble Unity's message queue
    setTimeout(function () {
      if (self.readyState !== OPEN) return;
      for (var i = 0; i < frames.length; i++) self._deliver(frames[i]);
    }, 0);
  };

  FakeWebSocket.prototype.close = function (code, reason) {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    var self = this;
    var activeGame = !!(self._session && self._session.liveMatch());
    if (!activeGame) {
      // Not in a match: normal graceful close (replies 1000 or the client's code; the close handshake completes as usual)
      this.readyState = CLOSING;
      setTimeout(function () {
        self.readyState = CLOSED;
        // Do not destroy the session: keep the riichi engine for reuse on client reconnect (to avoid interrupting the match)
        _lastSession = self._session;
        self._session.suspend();
        self._emit('close', {
          type: 'close', code: code || 1000, reason: reason || '',
          wasClean: true, target: self
        });
        log('[mock] 虚拟连接已关闭 code=%s reason=%s', code || 1000, reason || '');
      }, 0);
      return;
    }
    // Match in progress: simulate a "network drop". The real server does not reply to the close frame when the network is cut; BestHTTP detects the abnormal connection
    // (onError) → closes with the abnormal code onClose(1006, wasClean=false) → the client keeps its in-match state and
    // reconnects automatically → after reconnecting it sends 20162 to ask and resume the match (see capture/dongfeng1).
    // Sending only an error does not make the client consider the connection ended, so it won't reconnect; in a real WebSocket drop, a close with wasClean=false follows the error,
    // so it is appended here, which is what makes the client trigger a reconnect.
    // Key point: this is a disconnect initiated on the SERVER side (the client did not call ws.close), so the client's
    // in-match state is not cleared; after reconnect it sends 20162 rather than 20102. The engine always stays in _lastSession.
    this.readyState = CLOSED;
    _lastSession = self._session;
    self._session.suspend();
    self._emit('error', { type: 'error', message: 'simulated network drop', target: self });
    self._emit('close', { type: 'close', code: 1006, reason: '', wasClean: false, target: self });
    log('[mock] 虚拟连接已关闭（对局中·模拟掉线）code=1006 wasClean=false（引擎已保留）');
  };

  FakeWebSocket.CONNECTING = CONNECTING;
  FakeWebSocket.OPEN = OPEN;
  FakeWebSocket.CLOSING = CLOSING;
  FakeWebSocket.CLOSED = CLOSED;
  FakeWebSocket.prototype.CONNECTING = CONNECTING;
  FakeWebSocket.prototype.OPEN = OPEN;
  FakeWebSocket.prototype.CLOSING = CLOSING;
  FakeWebSocket.prototype.CLOSED = CLOSED;

  // ------------------------------------------------------------------ Exports
  MJ.server = {
    FakeWebSocket: FakeWebSocket,
    Session: Session,
    handlers: HANDLERS,
    replay: REPLAY,
    log: LOG,
    uid: UID,
    config: CONFIG,
    encodeKRiichi: encodeKRiichi,
    riichiNames: RIICHI_NAMES,
    dispatch: dispatch,
    createSession: function () { return new Session(); },
    restoreMatch: restoreMatch,
    setUserdata: function (bytes) { USERDATA = new U.UserData(bytes, UID); },
    updateNickname: function (nickname) { return USERDATA.updateNickname(nickname); },
    updateRanks: function (ranks) { return USERDATA.updateRanks(ranks); },
    updateProfileStats: function (stats) { return USERDATA.updateProfileStats(stats); },

    /** Current lobby data state (can be edited directly in the console) */
    get userdata() { return USERDATA; },

    /** Restore to the initial snapshot */
    reset: function () {
      USERDATA = new U.UserData(P.b64decode(DATA.userdataB64), UID);
      console.log('[mock] 用户数据已重置');
    },

    /** Turn off the spam log */
    quiet: function (on) { LOG.enabled = (on === false); },

    /** View explicitly rejected, unimplemented requests. */
    unhandled: function () {
      var seen = {};
      LOG.unhandled.forEach(function (r) {
        var key = r.msgId + ' ' + r.name;
        seen[key] = (seen[key] || 0) + 1;
      });
      return seen;
    },

    /** Export the current lobby data, for saving as a new patch */
    dump: function () {
      var b = USERDATA.serialize();
      var s = '';
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return global.btoa(s);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
