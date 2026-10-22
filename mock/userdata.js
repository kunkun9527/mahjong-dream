/* Mutable state model for lobby user data (100142), the JS version of userdata.py
 *
 * Protocol structure (reverse-engineered from IL2CPP global-metadata):
 *   QueryUserDataResponse      { 1:Result, 2:UserId, 3:repeated UserDataSingleTypeResponse }
 *   UserDataSingleTypeResponse { 1:DataType, 2:Version, 3:repeated UserDataSingleRow }
 *   UserDataSingleRow          { 1:DataId(string), 2:Data(bytes) }
 *
 * On any response frame, the server pushes increments in the wrapper f24 (DataChangeFieldNumber):
 *   UserDataChange             { 1:UserId, 2:repeated UserDataSingleTypeChange }
 *   UserDataSingleTypeChange   { 1:DataType, 2:Version, 3:repeated UserDataSingleRowChange }
 *   UserDataSingleRowChange    { 1:DataId, 2:Data, 3:ChangeType }
 *
 * Client-side "save" operations do not change the local cache; they only wait for this increment. If none arrives, the operation is judged failed and the UI is rolled back.
 */
(function (global) {
  'use strict';

  var MJ = global.__mj || (global.__mj = {});
  var P = MJ.proto;

  var MODIFY = 0, ADD = 1, DELETE = 2;

  var DT_BASIC_INFO = 1;
  var DT_HEAD = 11;
  var DT_MAHJONG_WARRIOR = 26;
  var DT_MAHJONG_WARRIOR_SKIN = 37;
  var DT_SIGN_IN = 34;   // Check-in: row "0".f1 = last check-in Unix timestamp; the cross-day check reads this
  var DT_PROFILE = 42;

  var DT_NAMES = {
    1: 'BasicInfo', 2: 'GameSetting', 3: 'RankingMatchInfo', 4: 'HighlightRecord',
    5: 'OrnamentScheme', 6: 'KnapsackItem', 7: 'KnapsackGift', 8: 'KnapsackMaterial',
    9: 'FriendList', 10: 'FriendData', 11: 'Head', 12: 'HeadFrame', 13: 'Title',
    14: 'LiZhi', 15: 'MahjongTablecloth', 16: 'MahjongCard', 17: 'TableRack',
    18: 'SpecialEffects', 19: 'Bgm', 20: 'Scene', 21: 'SpecialEffects1', 22: 'Bgm1',
    23: 'Bgm2', 24: 'Scene1', 25: 'MahjongCard1', 26: 'MahjongWarrior', 27: 'RedDot',
    28: 'GuideInfo', 29: 'PayInfo', 30: 'ShopInfo', 31: 'ActInfo', 32: 'MailInfo',
    33: 'Notice', 34: 'SignIn', 35: 'RankingMatchCommon', 36: 'OneGameInfo',
    37: 'MahjongWarriorSkin', 38: 'Achievement', 39: 'Task', 40: 'Bp',
    41: 'RankingMatch2Info', 42: 'UserProfile', 43: 'UserGiftInfo', 44: 'NewSignIn',
    45: 'InnerScene', 46: 'InnerChair', 47: 'InnerTable', 48: 'AbTest',
    49: 'FunctionSwitch'
  };

  // -------------------------------------------------------------- Module
  function Module(dtype, version, rows, order, extra) {
    this.dtype = dtype;
    this.version = version;
    this.rows = rows;      // { key(string): Uint8Array }
    this.order = order;    // Keep the original row order
    this.extra = extra;    // Raw encoding of other unknown fields
  }

  Module.prototype.serialize = function () {
    // proto3: default values (0 / empty bytes) are not encoded, otherwise the byte count will not match the original
    var w = P.W();
    w.v(1, this.dtype);
    if (this.version) w.v(2, this.version);
    if (this.extra && this.extra.length) w.raw(this.extra);
    for (var i = 0; i < this.order.length; i++) {
      var key = this.order[i];
      var data = this.rows[key];
      var row = P.W();
      if (key.length) row.s(1, key);
      if (data && data.length) row.s(2, data);
      w.s(3, row.bytes());
    }
    return w.bytes();
  };

  // ------------------------------------------------------------ UserData
  function UserData(blob, uid) {
    this.uid = uid || 0;
    this.headParts = [];      // Top-level non-f3 fields (Result / UserId etc.)
    this.modules = {};
    this.moduleOrder = [];

    var top = P.parse(blob);
    for (var i = 0; i < top.length; i++) {
      var fn = top[i][0], wt = top[i][1], val = top[i][2];
      if (fn !== 3 || wt !== 2) {
        this.headParts.push([fn, wt, val]);
        continue;
      }
      var dtype = null, version = 0, rows = {}, order = [];
      var extraW = P.W();
      var fs = P.parse(val);
      for (var j = 0; j < fs.length; j++) {
        var f = fs[j][0], w = fs[j][1], v = fs[j][2];
        if (f === 1 && w === 0) dtype = v;
        else if (f === 2 && w === 0) version = v;
        else if (f === 3 && w === 2) {
          var rf = P.dict(v);
          var key = rf[1] ? P.fromUtf8(rf[1]) : '';
          rows[key] = rf[2] || new Uint8Array(0);
          order.push(key);
        } else {
          P.reencode(extraW, f, w, v);
        }
      }
      if (dtype === null) continue;
      this.modules[dtype] = new Module(dtype, version, rows, order, extraW.bytes());
      this.moduleOrder.push(dtype);
    }
  }

  UserData.prototype.serialize = function () {
    var w = P.W();
    for (var i = 0; i < this.headParts.length; i++) {
      var h = this.headParts[i];
      P.reencode(w, h[0], h[1], h[2]);
    }
    for (var j = 0; j < this.moduleOrder.length; j++) {
      w.s(3, this.modules[this.moduleOrder[j]].serialize());
    }
    return w.bytes();
  };

  UserData.prototype.row = function (dtype, key) {
    var m = this.modules[dtype];
    if (!m) return null;
    return m.rows[String(key)] || null;
  };

  /** Write one row and bump the module version by +1; returns [key, data, changeType]. */
  UserData.prototype.setRow = function (dtype, key, data) {
    key = String(key);
    var m = this.modules[dtype];
    if (!m) {
      m = this.modules[dtype] = new Module(dtype, 0, {}, [], new Uint8Array(0));
      this.moduleOrder.push(dtype);
    }
    var ct = (key in m.rows) ? MODIFY : ADD;
    if (ct === ADD) m.order.push(key);
    m.rows[key] = data;
    m.version += 1;
    return [key, data, ct];
  };

  /** Item quantities: items / gifts / materials share the { 1:id, 2:count } structure. */
  UserData.prototype.inventoryCount = function (dtype, id) {
    if (![6, 7, 8].includes(dtype) || !Number.isSafeInteger(id) || id <= 0) {
      throw new RangeError('非法背包物品');
    }
    var row = this.row(dtype, id);
    var count = row ? (P.get(row, 2) || 0) : 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('非法背包数量');
    }
    return count;
  };

  /** Validate all charges/deliveries first, then commit them in one go; on failure, quantities, module version and row order are left unchanged. */
  UserData.prototype.changeInventory = function (deltas) {
    var totals = new Map();
    for (var delta of deltas) {
      this.inventoryCount(delta.dtype, delta.id);
      if (!Number.isSafeInteger(delta.count)) throw new RangeError('非法数量变化');
      var key = delta.dtype + ':' + delta.id;
      var prior = totals.get(key);
      var total = (prior ? prior.count : 0) + delta.count;
      if (!Number.isSafeInteger(total)) throw new RangeError('数量变化溢出');
      totals.set(key, { dtype: delta.dtype, id: delta.id, count: total });
    }
    var pending = [];
    for (var entry of totals.values()) {
      if (!entry.count) continue;
      var count = this.inventoryCount(entry.dtype, entry.id) + entry.count;
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError('余额不足或背包数量溢出');
      }
      var before = this.row(entry.dtype, entry.id) || P.W().v(1, entry.id).bytes();
      pending.push({ dtype: entry.dtype, id: entry.id, bytes: P.setVarint(before, 2, count) });
    }
    if (!pending.length) return null;
    var changes = {};
    for (var update of pending) {
      if (!changes[update.dtype]) changes[update.dtype] = [];
      changes[update.dtype].push(this.setRow(update.dtype, update.id, update.bytes));
    }
    return changes;
  };

  /** Real structure of wrapper f24 (confirmed against the official-server capture 100012):
   *    f24 = DataChangeNotify { 1: UserDataChange }
   *  i.e. UserDataChange is wrapped in an extra f1; early versions missed this layer,
   *  so the client could not decode the increment and all save operations silently failed (UI not refreshed / rolled back). */
  UserData.prototype.changeNotify = function (changes) {
    return P.W().s(1, this.changePacket(changes)).bytes();
  };

  /** changes: { dtype: [[key, data, changeType], ...] } -> UserDataChange bytes */
  UserData.prototype.changePacket = function (changes) {
    var w = P.W();
    w.v(1, this.uid);
    for (var dt in changes) {
      if (!Object.prototype.hasOwnProperty.call(changes, dt)) continue;
      var st = P.W();
      st.v(1, Number(dt));
      st.v(2, this.modules[dt].version);
      var rows = changes[dt];
      for (var i = 0; i < rows.length; i++) {
        var rc = P.W();
        rc.s(1, rows[i][0]);
        rc.s(2, rows[i][1]);
        if (rows[i][2]) rc.v(3, rows[i][2]);
        st.s(3, rc.bytes());
      }
      w.s(2, st.bytes());
    }
    return w.bytes();
  };

  // ---------------------------------------------------------- Business operations
  /** Change skin: MahjongWarrior row[warriorId].Data.f3(MahjongWarriorData).f3 = sculptId */
  UserData.prototype.wearSculpt = function (warriorId, sculptId) {
    var row = this.row(DT_MAHJONG_WARRIOR, warriorId);
    if (!row) return null;
    var inner = P.get(row, 3);
    if (!inner) return null;
    inner = P.setVarint(inner, 3, sculptId);      // SculptId
    row = P.setBytes(row, 3, inner);
    var ch = this.setRow(DT_MAHJONG_WARRIOR, warriorId, row);
    var out = {};
    out[DT_MAHJONG_WARRIOR] = [ch];
    return out;
  };

  /** Change the equipped gear in use: UserBasic.f2(UserBasicEquipment).f1 = map<DataType, int> */
  UserData.prototype.selectEquipment = function (pairs) {
    var row = this.row(DT_BASIC_INFO, '0');
    if (!row) return null;
    var equip = P.get(row, 2) || new Uint8Array(0);
    var keys = [], map = {};
    var fs = P.parse(equip);
    for (var i = 0; i < fs.length; i++) {
      if (fs[i][0] !== 1 || fs[i][1] !== 2) continue;
      var e = P.dict(fs[i][2]);
      var k = e[1];
      if (!(k in map)) keys.push(k);
      map[k] = e[2] || 0;
    }
    for (var j = 0; j < pairs.length; j++) {
      var pk = pairs[j][0];
      if (!(pk in map)) keys.push(pk);
      map[pk] = pairs[j][1];
    }
    var w = P.W();
    for (var n = 0; n < keys.length; n++) {
      var entry = P.W();
      entry.v(1, keys[n]);
      entry.v(2, map[keys[n]]);
      w.s(1, entry.bytes());
    }
    row = P.setBytes(row, 2, w.bytes());
    var ch = this.setRow(DT_BASIC_INFO, '0', row);
    // The official server bumps the version by +1 for each item changed (one request with N items → +N); this matches that
    if (pairs.length > 1) this.modules[DT_BASIC_INFO].version += pairs.length - 1;
    var out = {};
    out[DT_BASIC_INFO] = [ch];
    return out;
  };

  // ---------------------------------------------------------- Cross-day check-in
  // Suppress unsupported lobby reward promotions without granting or spending items.
  // SignIn.f1 and NewSignIn.f6 are UTC+8 daily popup guards; gift data is nested in f3.
  UserData.prototype.normalizeOfflineLobby = function (now) {
    now = now == null ? Math.floor(Date.now() / 1000) : now;
    var day = Math.floor((now + 8 * 3600) / 86400);
    var self = this, changes = {};
    function today(value) { return Math.floor((Number(value || 0) + 8 * 3600) / 86400) === day; }
    function update(dtype, key, bytes) {
      var old = self.row(dtype, key);
      if (old && old.length === bytes.length && old.every(function (b, i) { return b === bytes[i]; })) return;
      if (!changes[dtype]) changes[dtype] = [];
      changes[dtype].push(self.setRow(dtype, key, bytes));
      // Reloading an older snapshot must invalidate yesterday's client-side cache too.
      self.modules[dtype].version = Math.max(self.modules[dtype].version, day * 1024);
    }
    var sign = this.row(DT_SIGN_IN, '0') || new Uint8Array(0);
    if (!today(P.get(sign, 1))) update(DT_SIGN_IN, '0', P.setVarint(sign, 1, now));
    var newbie = this.modules[44];
    if (newbie) newbie.order.forEach(function (key) {
      var row = newbie.rows[key];
      if (!today(P.get(row, 6))) update(44, key, P.setVarint(row, 6, now));
    });
    var gifts = this.modules[43];
    if (gifts) gifts.order.forEach(function (key) {
      var row = gifts.rows[key], data = P.get(row, 3);
      if (!data) return;
      if (P.get(data, 11) || !today(P.get(data, 8))) {
        data = P.setVarint(P.setVarint(data, 11, 0), 8, now);
        update(43, key, P.setBytes(row, 3, data));
      }
    });
    // Only remove activity/announcement red-dot entries; keep shop, rank and gameplay data.
    var dots = this.modules[27];
    if (dots) dots.order.forEach(function (key) {
      var w = P.W();
      P.parse(dots.rows[key]).forEach(function (f) {
        if (f[0] === 1 && f[1] === 2) {
          var data = P.get(f[2], 2), type = data ? P.get(data, 1) : 0;
          if (type === 3 || type === 4) return;
        }
        P.reencode(w, f[0], f[1], f[2]);
      });
      update(27, key, w.bytes());
    });
    // IDs from this snapshot's Notice*CfgTb tables; both clients share these assets.
    var readIds = [1, 2, 3, 4, 5, 6, 100001, 100004, 100005, 100006, 100007, 100008, 100009];
    var notice = this.modules[33];
    var noticeKeys = notice ? notice.order : ['0'];
    noticeKeys.forEach(function (key) {
      var row = self.row(33, key) || new Uint8Array(0), seen = [], w = P.W();
      P.parse(row).forEach(function (f) {
        if (f[0] === 1 && (f[1] === 0 || f[1] === 2)) {
          (f[1] === 2 ? P.unpack(f[2]) : [f[2]]).forEach(function (id) { if (seen.indexOf(id) < 0) seen.push(id); });
        } else {
          if (f[0] === 2 && f[1] === 2) {
            var id = P.get(f[2], 1);
            if (id && seen.indexOf(id) < 0) seen.push(id);
          }
          P.reencode(w, f[0], f[1], f[2]);
        }
      });
      readIds.forEach(function (id) { if (seen.indexOf(id) < 0) seen.push(id); });
      seen.sort(function (a, b) { return a - b; });
      w.packed(1, seen);
      update(33, key, w.bytes());
    });
    var acts = this.modules[31];
    if (acts) acts.order.forEach(function (key) {
      var row = acts.rows[key], w = P.W();
      P.parse(row).forEach(function (f) {
        if (f[0] === 1 && f[1] === 2) {
          var entry = f[2], data = P.get(entry, 2), clean = P.W();
          if (data) {
            P.parse(data).forEach(function (a) { if (a[0] !== 4 || a[1] !== 2) P.reencode(clean, a[0], a[1], a[2]); });
            entry = P.setBytes(entry, 2, clean.bytes());
          }
          w.s(1, entry);
        } else P.reencode(w, f[0], f[1], f[2]);
      });
      update(31, key, w.bytes());
    });
    return Object.keys(changes).length ? changes : null;
  };

  /** Cross-day check-in: set SignIn(34) row "0"'s f1 (last check-in timestamp) to "now";
   *  other fields (f2 check-in history / f3 start date) are kept as-is. Returns the {34:[[key,data,MODIFY]]}
   *  increment, which the caller pushes back via wrapper f24, so the client's cross-day check clears and it stops high-frequency Task(39) polling.
   *
   *  Root cause: the snapshot's SignIn.f1=1786266336(2026-08-09) is already past the day boundary, so every time the client enters the lobby it detects
   *  "not checked in today", sends KclientSignInReq(100620) and periodically polls Task(39) waiting for
   *  the cross-day refresh. Previously 100620 had no handler (auto-ok empty packet), so the client never received the check-in completion signal,
   *  and the polling looped forever. Setting the check-in timestamp to today makes it stop. */
  UserData.prototype.dailySignIn = function () {
    var key = '0';
    var row = this.row(DT_SIGN_IN, key);
    if (!row) return null;
    var now = Math.floor(Date.now() / 1000);
    var w = P.W();
    var found = false;
    var fs = P.parse(row);
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i][0], wt = fs[i][1], v = fs[i][2];
      if (f === 1 && wt === 0) { w.v(1, now); found = true; }
      else P.reencode(w, f, wt, v);
    }
    if (!found) w.v(1, now);
    var ch = this.setRow(DT_SIGN_IN, key, w.bytes());
    var out = {};
    out[DT_SIGN_IN] = [ch];

    // After a real check-in, the official server pushes DT34+DT39+DT6+DT38 in f24; here we also push DT39, so the client does not keep re-querying DT39 because its task was not updated after check-in
    // (see the 100141 spam detection in server.js)
    var taskMod = this.modules[39];
    if (taskMod) {
      taskMod.version += 3;
      out[39] = [[taskMod.order[0] || '0', taskMod.rows[taskMod.order[0]] || new Uint8Array(0), MODIFY]];
    }

    return out;
  };

  /** Bump the module version (data unchanged); returns the f24 increment. */
  UserData.prototype.bumpModule = function (dtype) {
    var m = this.modules[dtype];
    if (!m) return null;
    var key = m.order.length ? m.order[0] : '0';
    var data = m.rows[key] || new Uint8Array(0);
    m.version += 1;
    return this._makeChange(dtype, key, data, MODIFY);
  };

  UserData.prototype._makeChange = function (dtype, key, data, ct) {
    var out = {};
    out[dtype] = [[String(key), data, ct]];
    return out;
  };

  /** Merge GameSetting into DT2 and bump the version +1; returns the f24 increment. */
  UserData.prototype.updateGameSetting = function (gameSetting) {
    var row = this.row(2, '0');
    if (!row) return null;
    var fs;
    try { fs = P.parse(gameSetting); } catch (e) { return null; }
    var newRow = row;
    for (var i = 0; i < fs.length; i++) {
      var fn = fs[i][0], wt = fs[i][1], v = fs[i][2];
      if (wt === 2) {
        if (v && v.length) newRow = P.setBytes(newRow, fn, v);
      } else if (wt === 0) {
        newRow = P.setVarint(newRow, fn, v);
      }
    }
    var ch = this.setRow(2, '0', newRow);
    return this._makeChange(2, ch[0], ch[1], ch[2]);
  };

  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** DT42 ProfileInfo measured fields: 10 matches, 11 hands, 12 wins, 13 deal-ins, 14 melds,
   *  16 win points, 17 busted by others (tobi), 18 max consecutive dealer wins, 19 win turn, 20 ron wins, 21 tsumo wins, 22 riichi. */
  function encodeProfileInfo(bytes, stats) {
    var w = P.W(), fs = P.parse(bytes || new Uint8Array(0));
    var replaced = { 10: 1, 11: 1, 12: 1, 13: 1, 14: 1, 16: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1, 22: 1, 40: 1 };
    for (var i = 0; i < fs.length; i++) {
      if (!replaced[fs[i][0]]) P.reencode(w, fs[i][0], fs[i][1], fs[i][2]);
    }
    var values = {
      10: stats.games, 11: stats.hands, 12: stats.wins, 13: stats.dealIns,
      14: stats.calls, 16: stats.winPoints, 17: stats.busts, 18: stats.maxRenchan,
      19: stats.winTurns, 20: stats.ron, 21: stats.tsumo, 22: stats.riichi
    };
    for (var field in values) {
      var value = Math.max(0, Number(values[field]) || 0);
      if (value) w.v(Number(field), value);
    }
    return w.bytes();
  }

  function encodeProfileBlock(bytes, stats) {
    var w = P.W(), fs = P.parse(bytes), wanted = {
      '1_0': stats.byLength.east,
      '1_1': stats.byLength.hanchan
    };
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i], value = f[2];
      if (f[0] === 2 && f[1] === 2) {
        var entry = P.dict(value);
        var key = entry[1] instanceof Uint8Array ? P.fromUtf8(entry[1]) : '';
        if (wanted[key] && entry[2] instanceof Uint8Array) {
          var wrapper = entry[2];
          var info = P.get(wrapper, 2) || new Uint8Array(0);
          wrapper = P.setBytes(wrapper, 2, encodeProfileInfo(info, wanted[key]));
          value = P.setBytes(value, 2, wrapper);
        }
      }
      P.reencode(w, f[0], f[1], value);
    }
    return w.bytes();
  }

  /** Sync the single JSON profile's 3-/4-player East-wind and hanchan stats back to the original client's DT42 record page. */
  UserData.prototype.updateProfileStats = function (stats) {
    var row = this.row(DT_PROFILE, '0');
    if (!row || !stats || !stats.yonma || !stats.sanma) return null;
    var w = P.W(), fs = P.parse(row);
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i], value = f[2];
      if (f[1] === 2 && f[0] === 1) value = encodeProfileBlock(value, stats.yonma);
      else if (f[1] === 2 && f[0] === 2) value = encodeProfileBlock(value, stats.sanma);
      P.reencode(w, f[0], f[1], value);
    }
    var next = w.bytes();
    if (sameBytes(row, next)) return null;
    var ch = this.setRow(DT_PROFILE, '0', next);
    return this._makeChange(DT_PROFILE, ch[0], ch[1], ch[2]);
  };


  /** Sync the 3-/4-player local rank to DT41; 4001 = 4-player, 4002 = 3-player. */
  UserData.prototype.updateRanks = function (ranks) {
    var out = [];
    var modes = [{ key: '4001', rank: ranks && ranks.yonma }, { key: '4002', rank: ranks && ranks.sanma }];
    for (var i = 0; i < modes.length; i++) {
      var item = modes[i], row = this.row(41, item.key);
      if (!row || !item.rank) continue;
      row = P.setVarint(row, 1, item.rank.level || 1);
      row = P.setVarint(row, 2, item.rank.point || 0);
      var ch = this.setRow(41, item.key, row);
      out.push(this._makeChange(41, ch[0], ch[1], ch[2]));
    }
    return out;
  };

  /** Change the local nickname: UserBasic.f1(UserBasicInfo).f1 = nickname. */
  UserData.prototype.updateNickname = function (nickname) {
    var row = this.row(DT_BASIC_INFO, '0');
    if (!row) return null;
    var basic = P.get(row, 1) || new Uint8Array(0);
    basic = P.setBytes(basic, 1, P.utf8(nickname));
    row = P.setBytes(row, 1, basic);
    var ch = this.setRow(DT_BASIC_INFO, '0', row);
    return this._makeChange(DT_BASIC_INFO, ch[0], ch[1], ch[2]);
  };

  // The original config MjWTbGoodwillLevel tops out at level 6, and the MjWTbWarriorAudio voice threshold is at most Lv6 as well.
  var MAX_WARRIOR_LEVEL = 6;
  // All 19 avatars from the original config PlayerInfoTbHead.
  var ALL_HEAD_IDS = [];
  for (var headId = 1001; headId <= 1019; headId++) ALL_HEAD_IDS.push(headId);

  /** Full offline content unlock: fill in all avatars, and set every warrior's affinity to the highest level and awakened.
   *  Idempotent, called after each profile load; does not touch currency or rank. Returns null if nothing changed. */
  UserData.prototype.normalizeOfflineContent = function () {
    var changes = {}, changed = false;

    // DT11 Head row "0": repeated f1 { 1:HeadId, 2:{ 1:HeadId, 2:acquired time } }
    var head = this.row(DT_HEAD, '0');
    if (head) {
      var owned = {}, latest = 0;
      P.parse(head).forEach(function (f) {
        if (f[0] !== 1 || f[1] !== 2) return;
        var entry = P.dict(f[2]);
        owned[entry[1]] = true;
        var info = entry[2] instanceof Uint8Array ? P.dict(entry[2]) : {};
        if (info[2] > latest) latest = info[2];
      });
      var headW = P.W().raw(head), added = false;
      ALL_HEAD_IDS.forEach(function (id) {
        if (owned[id]) return;
        headW.s(1, P.W().v(1, id).s(2, P.W().v(1, id).v(2, latest)).bytes());
        added = true;
      });
      if (added) {
        changes[DT_HEAD] = [this.setRow(DT_HEAD, '0', headW.bytes())];
        changed = true;
      }
    }

    // DT26 warriors: row.f3 MahjongWarriorData { 5:Level, 7:Arousal }
    var warriors = this.modules[DT_MAHJONG_WARRIOR];
    if (warriors) {
      var keys = warriors.order.slice();
      for (var i = 0; i < keys.length; i++) {
        var row = warriors.rows[keys[i]];
        var inner = row && P.get(row, 3);
        if (!(inner instanceof Uint8Array)) continue;
        if ((P.get(inner, 5) || 0) >= MAX_WARRIOR_LEVEL && (P.get(inner, 7) || 0) >= 1) continue;
        inner = P.setVarint(P.setVarint(inner, 5, MAX_WARRIOR_LEVEL), 7, 1);
        if (!changes[DT_MAHJONG_WARRIOR]) changes[DT_MAHJONG_WARRIOR] = [];
        changes[DT_MAHJONG_WARRIOR].push(this.setRow(DT_MAHJONG_WARRIOR, keys[i], P.setBytes(row, 3, inner)));
        changed = true;
      }
    }

    // DT1 UserBasic.f20 WarriorList: repeated { 1:WarriorId, 2:Level }
    var basic = this.row(DT_BASIC_INFO, '0');
    if (basic) {
      var basicW = P.W(), raised = false;
      P.parse(basic).forEach(function (f) {
        if (f[0] === 20 && f[1] === 2 && (P.get(f[2], 2) || 0) < MAX_WARRIOR_LEVEL) {
          basicW.s(20, P.setVarint(f[2], 2, MAX_WARRIOR_LEVEL));
          raised = true;
        } else P.reencode(basicW, f[0], f[1], f[2]);
      });
      if (raised) {
        changes[DT_BASIC_INFO] = [this.setRow(DT_BASIC_INFO, '0', basicW.bytes())];
        changed = true;
      }
    }
    return changed ? changes : null;
  };

  MJ.userdata = {
    UserData: UserData, Module: Module,
    DT_NAMES: DT_NAMES,
    MODIFY: MODIFY, ADD: ADD, DELETE: DELETE,
    DT_BASIC_INFO: DT_BASIC_INFO, DT_HEAD: DT_HEAD,
    DT_MAHJONG_WARRIOR: DT_MAHJONG_WARRIOR,
    DT_MAHJONG_WARRIOR_SKIN: DT_MAHJONG_WARRIOR_SKIN,
    DT_SIGN_IN: DT_SIGN_IN, DT_PROFILE: DT_PROFILE
  };
})(typeof window !== 'undefined' ? window : globalThis);
