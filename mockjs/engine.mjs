import { tileId, decodeId, toRiichi, doraFromIndicator, buildWall, shuffle, tileName } from './tiles.mjs';
import { tileIndex, indexToTileId, countsOf, shantenOfCounts, waitsOfCounts, discardOptionsOfCounts } from './shanten.mjs';
import { normalizeAiLevel, resolveStyle, chooseDiscardByPolicy, shouldFoldHand, claimPolicy, riichiPolicy, createDecisionBudget } from './riichi_ai_policy.mjs';
import { kindOf, concealedStr, realMelds, furoGroupStr, furoStr, handStr, calcWin, handShanten, handWaits, chooseDiscard, pickIdFromHand, discardSecondaryScore } from './ai.mjs';
import { Result, RiichiMsg, PlayAction, ManType, YiType, LiuJuType } from './proto_enum.mjs';
import { mapYaku, manTypeFromResult } from './yaku_map.mjs';

var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var WIND_NAME = { 1: "E", 2: "S", 3: "W", 4: "N" };
/** Extra seconds the server waits past the player's own clock (base + bank). The client counts `defaultMinTimeout +
 *  leftTimer` and then sends its own timeout; without this allowance the server discards (or passes) at the same instant
 *  the client's clock ends, so a click at the visible deadline always arrives after the window closed.
 *  This allowance stays server-side only: the client renders `defaultMinTimeout − ServerRedundantTimeOut` as the base
 *  countdown but switches to the bank when the *announced* base ends, so announcing it would leave a visible stall. */
export var SERVER_REDUNDANT_TIMEOUT = 3;
var kindOf2 = (id) => {
  const d = decodeId(id);
  return d.suit * 10 + d.rank;
};
var GameEngine = class {
  constructor(opts = {}) {
    const {
      players = 4,
      akaCount = 1,
      startScore = 25e3,
      emit,
      seed
    } = opts;
    this.playersN = players;
    this.sanma = players === 3;
    this.akaCount = akaCount;
    this.startScore = startScore;
    this.emit = emit || (() => {
    });
    // Diagnostic sink: the host passes one (console + log file); without it every note() is a no-op.
    this.log = opts.log || null;
    this.debug = !!opts.debug;
    this.autoHuman = !!opts.autoHuman;
    this.selfLoveLevel = Number(opts.selfLoveLevel) || 0;
    // Shared policy with progressively reduced analysis: basic / intermediate / advanced.
    const levels = Array.isArray(opts.aiLevels) ? opts.aiLevels : [];
    this.aiLevels = Array.from({ length: players }, (_, seat) => normalizeAiLevel(levels[seat] ?? opts.aiLevel));
    this.speed = opts.speed != null ? opts.speed : 1;
    this.baseTime = opts.baseTime != null ? opts.baseTime : 5;
    this.extraTime = opts.extraTime != null ? opts.extraTime : 20;
    this.internalState = { 0: true, 1: false, 2: false, 3: false, 4: false, 5: false };
    this.setInternalState(opts.internalState || {});
    this.seed = seed != null ? Number(seed) >>> 0 : null;
    this.rng = this.seed != null ? mulberry32(this.seed) : Math.random;
    // NPC play styles per seat (null = neutral AI). Each styled seat gets its own RNG derived from the match seed,
    // so style noise never shifts the wall shuffle and a replay with the same seed and inputs repeats every decision.
    const styles = Array.isArray(opts.aiStyles) ? opts.aiStyles : [];
    this.aiStyles = Array.from({ length: players }, (_, seat) => styles[seat] || null);
    this._styleRngs = this.aiStyles.map((style, seat) => !style ? null
      : this.seed != null ? mulberry32((this.seed ^ Math.imul(0x9e3779b1, seat + 1)) >>> 0) : Math.random);
    this.handIndex = 0;
    this.juNum = 0;
    this.matchLength = opts.matchLength === "hanchan" ? "hanchan" : "east";
    this.regularWinds = this.matchLength === "hanchan" ? 2 : 1;
    this.maxHands = opts.maxHands != null ? opts.maxHands : this.matchLength === "hanchan" ? 64 : 32;
    this.roundWind = 1;
    this.honba = 0;
    this.renchanCount = 0;
    this.riichiSticks = 0;
    // First dealer (chiicha). The server draws it per match; ties are broken by seat order starting from this seat.
    const startDealer = Number(opts.startDealer);
    this.startDealer = Number.isInteger(startDealer) && startDealer >= 0 && startDealer < players ? startDealer : 0;
    this.dealerSeat = this.startDealer;
    this.scores = null;
    this.xunNum = 0;
    this._pending = null;
    this._humanClock = null;
    this._windowId = 0;
    this._processing = false; // Action-in-progress flag (prevents duplicate-packet replay)
    this._expectedDraw = null;
    this._expectedClaim = null;
    this._nextCantPlays = null;
    this._bufferedDraw = null;
    this._bufferedClaim = null;
    // Receipt of the last human window the server closed by timeout: { kind, payload }. See ackTimedOut().
    this._timedOut = null;
    this._prepareWaiter = null;
    this.matchOver = false;
    this.finished = false;
    this.onFinish = opts.onFinish || null;
    this.onFinalResult = opts.onFinalResult || null;
    this._finalResult = null;
    this.matchStats = { hands: 0, wins: 0, dealIns: 0, riichi: 0, calls: 0, tsumo: 0, ron: 0, winPoints: 0, winTurns: 0, maxRenchan: 0 };
    this.uids = opts.uids && opts.uids.length >= players ? opts.uids.slice(0, players) : Array.from({ length: players }, (_, s) => 1e4 + s);
    // Match record for crash/reload recovery: every resolved human wait, in order. Together with the seed and the table settings
    // it reproduces the whole match, because AI decisions and the wall depend only on the seed and the position.
    //   ['p']                    ready for the next hand (ReqPrepare or takeover)
    //   ['d'|'c', payload, bank] turn / claim decision as finally applied (client, auto setting or timeout) and the time bank after it
    this.humanLog = [];
    this.onRecord = opts.onRecord || null;
    this.onHumanClock = opts.onHumanClock || null;
    this.deferHumanClock = !!opts.deferHumanClock;
    // Replay: feed a saved log back at speed 0; when it runs out the engine goes live at the next human wait.
    this._replay = Array.isArray(opts.replayLog) && opts.replayLog.length ? opts.replayLog.slice() : null;
    this.replaying = !!opts.replayLog;
    this._liveSpeed = this.speed;
    if (this.replaying) this.speed = 0;
    this.onReplayDone = opts.onReplayDone || null;
    // false while the player is disconnected: the AI keeps playing, but human waits have no timeout (the table freezes on the player's turn).
    this.humanPresent = opts.humanPresent !== false;
  }
  _record(entry) {
    this.humanLog.push(entry);
    if (this.onRecord) this.onRecord(entry);
  }
  /** Take the next replay entry for a human wait of `kind`; ends the replay (and goes live) when the log is used up or diverges. */
  _replayNext(kind) {
    if (!this.replaying) return null;
    const next = this._replay?.[0];
    if (next && next[0] === kind) return this._replay.shift();
    if (next) this.log && this.log(`[riichi] record replay diverged: expected ${next[0]}, got ${kind}, continuing from current state`);
    this.replaying = false;
    this._replay = null;
    this.speed = this._liveSpeed;
    if (this.onReplayDone) this.onReplayDone(!next);
    return null;
  }
  /** Hosts gate only real disconnection and unfinished recovery, never page visibility. */
  setHumanPresent(present) {
    present = !!present;
    if (this.humanPresent === present) return;
    this.humanPresent = present;
    const pending = this._pending;
    if (!present) {
      this._freezeHumanClock();
      if (pending?.timer) { clearTimeout(pending.timer); pending.timer = null; }
    } else {
      if (this._humanClock?.ready && this._humanClock.runningSince == null && !this._bufferedDraw && !this._bufferedClaim) {
        this._humanClock.runningSince = Date.now();
      }
      if (pending && !pending.timer && !this.autoHuman) {
        this._armHumanTimer(pending);
        this._queueAutomatic(pending);
      }
    }
    this._publishHumanClock();
    this.note("clock", JSON.stringify({ event: present ? "resume" : "pause", ...this.humanTime() }));
  }
  _openHumanClock(kind, base = this.baseTime) {
    this._humanClock = {
      id: ++this._windowId, kind, base,
      bank: Number.isFinite(this.players[0].timeBank) ? this.players[0].timeBank : this.extraTime,
      ready: !this.deferHumanClock || this.autoHuman,
      elapsedMs: 0, runningSince: this.humanPresent && (!this.deferHumanClock || this.autoHuman) ? Date.now() : null,
    };
    this._publishHumanClock();
    this.note("clock", JSON.stringify({ event: "open", ...this.humanTime() }), true);
  }
  /** The native HUD, not the network announcement, defines when this decision is playable. */
  markHumanReady(id) {
    const clock = this._humanClock;
    if (!clock || clock.id !== id || clock.ready || !this.humanPresent || this.finished || this.replaying) return false;
    clock.ready = true;
    clock.runningSince = Date.now();
    this._publishHumanClock();
    if (this._pending && !this._pending.timer) this._armHumanTimer(this._pending);
    this.note("clock", JSON.stringify({ event: "playable", ...this.humanTime() }), true);
    return true;
  }
  _freezeHumanClock() {
    const clock = this._humanClock;
    if (clock?.runningSince != null) {
      clock.elapsedMs += Math.max(0, Date.now() - clock.runningSince);
      clock.runningSince = null;
      this._publishHumanClock();
    }
  }
  /** Millisecond projection for the host bridge; no network grace or rounded wire values. */
  humanClockState(now = Date.now()) {
    const clock = this._humanClock;
    if (!clock) return null;
    const time = this.humanTime(now);
    const baseMs = Math.max(0, clock.base * 1000 - time.elapsedMs);
    const totalMs = Math.max(0, (clock.base + clock.bank) * 1000 - time.elapsedMs);
    return { id: clock.id, baseMs, extraMs: totalMs - baseMs, running: clock.runningSince != null };
  }
  _publishHumanClock() {
    if (this.onHumanClock) this.onHumanClock(this.humanClockState());
  }
  /** One projection for notices, deadlines, bank accounting and reload; wire seconds round up. */
  humanTime(now = Date.now()) {
    const c = this._humanClock;
    if (!c) return { defaultMinTimeout: this.baseTime, leftTimer: Math.ceil(this.players?.[0]?.timeBank ?? this.extraTime) };
    const elapsedMs = c.elapsedMs + (c.runningSince == null ? 0 : Math.max(0, now - c.runningSince));
    const elapsed = elapsedMs / 1000;
    const baseLeft = Math.max(0, c.base - elapsed);
    const bankLeft = Math.max(0, c.bank - Math.max(0, elapsed - c.base));
    return { id: c.id, kind: c.kind, elapsedMs, bankLeft,
      defaultMinTimeout: Math.ceil(baseLeft), leftTimer: Math.ceil(bankLeft),
      timeoutMs: Math.max(0, (c.base + c.bank + SERVER_REDUNDANT_TIMEOUT) * 1000 - elapsedMs) };
  }
  uidOf(seat) {
    return this.uids[seat];
  }
  /** ReqPrepare only releases this hand's active wait; duplicates never authorize a future hand. */
  submitPrepare() {
    if (this._prepareWaiter) this._prepareWaiter();
  }
  /** Wait for the client to press "ready". Capture pattern (dongfeng1 full packets):
   *  Between hands (including renchan, isFinal=false) the server first sends NtfToPrepare/NtfPrepare (bots); the client sends
   *  ReqPrepare, then the server sends NtfPrepare (self)/NtfGameStart: one ReqPrepare wait per hand.
   *  After the final hand (isFinal=true) the engine simply stops; there is no two-step "continue and wait for ReqPrepare again" handshake;
   *  a new match is a newly matched room with a new engine (see finishHand).
   *  Install the wait before emitting NtfToPrepare so an immediate reply cannot be lost.
   *  autoHuman (self-test or takeover) skips directly; human mode never starts before the client is ready. */
  async waitPrepare() {
    // Keep prepare notices in the historical trace before declaring replay caught up.
    // Live waits are installed synchronously, before the client can reply to NtfToPrepare.
    if (this.replaying) await Promise.resolve();
    if (this.finished) return;
    if (this._replayNext("p")) {
      this._record(["p"]);
      return Promise.resolve();
    }
    if (this.autoHuman) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        if (this._prepareWaiter === fin) this._prepareWaiter = null;
        // A stopped engine (session ended) releases its waiter without the player being ready.
        if (!this.finished) this._record(["p"]);
        resolve();
      };
      this._prepareWaiter = fin;
    });
  }
  _d(ms) {
    return this.speed > 0 ? sleep(ms * this.speed) : Promise.resolve();
  }
  // Per-phase delays (ms, multiplied by speed)
  get T() {
    return { think: 550, claim: 350, step: 250, hand: 2500 };
  }
  // ================= Entry =================
  // ================= Diagnostics =================
  /** Live outcomes by default; replay, AI analysis and window bookkeeping are debug-only. */
  note(tag, text, detail = false) {
    if (!this.log || (!this.debug && (this.replaying || detail || tag === "ai" || tag === "claim"))) return;
    this.log(`[${tag}] ${this.handLabel ? this.handLabel + " " : ""}${text}`);
  }
  cardName(card) {
    return card ? tileName(card) : "-";
  }
  claimName(action) {
    if (action === PlayAction.Guo) return "pass";
    return action === PlayAction.Hu ? "ron" : action === PlayAction.MingGang ? "open kan" : action === PlayAction.Peng ? "pon" : action === PlayAction.Chi ? "chi" : "action" + action;
  }
  winText(win) {
    return win ? `${win.han || 0}han ${win.fu || 0}fu${win.name ? " " + win.name : ""}` : "?";
  }
  async start() {
    await this._d(400);
    while (!this.finished) {
      await this.runHand();
    }
    if (this.scores && this.onFinish) this.onFinish(this.scores);
  }
  // ================= One hand =================
  async runHand() {
    this.handEnded = false;
    this._expectedDraw = null;
    this._expectedClaim = null;
    this._timedOut = null;
    this._nextCantPlays = null;
    this.xunNum = 0;
    this.kanCount = 0;
    this.firstGoAround = true;
    this.lastDiscard = null;
    // Public discard log (including discards that were later called), recording only tile kinds and public attributes, for AI tile reading.
    this.discardLog = [];
    const { tiles, akaSet } = buildWall({ sanma: this.sanma, akaCount: this.akaCount });
    this.akaSet = akaSet;
    const wall = shuffle(tiles, this.rng);
    // Dead-wall size: 14 tiles for 4-player, 18 for 3-player (3-player North pull needs 8 rinshan tiles, so the dead wall is expanded to 18; dora indicators remain 5)
    const deadLen = this.sanma ? 18 : 14;
    const dead = wall.splice(wall.length - deadLen, deadLen);
    this.deadWall = dead;
    const rinLen = this.sanma ? 8 : 4;
    this.replacements = dead.slice(0, rinLen);
    // Initial dora indicator position: 4-player dead[4]; in 3-player the first 8 are rinshan, so dead[8] (both have 5 dora indicators, same layout)
    const baoBase = this.sanma ? 8 : 4;
    this.doraIndicators = [dead[baoBase]];
    this.uraIndicators = [dead[baoBase + 1]];
    this._pendingBaoPreCard = 0;
    this._deferredKanDora = 0;
    this.wall = wall;
    this.remain = wall.length;
    const players = [];
    for (let s = 0; s < this.playersN; s++) {
      const score = this.scores ? this.scores[s] : this.startScore;
      players.push({
        seat: s,
        isHuman: s === 0,
        score,
        scoreAtStart: score,
        timeBank: s === 0 ? this.extraTime : 0,
        baoPaiWin: false,
        hand: wall.splice(0, 13).sort((a, b) => a - b),
        melds: [],
        discards: [],
        discardClaimed: false,
        discardKinds: /* @__PURE__ */ new Set(),
        riichi: false,
        doubleRiichi: false,
        riichiTurn: -1,
        riichiPending: false,
        ippatsu: false,
        menzen: true,
        waits: [],
        tempFuriten: false,
        riichiFuriten: false,
        pao: {},
        drawnTile: null,
        rinshan: false
      });
    }
    this.players = players;
    for (const p of players) this.updateWaits(p);
    this.handLabel = `${WIND_NAME[this.roundWind]}${this.juNum + 1}-${this.honba}`;
    const emptyInfos = players.map(() => ({}));
    const prepared = this.waitPrepare();
    this.emit(RiichiMsg.ENtfToPrepare, {
      userInfos: players.map((p) => ({ seat: p.seat, userID: this.uidOf(p.seat) }))
    });
    for (let s = 1; s < this.playersN; s++) {
      this.emit(RiichiMsg.ENtfPrepare, { seat: s, userInfos: emptyInfos });
    }
    await prepared;
    if (this.finished) return;
    this.note("hand", `hand start, dealer P${this.dealerSeat} scores[${players.map((p) => p.score).join(",")}] riichi sticks ${this.riichiSticks} dora ${this.cardName(this.doraIndicators[0])} wall ${this.remain}`);
    this.emit(RiichiMsg.ENtfPrepare, { seat: 0, userInfos: emptyInfos });
    await this._d(this.T.step);
    const dealer = players[this.dealerSeat];
    const firstTile = this.wall.shift();
    this.remain = this.wall.length;
    dealer.hand.push(firstTile);
    dealer.drawnTile = firstTile;
    dealer.rinshan = false;
    this.xunNum = 1;
    const dealerActions = this.turnActions(this.dealerSeat, true);
    // Every hand (including renchan): dealer's opening decision has 8 base seconds.
    // Keep the normal per-decision default at 5; the bridge/reload read this window's base.
    this.expectDraw(this.dealerSeat, true, dealerActions, [], this.baseTime + 3);
    this.emit(RiichiMsg.ENtfGameStart, {
      changWind: this.roundWind - 1,
      juNum: this.juNum + 1,
      // The real client is 1-based (East = 1); internally it stays 0-based
      benChangNum: this.honba,
      zhuangSeat: this.dealerSeat,
      baoPreCard: this.doraIndicators[0],
      remainDuiCardNum: this.remain,
      userInfos: players.map((p) => {
        const own = p.isHuman || this.autoHuman;
        const isDealer = p.seat === this.dealerSeat;
        return {
          seat: p.seat,
          score: p.score,
          initScore: this.startScore,
          handCards: own ? p.hand.slice() : [],
          tingInfos: [],
          canPlayActions: own && isDealer ? dealerActions : [],
          xunNum: isDealer ? 1 : 0
        };
      }),
      leftTimer: this._humanClock ? this.humanTime().leftTimer : this.extraTime,
      // The client's clock for a turn is `defaultMinTimeout + leftTimer` (base phase, then the shared bank), so leftTimer
      // carries the bank only; adding the base here would count it twice and the server would cut the turn off early.
      defaultMinTimeout: this.baseTime,
      riichiBangNum: this.riichiSticks,
      isAllLast: this.isAllLast(),
      gameID: "mock-" + Date.now() + "-" + this.handIndex,
      duiCardsStrEncode: "",
      duiCardsStrSaltEncode: "",
      ServerRedundantTimeOut: 0,
      FirstGameStartRedundantTimeOut: 0
    });
    await this._d(this.T.step);
    await this.awaitTurn(this.dealerSeat, true, true);
  }
  nextSeat(s) {
    return (s + 1) % this.playersN;
  }
  /** Seat order counted from the first dealer (0 = chiicha); breaks score ties. */
  startOrder(seat) {
    return (seat - this.startDealer + this.playersN) % this.playersN;
  }
  seatWindOf(seat) {
    return ((seat - this.dealerSeat) % this.playersN + this.playersN) % this.playersN + 1;
  }
  isAllLast() {
    if (this.maxHands === 1) return true;  // A one-round match plays a single hand and starts directly at All Last
    return this.roundWind > this.regularWinds || this.roundWind === this.regularWinds && this.juNum === this.playersN - 1;
  }
  // ================= Draw =================
  async turnDraw(seat) {
    if (this.handEnded) return;
    if (this.remain <= 0) {
      await this.exhaustiveDraw();
      return;
    }
    const p = this.players[seat];
    p.tempFuriten = false;
    const tile = this.wall.shift();
    this.remain = this.wall.length;
    p.hand.push(tile);
    p.drawnTile = tile;
    p.rinshan = false;
    this.xunNum++;
    this.note("draw", `P${seat} draw ${this.cardName(tile)} wall ${this.remain}`, true);
    await this.awaitTurn(seat, true);
  }
  // Rinshan draw (after a kan)
  async drawReplacement(seat) {
    const p = this.players[seat];
    p.tempFuriten = false;
    if (!this.replacements.length || this.remain <= 0) {
      await this.exhaustiveDraw();
      return false;
    }
    const tile = this.replacements.pop();
    this.wall.pop();
    this.remain = this.wall.length;
    p.hand.push(tile);
    p.drawnTile = tile;
    p.rinshan = true;
    this.xunNum++;
    this.note("draw", `P${seat} rinshan draw ${this.cardName(tile)} wall ${this.remain}`, true);
    return true;
  }
  async doBaBei(seat, tile) {
    const p = this.players[seat];
    const canQiang = this.players.map((player) => {
      if (player.seat === seat || !this.canRon(player, tile)) return [];
      return [PlayAction.Hu, PlayAction.Guo];
    });
    this.expectClaim(0, seat, tile, canQiang[0] || []);
    this.emit(RiichiMsg.ENtfPlayCard, this.buildPlayCard(seat, tile, PlayAction.BaBei, false, canQiang));
    await this._d(this.T.claim);
    if (await this.resolveKanRob(seat, tile, canQiang, {})) return;
    // Nobody robbed the North: close the claim window like any other quiet window.
    await this.closeEmptyClaimWindow();

    p.hand.splice(p.hand.indexOf(tile), 1);
    p.melds.push({ type: "babei", tiles: [tile] });
    for (const player of this.players) player.ippatsu = false;
    this.firstGoAround = false;
    if (!await this.drawReplacement(seat)) return;
    await this.awaitTurn(seat, true);
  }
  expectDraw(seat, drew, actions, cantPlays = [], base = this.baseTime) {
    if (this.autoHuman || !this.players[seat]?.isHuman) {
      this._expectedDraw = null;
      return;
    }
    this._processing = false;
    if (this._timedOut?.kind === "draw") this._timedOut = null;
    this._expectedDraw = { seat, drew, actions: actions.slice(), cantPlays: cantPlays.slice() };
    this._openHumanClock("draw", base);
  }
  validateTurnPayload(payload, expected = this._expectedDraw) {
    if (!expected || !this.players?.[expected.seat]) return Result.Fail_InvalidSequence;
    const p = this.players[expected.seat];
    const action = Number(payload?.action);
    const card = Number(payload?.card);
    if (!Number.isInteger(action)) return Result.Fail_InvalidParam;
    if (!expected.actions.includes(action)) return Result.Fail_ActionNotInCanPlayActions;
    if (action === PlayAction.Hu || action === PlayAction.JiuZhongJiuLiuJu) return Result.Succ;

    if (!Number.isInteger(card) || !p.hand.includes(card)) return Result.Fail_CardNotInHand;
    if (expected.cantPlays.includes(kindOf2(card) * 10)) return Result.Fail_CardInCantPlays;

    if (action === PlayAction.Riichi) {
      const hand = p.hand.slice();
      hand.splice(hand.indexOf(card), 1);
      if (!this.isFormalTenpaiHand(hand, p.melds)) return Result.Fail_RiichiPlayCardWrong;
    }
    if (action === PlayAction.AnGang) {
      const allowed = this.concealedQuadTiles(p).some((tile) => kindOf2(tile) === kindOf2(card));
      if (!allowed) return Result.Fail_CardNotMatchAction;
    }
    if (action === PlayAction.PengGang) {
      const matchesPon = p.melds.some((meld) => meld.type === "pon" && kindOf2(meld.tiles[0]) === kindOf2(card));
      if (!matchesPon) return Result.Fail_CardNotMatchAction;
    }
    if (action === PlayAction.BaBei) {
      const { suit, rank } = decodeId(card);
      if (suit !== 4 || rank !== 4 || p.riichi && card !== p.drawnTile) return Result.Fail_CardNotMatchAction;
    }
    if (action === PlayAction.Normal && p.riichi && p.riichiTurn !== this.xunNum && card !== p.drawnTile) {
      return Result.Fail_CardNotMatchAction;
    }
    return Result.Succ;
  }
  expectClaim(seat, discarderSeat, card, actions) {
    if (this.autoHuman || !this.players[seat]?.isHuman || !actions?.length) {
      this._expectedClaim = null;
      return;
    }
    this._processing = false;
    if (this._timedOut?.kind === "claim") this._timedOut = null;
    this._expectedClaim = { seat, discarderSeat, card, actions: actions.slice() };
    this._openHumanClock("claim");
    this.note("claim", `open call window P${seat} can call[${actions.map((act) => this.claimName(act)).join("/")}] from P${discarderSeat}'s ${this.cardName(card)}`);
  }
  validateClaimPayload(payload, expected = this._expectedClaim) {
    if (!expected || !this.players?.[expected.seat]) return Result.Fail_InvalidSequence;
    const action = Number(payload?.action);
    if (!Number.isInteger(action)) return Result.Fail_InvalidParam;
    if (!expected.actions.includes(action)) return Result.Fail_ActionNotInCanQiangActions;
    if (action === PlayAction.Guo || action === PlayAction.Hu) return Result.Succ;

    const p = this.players[expected.seat];
    const otherCards = Array.isArray(payload?.otherCards) ? payload.otherCards.map(Number) : [];
    const needed = action === PlayAction.MingGang ? 3 : 2;
    if (otherCards.length !== needed || new Set(otherCards).size !== otherCards.length || otherCards.some((tile) => !p.hand.includes(tile))) {
      return Result.Fail_InvalidOtherCards;
    }
    const claimedKind = kindOf2(expected.card);
    if (action === PlayAction.Peng || action === PlayAction.MingGang) {
      return otherCards.every((tile) => kindOf2(tile) === claimedKind) ? Result.Succ : Result.Fail_InvalidOtherCards;
    }
    if (action === PlayAction.Chi) {
      if (this.sanma || expected.seat !== this.nextSeat(expected.discarderSeat)) return Result.Fail_InvalidOtherCards;
      const all = [...otherCards, expected.card].map(decodeId);
      if (all.some((tile) => tile.suit === 4 || tile.suit !== all[0].suit)) return Result.Fail_InvalidOtherCards;
      const ranks = all.map((tile) => tile.rank).sort((a, b) => a - b);
      const isSequence = ranks[0] + 1 === ranks[1] && ranks[1] + 1 === ranks[2];
      return isSequence && this.canDiscardAfterClaim(p, action, expected.card, otherCards) ? Result.Succ : Result.Fail_InvalidOtherCards;
    }
    return Result.Fail_ActionNotInCanQiangActions;
  }
  // ================= Act on a seat's turn (14 tiles in hand) =================
  async awaitTurn(seat, drew, skipNotify) {
    if (this.handEnded) return;
    const p = this.players[seat];
    if (drew && this.isAiSeat(p) && this.canJiuZhongJiuPai(p)) {
      await this.abortiveDraw(LiuJuType.JiuZhongJiuPai, seat);
      return;
    }
    const can = this.turnActions(seat, drew);
    const cantPlays = this._nextCantPlays?.seat === seat ? this._nextCantPlays.values : [];
    this._nextCantPlays = null;
    if (!this._expectedDraw && this._bufferedDraw == null) this.expectDraw(seat, drew, can, cantPlays);
    if (drew && !skipNotify) {
      const newBao = this._pendingBaoPreCard || 0;
      this._pendingBaoPreCard = 0;
      this.emit(RiichiMsg.ENtfSendCard, {
        seat,
        baoPreCard: newBao,
        userInfos: this.players.map((q) => ({
          seat: q.seat,
          card: q.seat === seat && (q.isHuman || this.autoHuman) ? p.drawnTile : 0,
          tingInfos: q.seat === seat ? this.buildTingInfos(p) : q.isHuman ? this.buildTingInfos(q) : [],
          canPlayActions: q.seat === seat ? can : [],
          leftTimer: q.isHuman ? this.humanTime().leftTimer : 0,
          isZhenTing: this.isFuriten(q),
          xunNum: this.xunNum,
          zhenTingTypes: this.furitenTypes(q)
        }))
      });
      await this._d(this.T.think);
    }
    let action, card;
    const useHumanInput = !this.isAiSeat(p) || this._bufferedDraw != null;
    if (useHumanInput) {
      if (!this._expectedDraw && this._bufferedDraw == null) this.expectDraw(seat, drew, can, cantPlays);
      this._processing = false; // About to wait for human input; legal early-arriving responses may be cached
      const payload = await this.waitHuman("draw");
      action = payload.action != null ? payload.action : PlayAction.Normal;
      card = payload.card != null ? payload.card : p.drawnTile;
    } else {
      this._expectedDraw = null;
      const d = this.aiTurn(seat, drew, can, cantPlays);
      action = d.action;
      card = d.card;
      await this._d(this.T.think);
    }
    const result = await this.processTurnAction(seat, action, card, drew, cantPlays);
    if (result !== Result.Succ) throw new Error(`invalid internal action seat=${seat} action=${action} result=${result}`);
  }
  // Optional actions with 14 tiles in hand
  turnActions(seat, drew) {
    const p = this.players[seat];
    const acts = [PlayAction.Normal];
    if (drew && this.canTsumo(p)) acts.push(PlayAction.Hu);
    if (drew && !p.riichi && p.menzen && this.canRiichi(p)) acts.push(PlayAction.Riichi);
    if (drew && this.kanCount < 4 && this.remain > 1) {
      if (this.concealedQuadTile(p) != null) acts.push(PlayAction.AnGang);
      if (!p.riichi && this.addedKanTile(p) != null) acts.push(PlayAction.PengGang);
    }
    if (drew && !this.isAiSeat(p) && this.canJiuZhongJiuPai(p)) acts.push(PlayAction.JiuZhongJiuLiuJu);
    if (drew && this.sanma && this.northInHand(p) != null && this.replacements.length && this.remain > 1) {
      acts.push(PlayAction.BaBei);
    }
    return acts;
  }
  // North in hand (used for 3-player North pull); returns null if there is none
  northInHand(p) {
    if (p.riichi) {
      const tile = p.drawnTile;
      if (tile == null || !p.hand.includes(tile)) return null;
      const drawn = decodeId(tile);
      return drawn.suit === 4 && drawn.rank === 4 ? tile : null;
    }
    for (const t of p.hand) {
      const d = decodeId(t);
      if (d.suit === 4 && d.rank === 4) return t;
    }
    return null;
  }
  countYaoJiuKinds(p) {
    const s = /* @__PURE__ */ new Set();
    for (const t of p.hand) {
      const { suit, rank } = decodeId(t);
      if (suit === 4 || rank === 1 || rank === 9) s.add(suit * 10 + rank);
    }
    return s.size;
  }
  // Whether this seat is operated by the AI (autoHuman is for testing: it also hands the seat-0 human to the AI)
  isAiSeat(p) {
    return !p.isHuman || this.autoHuman;
  }
  // Kyuushu kyuuhai (nine kinds of terminals/honors) conditions: still in the first go-around (any call, including chi/pon/kan and North pull, sets firstGoAround to false)
  // and the hand just drawn holds ≥9 kinds of terminals/honors. When met, humans may choose it and the AI declares it automatically.
  canJiuZhongJiuPai(p) {
    return this.firstGoAround && this.countYaoJiuKinds(p) >= 9;
  }
  canRiichi(p) {
    if (!p.menzen || p.riichi) return false;
    if (p.score < 1e3) return false;
    if (this.remain < this.playersN) return false;
    return this.formalTenpaiDiscards(p).length > 0;
  }
  canTsumo(p) {
    const w = calcWin(p.hand, p.melds, this.akaSet, this.winOpts(p, false));
    return w.isAgari && w.hasYaku;
  }
  concealedQuadTiles(p) {
    const counts = new Map();
    for (const tile of p.hand) counts.set(kindOf2(tile), (counts.get(kindOf2(tile)) || 0) + 1);
    const quads = [...counts.entries()]
      .filter(([, count]) => count === 4)
      .map(([kind]) => p.hand.find((tile) => kindOf2(tile) === kind));
    if (!p.riichi) return quads;
    if (p.drawnTile == null) return [];
    const drawnKind = kindOf2(p.drawnTile);
    return quads.filter((tile) => kindOf2(tile) === drawnKind && this.riichiAnkanKeepsWaits(p, drawnKind));
  }
  concealedQuadTile(p) {
    return this.concealedQuadTiles(p)[0] ?? null;
  }
  sameWaitKinds(left, right) {
    return left.length === right.length && left.every((kind, index) => kind === right[index]);
  }
  riichiAnkanKeepsWaits(p, quadKind) {
    const before = p.hand.slice();
    const drawnIndex = before.indexOf(p.drawnTile);
    if (drawnIndex < 0) return false;
    before.splice(drawnIndex, 1);
    const beforeWaits = handWaits(before, p.melds).waitKinds.slice().sort((a, b) => a - b);
    const after = p.hand.filter((tile) => kindOf2(tile) !== quadKind);
    const placeholder = p.hand.find((tile) => kindOf2(tile) === quadKind);
    const afterWaits = handWaits(after, p.melds.concat([{ type: "ankan", tiles: [placeholder, placeholder, placeholder, placeholder] }])).waitKinds.slice().sort((a, b) => a - b);
    return this.sameWaitKinds(beforeWaits, afterWaits);
  }
  riichiFutureAnkanKinds(p) {
    if (!p.riichi || p.hand.length % 3 !== 1) return [];
    const beforeWaits = handWaits(p.hand, p.melds).waitKinds.slice().sort((a, b) => a - b);
    const counts = new Map();
    for (const tile of p.hand) counts.set(kindOf2(tile), (counts.get(kindOf2(tile)) || 0) + 1);
    const result = [];
    for (const [kind, count] of counts) {
      if (count !== 3) continue;
      const after = p.hand.filter((tile) => kindOf2(tile) !== kind);
      const placeholder = p.hand.find((tile) => kindOf2(tile) === kind);
      const afterWaits = handWaits(after, p.melds.concat([{ type: "ankan", tiles: [placeholder, placeholder, placeholder, placeholder] }])).waitKinds.slice().sort((a, b) => a - b);
      if (this.sameWaitKinds(beforeWaits, afterWaits)) result.push(kind * 10);
    }
    return result;
  }
  // Added kan: the hand has a tile of the same kind as an already-ponned triplet
  addedKanTile(p) {
    for (const m of p.melds) {
      if (m.type !== "pon") continue;
      const k = kindOf2(m.tiles[0]);
      const t = p.hand.find((x) => kindOf2(x) === k);
      if (t != null) return t;
    }
    return null;
  }
  // Set of tile kinds of the table dora (for the AI to keep dora)
  doraKinds() {
    const s = /* @__PURE__ */ new Set();
    for (const ind of this.doraIndicators) s.add(kindOf2(doraFromIndicator(ind, this.sanma)));
    return s;
  }
  // Tiles already public on the table (discard rivers + melds + dora indicators)
  visibleCounts() {
    const c = new Array(34).fill(0);
    const add = (id) => {
      const i = tileIndex(id);
      if (i >= 0) c[i]++;
    };
    for (const q of this.players) {
      for (const t of q.discards) add(t);
      for (const m of q.melds) for (const t of m.tiles) add(t);
    }
    for (const t of this.doraIndicators) add(t);
    return c;
  }
  // From one seat's viewpoint, how many copies of a tile kind remain (used for the ukeire count)
  remainOfFor(p) {
    const vis = this.visibleCounts();
    const own = countsOf(p.hand);
    const total = (idx) => this.sanma && idx >= 1 && idx <= 7 ? 0 : 4;
    return (idx) => total(idx) - vis[idx] - own[idx];
  }
  // Unified discard-evaluation entry point
  bestDiscard(p, extra = {}) {
    return chooseDiscard(p.hand, p.melds, {
      drawnTile: p.drawnTile,
      doraKinds: this.doraKinds(),
      akaSet: this.akaSet,
      remainOf: this.remainOfFor(p),
      ...extra
    });
  }
  doraTilesFor(p) {
    const out = this.doraIndicators.map((i) => doraFromIndicator(i, this.sanma));
    if (p.riichi) out.push(...this.uraIndicators.map((i) => doraFromIndicator(i, this.sanma)));
    return out;
  }
  winOpts(p, isRon, ronTile = null) {
    return {
      ronTile: isRon ? ronTile : null,
      riichi: p.riichi,
      doubleRiichi: p.doubleRiichi,
      ippatsu: p.riichi && p.ippatsu,
      tenho: !isRon && this.firstGoAround && p.discards.length === 0,
      rinshan: !isRon && p.rinshan,
      haidi: this.remain <= 0 && (isRon || !p.rinshan),
      doraTiles: this.doraTilesFor(p),
      roundWind: this.roundWind,
      seatWind: this.seatWindOf(p.seat)
    };
  }
  // Update tenpai info at 13 tiles (waits stores tile-kind codes)
  updateWaits(p) {
    if (p.hand.length % 3 !== 1) return;
    const info = handWaits(p.hand, p.melds);
    p.shanten = info.shanten;
    p.waits = info.shanten === 0 ? info.waitKinds : [];
    p.waitTiles = info.shanten === 0 ? info.waits : [];
  }
  isFormalTenpaiHand(hand, melds) {
    const info = handWaits(hand, melds);
    if (info.shanten !== 0 || !info.waitKinds.length) return false;
    // Own melds also count as part of the hand shape: a fourth tile in hand must not be mistaken for a fifth waiting tile.
    // An empty wait is still allowed when others' revealed tiles or our own discards have exhausted the waits; it is not excluded here.
    const ownTiles = hand.concat(realMelds(melds).flatMap((meld) => meld.tiles));
    return info.waitKinds.some((kind) => ownTiles.filter((tile) => kindOf2(tile) === kind).length < 4);
  }
  formalTenpaiDiscards(p) {
    if (p.hand.length % 3 !== 2) return [];
    const result = [];
    const seen = new Set();
    for (const tile of p.hand) {
      const kind = kindOf2(tile);
      if (seen.has(kind)) continue;
      seen.add(kind);
      const hand = p.hand.slice();
      hand.splice(hand.indexOf(tile), 1);
      if (this.isFormalTenpaiHand(hand, p.melds)) result.push(kind);
    }
    return result;
  }
  isTenpai(p) {
    if (p.hand.length % 3 === 1) return this.isFormalTenpaiHand(p.hand, p.melds);
    return this.formalTenpaiDiscards(p).length > 0;
  }
  selfFuriten(p) {
    return !!p.waits?.length && p.waits.some((kind) => p.discardKinds.has(kind));
  }
  isFuriten(p) {
    return this.selfFuriten(p) || !!p.tempFuriten || !!p.riichiFuriten;
  }
  furitenTypes(p) {
    const types = [];
    if (p.riichiFuriten) types.push(0);
    if (p.tempFuriten) types.push(1);
    if (this.selfFuriten(p)) types.push(2);
    return types;
  }
  markPassedRon(p) {
    if (p.riichi) p.riichiFuriten = true;
    else p.tempFuriten = true;
  }
  confirmRiichiDeclaration(p) {
    if (p?.riichiPending) p.riichiPending = false;
  }
  rollbackRiichiDeclaration(p) {
    if (!p?.riichiPending) return;
    p.riichi = false;
    p.doubleRiichi = false;
    p.riichiPending = false;
    p.riichiTurn = -1;
    p.ippatsu = false;
    p.score += 1e3;
    this.riichiSticks = Math.max(0, this.riichiSticks - 1);
  }
  // Tenpai hints: discard which tile -> wait on which tiles.
  //
  // Encoding trap: tingInfos.play / ting use the tile-kind encoding (the copy bit is fixed at 0);
  // real-machine samples: play=380 (3s), ting=210 (1p), play=110 (1m), all ending in 0.
  // Other fields (handCards / NtfPlayCard.card / baoPreCard …) are full tile IDs with the copy bit.
  // Previously this sent full IDs with copy=1 (381/211); the client looks up by tile kind and could not match them,
  // so the result was "tenpai reached, but no tenpai indicator and no tenpai hint shown".
  buildTingInfos(p, playedTile = null) {
    if (p.hand.length % 3 === 1) {
      // 13-tile shape (just discarded, or waiting through other seats' turns): report the waits already achieved.
      // Sending an empty list here clears the client's tenpai panel, which is what made the hint blink off between turns.
      const info = handWaits(p.hand, p.melds);
      if (info.shanten !== 0 || !info.waitKinds.length) return [];
      const play = playedTile == null ? 0 : kindOf2(playedTile) * 10;
      return info.waitKinds.map((kind) => {
        const tingTile = kind * 10;
        const wMo = calcWin(p.hand.concat([tingTile]), p.melds, this.akaSet, this.winOpts(p, false));
        const wRong = calcWin(p.hand, p.melds, this.akaSet, this.winOpts(p, true, tingTile));
        return {
          play,
          ting: tingTile,
          hasYiWhenMo: wMo.hasYaku,
          yiManChance: 0,
          fanFuTypeWhenMo: 0,
          hasYiWhenRong: wRong.hasYaku,
          manType: 0
        };
      }).slice(0, 60);
    }
    if (p.hand.length % 3 !== 2) return [];
    const { shanten: sh, options } = discardOptionsOfCounts(
      countsOf(p.hand),
      realMelds(p.melds).length,
      this.remainOfFor(p)
    );
    if (sh !== 0) return [];
    const out = [];
    for (const o of options) {
      const playTile = p.hand.find((t) => tileIndex(t) === o.idx);
      if (!playTile) continue;
      const play = indexToTileId(o.idx, 0);
      const hand13 = p.hand.slice();
      hand13.splice(hand13.indexOf(playTile), 1);
      if (!this.isFormalTenpaiHand(hand13, p.melds)) continue;
      for (const wIdx of o.waits) {
        const tingTile = indexToTileId(wIdx, 0);
        const hand14 = hand13.concat([tingTile]);
        const wMo = calcWin(hand14, p.melds, this.akaSet, this.winOpts(p, false));
        const wRong = calcWin(hand13, p.melds, this.akaSet, this.winOpts(p, true, tingTile));
        out.push({
          play,
          ting: tingTile,
          hasYiWhenMo: wMo.hasYaku,
          yiManChance: 0,
          fanFuTypeWhenMo: 0,
          hasYiWhenRong: wRong.hasYaku,
          manType: 0
        });
      }
    }
    return out.slice(0, 60);
  }
  // ================= Handle actions =================
  async processTurnAction(seat, action, card, drew, cantPlays = []) {
    const p = this.players[seat];
    const result = this.validateTurnPayload(
      { action, card },
      { seat, drew, actions: this.turnActions(seat, drew), cantPlays }
    );
    if (result !== Result.Succ) return result;

    this._processing = true;
    this._bufferedDraw = null;
    this._bufferedClaim = null;
    if (action === PlayAction.Hu) {
      await this.winTsumo(seat);
      return Result.Succ;
    }
    if (action === PlayAction.JiuZhongJiuLiuJu) {
      await this.abortiveDraw(LiuJuType.JiuZhongJiuPai, seat);
      return Result.Succ;
    }
    if (action === PlayAction.AnGang) {
      await this.doKan(seat, card, "ankan");
      return Result.Succ;
    }
    if (action === PlayAction.PengGang) {
      await this.doKan(seat, card, "kakan");
      return Result.Succ;
    }
    if (action === PlayAction.BaBei) {
      await this.doBaBei(seat, card);
      return Result.Succ;
    }
    if (action === PlayAction.Riichi) {
      p.riichi = true;
      p.doubleRiichi = this.firstGoAround && p.discards.length === 0;
      p.riichiTurn = this.xunNum;
      p.riichiPending = true;
      p.ippatsu = true;
      p.score -= 1e3;
      this.riichiSticks += 1;
      this.note("riichi", `P${seat} riichi${p.doubleRiichi ? "(double riichi)" : ""} discard ${this.cardName(card)} score ${p.score}`);
    }
    const idx = p.hand.lastIndexOf(card);
    p.hand.splice(idx, 1);
    p.hand.sort((a, b) => a - b);
    this.discardLog?.push({ seat, kind: kindOf2(card), tsumogiri: p.drawnTile === card, riichi: action === PlayAction.Riichi });
    p.discards.push(card);
    p.discardKinds.add(kindOf2(card));
    this.updateWaits(p);
    this.lastDiscard = { seat, card };
    if (p.ippatsu && p.riichiTurn !== this.xunNum) p.ippatsu = false;
    await this.discard(seat, card, action);
    return Result.Succ;
  }
  emptyClaims() {
    return this.players.map(() => []);
  }
  async discard(seat, card, action) {
    const p = this.players[seat];
    const isMoQie = p.drawnTile === card;
    p.drawnTile = null;
    p.rinshan = false;
    this.flushDeferredKanDora();
    const canQiang = this.players.map((q) => q.seat === seat ? [] : this.claimActions(q.seat, seat, card));
    const canText = canQiang.map((acts, s) => acts.filter((act) => act !== PlayAction.Guo).length ? `P${s}:${acts.filter((act) => act !== PlayAction.Guo).map((act) => this.claimName(act)).join("/")}` : null).filter(Boolean).join(" ") || "none";
    this.note("discard", `P${seat} discard ${this.cardName(card)}${isMoQie ? "(tsumogiri)" : ""}${action === PlayAction.Riichi ? "(riichi)" : ""} wall ${this.remain} can call ${canText}`);
    this.expectClaim(0, seat, card, canQiang[0] || []);
    this.emit(RiichiMsg.ENtfPlayCard, this.buildPlayCard(seat, card, action, isMoQie, canQiang));
    await this._d(this.T.claim);
    await this.resolveClaims(seat, card, canQiang);
  }
  checkSiFengLianDa() {
    if (!this.firstGoAround) return false;
    const n = this.playersN;
    if (n !== 4) return false;
    const firsts = this.players.map((p) => p.discards[0]);
    if (firsts.some((t) => t == null)) return false;
    if (this.players.some((p) => p.discards.length !== 1 || p.melds.length)) return false;
    const kinds = firsts.map(kindOf2);
    return kinds.every((k) => k >= 41 && k <= 44 && k === kinds[0]);
  }
  buildPlayCard(seat, card, action, isMoQie, canQiang) {
    return {
      seat,
      card,
      action,
      isMoQie,
      userInfos: this.players.map((q) => ({
        seat: q.seat,
        canQiangActions: canQiang[q.seat] || [],
        isZhenTing: this.isFuriten(q),
        leftTimer: q.isHuman ? Math.ceil(q.timeBank) : 0,
        canAnGangNoNumCardsAfterRiichi: this.riichiFutureAnkanKinds(q),
        // The tenpai panel is refreshed from every userInfos block, so the human's waits must ride along here too.
        tingInfos: q.isHuman ? this.buildTingInfos(q, card) : [],
        zhenTingTypes: this.furitenTypes(q)
      }))
    };
  }
  // ================= Calls =================
  claimActions(seat, discarderSeat, card) {
    const p = this.players[seat];
    const acts = [];
    if (this.canRon(p, card)) acts.push(PlayAction.Hu);
    if (!p.riichi) {
      const cnt = p.hand.filter((t) => kindOf2(t) === kindOf2(card)).length;
      if (cnt >= 3 && this.kanCount < 4 && this.remain > 1) acts.push(PlayAction.MingGang);
      if (cnt >= 2 && this.remain > 0) acts.push(PlayAction.Peng);
      if (!this.sanma && seat === this.nextSeat(discarderSeat) && this.remain > 0) {
        if (this.chiTiles(p, card)) acts.push(PlayAction.Chi);
      }
    }
    if (acts.length) acts.push(PlayAction.Guo);
    return acts;
  }
  canRon(p, card, extra = {}) {
    if (!p.waits || !p.waits.includes(kindOf2(card))) return false;
    if (this.isFuriten(p)) return false;
    const w = calcWin(p.hand, p.melds, this.akaSet, { ...this.winOpts(p, true, card), ...extra });
    return w.isAgari && w.hasYaku;
  }
  canDiscardAfterClaim(p, action, card, used) {
    const forbidden = this.kuikaeKinds(action, [...used, card], card);
    return p.hand.some((tile) => !used.includes(tile) && !forbidden.has(kindOf2(tile)));
  }
  chiOptions(p, card) {
    const { suit, rank } = decodeId(card);
    if (suit === 4) return [];
    const options = [];
    const combos = [[rank - 2, rank - 1], [rank - 1, rank + 1], [rank + 1, rank + 2]];
    for (const [leftRank, rightRank] of combos) {
      if (leftRank < 1 || leftRank > 9 || rightRank < 1 || rightRank > 9) continue;
      const left = p.hand.find((tile) => {
        const decoded = decodeId(tile);
        return decoded.suit === suit && decoded.rank === leftRank;
      });
      if (left == null) continue;
      const right = p.hand.find((tile) => {
        const decoded = decodeId(tile);
        return tile !== left && decoded.suit === suit && decoded.rank === rightRank;
      });
      if (right != null && this.canDiscardAfterClaim(p, PlayAction.Chi, card, [left, right])) options.push([left, right]);
    }
    return options;
  }
  chiTiles(p, card) {
    return this.chiOptions(p, card)[0] || null;
  }
  async resolveClaims(discarderSeat, card, canQiang) {
    const all = [];
    let humanHandled = false;
    const humanCanClaim = this.players[0].isHuman && canQiang[0]?.length;
    if (humanCanClaim && (!this.isAiSeat(this.players[0]) || this._bufferedClaim != null)) {
      if (!this._expectedClaim && this._bufferedClaim == null) this.expectClaim(0, discarderSeat, card, canQiang[0]);
      const payload = await this.waitHuman("claim");
      humanHandled = true;
      if (payload?.action != null && payload.action !== PlayAction.Guo) {
        all.push({ seat: 0, action: payload.action, otherCards: payload.otherCards || [] });
      } else {
        // The client only closes its own claim buttons on NtfQiangCard{seat: me, action: Guo|Hu}.
        // A window that ends silently leaves them on screen until something else closes them, so a
        // pass (explicit or by timeout) has to be announced.
        this.emit(RiichiMsg.ENtfQiangCard, this.buildQiang(0, PlayAction.Guo, []));
      }
    } else {
      this._expectedClaim = null;
    }
    for (let seat = 0; seat < this.playersN; seat++) {
      if (seat === 0 && (humanHandled || !this.isAiSeat(this.players[0]))) continue;
      if (!canQiang[seat]?.length) continue;
      const claim = this.aiClaim(seat, discarderSeat, card, canQiang[seat]);
      if (claim) all.push({ seat, ...claim });
    }
    this.note("claim", `P${discarderSeat} discard ${this.cardName(card)} candidates ${all.map((c) => `P${c.seat}:${this.claimName(c.action)}`).join(" ") || "none"}`);
    // Missed-win furiten is judged by whether the hand forms a complete shape, not by whether a ron button with yaku was sent (no-yaku low-han hands count too).
    for (const p of this.players) {
      if (p.seat !== discarderSeat && (canQiang[p.seat]?.includes(PlayAction.Hu) || p.waits?.includes(kindOf2(card)))
        && !all.some((claim) => claim.seat === p.seat && claim.action === PlayAction.Hu)) this.markPassedRon(p);
    }
    // A fourth kan can still be a rinshan tsumo; after it, discards are settled for ron first, then the hand is drawn; no further pon/chi.
    if (this.kanCount === 4 && !all.some((claim) => claim.action === PlayAction.Hu)
      && !this.players.some((p) => p.melds.filter((meld) => meld.type === "kan" || meld.type === "ankan").length === 4)) {
      this.confirmRiichiDeclaration(this.players[discarderSeat]);
      await this.abortiveDraw(LiuJuType.SiGang, discarderSeat);
      return;
    }
    if (!all.length) {
      await this.continueAfterNoClaim(discarderSeat);
      return;
    }
    const priority = (claim) => claim.action === PlayAction.Hu ? 4 : claim.action === PlayAction.MingGang ? 3 : claim.action === PlayAction.Peng ? 2 : 1;
    const distance = (seat) => (seat - discarderSeat + this.playersN) % this.playersN;
    all.sort((left, right) => priority(right) - priority(left) || distance(left.seat) - distance(right.seat));
    // A human who offered a claim but lost it (a ron, or a nearer/higher claim) still needs the pass
    // announcement: their client closes its own buttons only on NtfQiangCard{seat: me, action: Guo}.
    if (humanHandled && humanCanClaim && all[0].seat !== 0) {
      this.emit(RiichiMsg.ENtfQiangCard, this.buildQiang(0, PlayAction.Guo, []));
    }
    const ronClaims = all.filter((claim) => claim.action === PlayAction.Hu);
    if (ronClaims.length) {
      await this.winRons(ronClaims.map((claim) => claim.seat), discarderSeat, card);
      return;
    }
    this.confirmRiichiDeclaration(this.players[discarderSeat]);
    const claim = all[0];
    const applied = await this.executeClaim(claim.seat, claim.action, card, discarderSeat, claim.otherCards || []);
    if (applied === Result.Succ) return;
    // The winner's own payload failed its second check: close the window instead of leaving the table
    // without a turn. A stalled hand looks exactly like "my claim was ignored".
    if (claim.seat === 0) this.emit(RiichiMsg.ENtfQiangCard, this.buildQiang(0, PlayAction.Guo, []));
    await this.continueAfterNoClaim(discarderSeat);
  }

  /**
   * Ends a claim window nobody won. The window has to be closed on the wire (the client leaves its claim
   * phase only on NtfQiangCardEnd), then the turn passes to the next seat.
   */
  async closeEmptyClaimWindow() {
    this.emit(RiichiMsg.ENtfQiangCardEnd, this.buildQiangEnd(null, PlayAction.Guo, [], []));
    await this._d(this.T.claim);
  }
  async continueAfterNoClaim(discarderSeat) {
    this.note("claim", "no one called, window closed, turn passes to next player");
    await this.closeEmptyClaimWindow();
    this.confirmRiichiDeclaration(this.players[discarderSeat]);
    if (this.playersN === 4 && this.players.every((player) => player.riichi)) {
      await this.abortiveDraw(LiuJuType.SiJiaLiZhi, discarderSeat);
      return;
    }
    if (this.checkSiFengLianDa()) {
      await this.abortiveDraw(LiuJuType.SiFengLianDa, discarderSeat);
      return;
    }
    const next = this.nextSeat(discarderSeat);
    if (next === this.dealerSeat) this.firstGoAround = false;
    await this.turnDraw(next);
  }
  recordPao(player, discarderSeat) {
    player.pao ||= {};
    const tripletKinds = new Set(player.melds
      .filter((meld) => meld.type === "pon" || meld.type === "kan")
      .map((meld) => kindOf2(meld.tiles[0])));
    if (player.pao.daisangen == null && [45, 46, 47].every((kind) => tripletKinds.has(kind))) {
      player.pao.daisangen = discarderSeat;
    }
    if (player.pao.daisuushi == null && [41, 42, 43, 44].every((kind) => tripletKinds.has(kind))) {
      player.pao.daisuushi = discarderSeat;
    }
  }
  // A ron that completes the set: the discarder of the winning tile is the liability. Money is unchanged on purpose
  // (the ron branch only splits when the liability is somebody other than the discarder), but the pao marker must be right.
  recordPaoOnRon(player, discarderSeat, win) {
    const names = Object.keys(win.yaku || {});
    player.pao ||= {};
    if (player.pao.daisangen == null && names.some((name) => name.includes("大三元"))) player.pao.daisangen = discarderSeat;
    if (player.pao.daisuushi == null && names.some((name) => name.includes("大四喜"))) player.pao.daisuushi = discarderSeat;
  }
  paoYakumanUnits(player, win) {
    const yaku = win.yaku || {};
    let units = 0;
    if (player.pao?.daisangen != null && Object.keys(yaku).some((name) => name.includes("大三元"))) units += 1;
    if (player.pao?.daisuushi != null && Object.keys(yaku).some((name) => name.includes("大四喜"))) units += 2;
    return Math.min(units, win.yakuman || units);
  }
  paoSeatFor(player, win) {
    const names = Object.keys(win.yaku || {});
    if (player.pao?.daisangen != null && names.some((name) => name.includes("大三元"))) return player.pao.daisangen;
    if (player.pao?.daisuushi != null && names.some((name) => name.includes("大四喜"))) return player.pao.daisuushi;
    return null;
  }
  async executeClaim(seat, action, card, discarderSeat, otherCards) {
    const p = this.players[seat];
    const validation = this.validateClaimPayload(
      { action, otherCards },
      { seat, discarderSeat, card, actions: this.claimActions(seat, discarderSeat, card) }
    );
    if (validation !== Result.Succ) return validation;
    this._processing = true; // During a call: packets arriving in this window are treated as duplicates and dropped
    this._bufferedDraw = null; this._bufferedClaim = null; // Clear the leftover buffer of the previous action (prevents duplicate-packet replay)
    this.note("meld", `P${seat} ${this.claimName(action)} P${discarderSeat}'s ${this.cardName(card)} hand[${otherCards.map((tile) => this.cardName(tile)).join(" ")}]`);
    const donor = this.players[discarderSeat];
    if (action === PlayAction.Hu) {
      await this.winRon(seat, discarderSeat, card);
      return Result.Succ;
    }
    donor.discards.pop();
    donor.discardClaimed = true;
    for (const q of this.players) q.ippatsu = false;
    this.firstGoAround = false;
    if (action === PlayAction.MingGang) {
      const used2 = this.takeTiles(p, card, 3);
      p.melds.push({ type: "kan", tiles: [...used2, card], from: discarderSeat });
      p.menzen = false;
      this.kanCount++;
      this.recordPao(p, discarderSeat);
      this.emit(RiichiMsg.ENtfQiangCard, this.buildQiang(seat, action, used2));
      await this._d(this.T.claim);
      this._deferredKanDora++;
      if (!await this.drawReplacement(seat)) return Result.Succ;
      this.emit(RiichiMsg.ENtfQiangCardEnd, this.buildQiangEnd(seat, action, used2, [...used2, card]));
      await this._d(this.T.claim);
      await this.awaitTurn(seat, true);
      return Result.Succ;
    }
    const isChi = action === PlayAction.Chi;
    const used = otherCards.slice();
    for (const tile of used) {
      p.hand.splice(p.hand.indexOf(tile), 1);
    }
    const meldTiles = [...used, card].sort((a, b) => a - b);
    p.melds.push({ type: isChi ? "chi" : "pon", tiles: meldTiles, from: discarderSeat });
    if (!isChi) this.recordPao(p, discarderSeat);
    p.menzen = false;
    p.drawnTile = null;
    p.rinshan = false;
    const cantPlays = this.cantPlays(p, action, meldTiles);
    this._nextCantPlays = { seat, values: cantPlays };
    this.emit(RiichiMsg.ENtfQiangCard, this.buildQiang(seat, action, used));
    await this._d(this.T.claim);
    this.expectDraw(seat, false, this.turnActions(seat, false), cantPlays);
    this.emit(RiichiMsg.ENtfQiangCardEnd, this.buildQiangEnd(seat, action, used, meldTiles));
    await this._d(this.T.claim);
    await this.awaitTurn(seat, false);
    return Result.Succ;
  }
  canRobKan(p, tile, kind) {
    if (!p.waits?.includes(kindOf2(tile)) || this.isFuriten(p)) return false;
    const win = calcWin(p.hand, p.melds, this.akaSet, { ...this.winOpts(p, true, tile), chankan: true });
    if (!win.isAgari || !win.hasYaku) return false;
    if (kind !== "ankan") return true;
    return Object.keys(win.yaku || {}).some((name) => name.includes("国士無双"));
  }
  kanRobActions(kanSeat, tile, kind) {
    return this.players.map((player) => {
      if (player.seat === kanSeat || !this.canRobKan(player, tile, kind)) return [];
      return [PlayAction.Hu, PlayAction.Guo];
    });
  }
  async resolveKanRob(kanSeat, tile, canQiang, winExtra = { chankan: true }) {
    const claims = [];
    let humanHandled = false;
    const humanCanClaim = this.players[0].isHuman && canQiang[0]?.length;
    if (humanCanClaim && (!this.isAiSeat(this.players[0]) || this._bufferedClaim != null)) {
      if (!this._expectedClaim && this._bufferedClaim == null) this.expectClaim(0, kanSeat, tile, canQiang[0]);
      const payload = await this.waitHuman("claim");
      humanHandled = true;
      if (payload?.action === PlayAction.Hu) claims.push({ seat: 0 });
      else this.emit(RiichiMsg.ENtfQiangCard, this.buildQiang(0, PlayAction.Guo, []));
    } else {
      this._expectedClaim = null;
    }
    for (let seat = 0; seat < this.playersN; seat++) {
      if (seat === 0 && (humanHandled || !this.isAiSeat(this.players[0]))) continue;
      if (canQiang[seat]?.includes(PlayAction.Hu)) claims.push({ seat });
    }
    for (const p of this.players) {
      // A closed kan can only be robbed by kokushi; North pull has no robbing-kan yaku, but a missed win on a no-yaku completed hand still needs recording.
      if (p.seat !== kanSeat && (canQiang[p.seat]?.includes(PlayAction.Hu)
        || !winExtra.chankan && p.waits?.includes(kindOf2(tile)))
        && !claims.some((claim) => claim.seat === p.seat)) this.markPassedRon(p);
    }
    if (!claims.length) return false;
    const distance = (seat) => (seat - kanSeat + this.playersN) % this.playersN;
    claims.sort((left, right) => distance(left.seat) - distance(right.seat));
    // Same as a lost ron on a discard: tell the human their window is over so the client drops its buttons.
    if (humanHandled && humanCanClaim && claims[0].seat !== 0) {
      this.emit(RiichiMsg.ENtfQiangCard, this.buildQiang(0, PlayAction.Guo, []));
    }
    await this.winRons(claims.map((claim) => claim.seat), kanSeat, tile, winExtra, { robbed: true });
    return true;
  }
  async doKan(seat, card, kind) {
    this.flushDeferredKanDora();
    const p = this.players[seat];
    const action = kind === "ankan" ? PlayAction.AnGang : PlayAction.PengGang;
    const canQiang = this.kanRobActions(seat, card, kind);
    this.expectClaim(0, seat, card, canQiang[0] || []);
    this.emit(RiichiMsg.ENtfPlayCard, this.buildPlayCard(seat, card, action, false, canQiang));
    await this._d(this.T.claim);
    if (await this.resolveKanRob(seat, card, canQiang)) return;
    // Same as a quiet discard: nobody robbed the kan, so close the window before the replacement draw.
    await this.closeEmptyClaimWindow();

    if (kind === "ankan") {
      const tiles = this.takeTilesByKind(p, kindOf2(card), 4);
      p.melds.push({ type: "ankan", tiles });
    } else {
      const meld = p.melds.find((item) => item.type === "pon" && kindOf2(item.tiles[0]) === kindOf2(card));
      p.hand.splice(p.hand.indexOf(card), 1);
      meld.type = "kan";
      meld.tiles = [...meld.tiles, card];
    }
    this.kanCount++;
    for (const player of this.players) player.ippatsu = false;
    this.firstGoAround = false;
    this.note("kan", `P${seat} ${kind === "ankan" ? "closed kan" : "added kan"} ${this.cardName(card)} kan count ${this.kanCount + 1}`);
    if (kind === "ankan") this.revealKanDora();
    else this._deferredKanDora++;
    if (!await this.drawReplacement(seat)) return;
    await this.awaitTurn(seat, true);
  }
  flushDeferredKanDora() {
    while (this._deferredKanDora > 0) {
      this._deferredKanDora--;
      this.revealKanDora();
    }
  }
  revealKanDora() {
    const i = this.doraIndicators.length;
    const baoBase = this.sanma ? 8 : 4;
    // 3-player and 4-player dora indicators are all 5 (initial + 4 kan dora), same layout, differing only in starting offset (3-player 8 / 4-player 4)
    const maxI = 4;
    if (i >= 1 && i <= maxI && this.deadWall[baoBase + 2 * i] != null) {
      const ind = this.deadWall[baoBase + 2 * i];
      this.doraIndicators.push(ind);
      this.uraIndicators.push(this.deadWall[baoBase + 1 + 2 * i]);
      this._pendingBaoPreCard = ind;
    }
  }
  takeTiles(p, card, n) {
    return this.takeTilesByKind(p, kindOf2(card), n);
  }
  takeTilesByKind(p, kind, n) {
    const used = [];
    for (let i = 0; i < n; i++) {
      const idx = p.hand.findIndex((t) => kindOf2(t) === kind);
      if (idx >= 0) used.push(p.hand.splice(idx, 1)[0]);
    }
    return used;
  }
  // otherCards is "the tiles this seat contributes from its own hand", **excluding** the called tile (real-machine capture:
  // Chi/Pon are 2 tiles each, MingGang is 3; the called tile is only given by NtfPlayCard.card).
  // If the called tile is also included, the client decides the meld type by otherCards.length+1:
  // pon (3) is displayed as open kan, and chi (3) cannot be assembled by the UI and freezes it.
  buildQiang(seat, action, otherCards) {
    return {
      seat,
      action,
      otherCards: otherCards || [],
      userInfos: this.players.map((q) => ({
        seat: q.seat,
        // Same reason as NtfPlayCard: a missing list clears the human's tenpai panel.
        tingInfos: q.isHuman ? this.buildTingInfos(q) : []
      }))
    };
  }
  // otherCards = the "tiles this seat contributes from its own hand" sent to the client (excluding the called tile)
  // meldTiles = the full meld (including the called tile), used internally only for computing swap-call forbidden tiles
  // seat === null closes a claim window nobody won: seats=[], action=Guo, no caller actions for anybody.
  buildQiangEnd(seat, action, otherCards, meldTiles) {
    const p = seat == null ? null : this.players[seat];
    return {
      seats: p ? [seat] : [],
      action,
      otherCards: otherCards || [],
      userInfos: this.players.map((q) => ({
        seat: q.seat,
        tingInfos: q.seat === seat ? (p ? this.buildTingInfos(p) : []) : q.isHuman ? this.buildTingInfos(q) : [],
        // Real-machine NtfQiangCardEnd canPlayActions can only be [] (others) or [0] (the caller,
        // i.e. "discard only"), never 6/7/8/9/10. The full set of options is sent by the NtfSendCard that immediately follows.
        canPlayActions: p && q.seat === seat ? [PlayAction.Normal] : [],
        isZhenTing: this.isFuriten(q),
        cantPlays: p && q.seat === seat ? this.cantPlays(p, action, meldTiles || otherCards || []) : [],
        leftTimer: q.isHuman ? Math.ceil(q.timeBank) : 0,
        xunNum: this.xunNum,
        zhenTingTypes: this.furitenTypes(q)
      }))
    };
  }
  // Post-chi/pon swap-call forbidden tiles (also tile-kind encoded, copy=0; real-machine sample [440,310,280,380,320])
  cantPlays(p, action, meldTiles) {
    if (action !== PlayAction.Chi && action !== PlayAction.Peng) return [];
    const claimed = this.lastDiscard ? this.lastDiscard.card : null;
    return [...this.kuikaeKinds(action, meldTiles, claimed)]
      .filter((kind) => p.hand.some((tile) => kindOf2(tile) === kind))
      .map((kind) => kind * 10);
  }
  kuikaeKinds(action, meldTiles, claimed) {
    const out = new Set();
    if (claimed == null || (action !== PlayAction.Chi && action !== PlayAction.Peng)) return out;
    out.add(kindOf2(claimed));
    if (action !== PlayAction.Chi || meldTiles.length !== 3) return out;
    const claimedTile = decodeId(claimed);
    const ranks = meldTiles.map((tile) => decodeId(tile).rank).sort((left, right) => left - right);
    if (ranks[2] - ranks[0] !== 2) return out;
    if (claimedTile.rank === ranks[0] && ranks[2] < 9) out.add(claimedTile.suit * 10 + ranks[2] + 1);
    if (claimedTile.rank === ranks[2] && ranks[0] > 1) out.add(claimedTile.suit * 10 + ranks[0] - 1);
    return out;
  }
  // ================= Win / draw =================
  async winTsumo(seat) {
    const p = this.players[seat];
    const w = calcWin(p.hand, p.melds, this.akaSet, this.winOpts(p, false));
    this.note("win", `P${seat} tsumo ${this.cardName(p.drawnTile)} ${this.winText(w)}`);
    await this.endHand({ type: "tsumo", winner: seat, loser: null, card: p.drawnTile, win: w });
  }
  async winRon(seat, loser, card, extra = {}) {
    await this.winRons([seat], loser, card, extra);
  }
  async winRons(seats, loser, card, extra = {}, { robbed = false } = {}) {
    const donor = this.players[loser];
    const robbedIndex = robbed ? donor.hand.indexOf(card) : -1;
    if (robbed && robbedIndex < 0) throw new Error(`robbed tile not in hand seat=${loser} card=${card}`);
    const wins = new Map();
    for (const seat of seats) {
      const p = this.players[seat];
      const win = calcWin(
        p.hand,
        p.melds,
        this.akaSet,
        { ...this.winOpts(p, true, card), ...extra }
      );
      if (!win.isAgari || !win.hasYaku) throw new Error(`invalid ron seat=${seat}`);
      wins.set(seat, win);
    }
    // Commit pao as well as the tile/declaration only after every winner has passed validation.
    for (const [seat, win] of wins) this.recordPaoOnRon(this.players[seat], loser, win);
    this.rollbackRiichiDeclaration(donor);
    if (robbed) {
      donor.hand.splice(robbedIndex, 1);
      donor.drawnTile = null;
      this.updateWaits(donor);
    }
    this.note("win", `P${seats.join("/")} ron P${loser}'s ${this.cardName(card)}${robbed ? "(chankan)" : ""} ${[...wins].map(([seat, win]) => `P${seat}:${this.winText(win)}`).join(" ")}`);
    // A ron is a claim too, and the client starts the win sequence from the Hu claim notice and leaves the claim
    // phase only on NtfQiangCardEnd (it hides its own buttons only on its own Hu notice). Announcing just the final
    // NtfGameStop leaves the hand frozen on screen with no win animation.
    for (const seat of seats) this.emit(RiichiMsg.ENtfQiangCard, this.buildQiang(seat, PlayAction.Hu, []));
    this.emit(RiichiMsg.ENtfQiangCardEnd, { ...this.buildQiangEnd(null, PlayAction.Hu, [], []), seats: seats.slice() });
    await this._d(this.T.claim);
    await this.endHand({ type: "ron", winners: seats.slice(), loser, card, wins });
  }
  async exhaustiveDraw() {
    const nagashiWinners = this.players
      .filter((player) => player.discards.length > 0 && !player.discardClaimed && player.discards.every((tile) => {
        const { suit, rank } = decodeId(tile);
        return suit === 4 || rank === 1 || rank === 9;
      }))
      .map((player) => player.seat);
    const tenpai = this.players.map((player) => this.isTenpai(player));
    this.note("draw", `exhaustive draw tenpai[${tenpai.map((t, s) => t ? `P${s}` : null).filter(Boolean).join(" ") || "none"}] wall ${this.remain}`);
    await this.endHand({ type: "draw", liuJuType: LiuJuType.HuangPai, tenpai, nagashiWinners });
  }
  async abortiveDraw(liuJuType, seat) {
    this.note("draw", `abortive draw type=${liuJuType} P${seat}`);
    await this.endHand({
      type: "draw",
      liuJuType,
      liuJuSeat: seat,
      tenpai: this.players.map(() => false),
      noPenalty: true
    });
  }
  // ================= Settlement =================
  async endHand(res) {
    if (this.handEnded) return;
    this.handEnded = true;
    // An abort (nine-terminal draw / four-kan abort / …) can end the hand while the human's window is still armed. Drop that wait silently:
    // its timer must not fire into the next hand, or it would charge the bank for time the player never got to use.
    if (this._pending?.timer) clearTimeout(this._pending.timer);
    if (this._humanClock) this.note("clock", JSON.stringify({ event: "hand-end", ...this.humanTime() }));
    this._humanClock = null;
    this._publishHumanClock();
    this._pending = null;
    this._bufferedDraw = null;
    this._bufferedClaim = null;
    this._expectedDraw = null;
    this._expectedClaim = null;
    const n = this.playersN;
    const scores = this.players.map((p) => p.score);
    let dealerContinues = false;
    let ui = [];
    if (res.type === "draw") {
      const nagashiWinners = res.nagashiWinners || [];
      if (nagashiWinners.length) {
        for (const winner of nagashiWinners) {
          const dealerWin = winner === this.dealerSeat;
          for (let seat = 0; seat < n; seat++) {
            if (seat === winner) continue;
            const payment = dealerWin || seat === this.dealerSeat ? 4_000 : 2_000;
            scores[seat] -= payment;
            scores[winner] += payment;
          }
        }
      } else if (!res.noPenalty) {
        const tenpaiSeats = res.tenpai.map((tenpai, seat) => tenpai ? seat : -1).filter((seat) => seat >= 0);
        const notenSeats = res.tenpai.map((tenpai, seat) => tenpai ? -1 : seat).filter((seat) => seat >= 0);
        if (tenpaiSeats.length && notenSeats.length) {
          const receive = Math.floor(3_000 / tenpaiSeats.length);
          const payment = Math.floor(3_000 / notenSeats.length);
          for (const seat of tenpaiSeats) scores[seat] += receive;
          for (const seat of notenSeats) scores[seat] -= payment;
        }
      }
      dealerContinues = res.noPenalty ? true : !!res.tenpai[this.dealerSeat];
      const gameOver2 = this.decideGameOver(dealerContinues, scores, { drawNoPenalty: !!res.noPenalty });
      this.renchanCount = dealerContinues ? this.renchanCount + 1 : 0;
      if (gameOver2 && this.riichiSticks > 0) {
        const topSeat = this.players.map((_, seat) => seat).sort((left, right) => scores[right] - scores[left] || this.startOrder(left) - this.startOrder(right))[0];
        scores[topSeat] += this.riichiSticks * 1e3;
        this.riichiSticks = 0;
      }
      this.recordHumanHandStats(res, null, dealerContinues);
      this.prepareFinalResult(scores, gameOver2);
      ui = this.buildStopUserInfos(scores, null, null, res.tenpai, gameOver2);
      this.emit(RiichiMsg.ENtfGameStop, {
        huSeats: [],
        huCardSeat: -1,
        huCard: 0,
        liBaoPreCards: [],
        isFinal: gameOver2,
        userInfos: ui,
        baoPreCards: this.doraIndicators.slice(),
        liuJuManGuanSeats: nagashiWinners,
        liuJuType: res.liuJuType,
        liuJuSeat: res.liuJuSeat != null ? res.liuJuSeat : -1,
        duiCards: [],
        duiCardsStr: "",
        duiCardsStrSalt: "",
        stopType: 0,
        winningStreak: 0
      });
      await this.finishHand(gameOver2, dealerContinues, scores, { draw: true });
      return;
    }
    const winners = res.type === "tsumo" ? [res.winner] : res.winners.slice();
    const details = new Map();
    const huDelta = new Array(n).fill(0);
    for (let winnerIndex = 0; winnerIndex < winners.length; winnerIndex++) {
      const winner = winners[winnerIndex];
      const winP = this.players[winner];
      const isDealerWin = winner === this.dealerSeat;
      const doraBreak = this.countDora(winP, res.type === "ron" ? res.card : null);
      const extraFan = doraBreak.babei + doraBreak.babeiAsDora;
      const rawWin = res.type === "tsumo" ? res.win : res.wins.get(winner);
      const paoSeat = this.paoSeatFor(winP, rawWin);
      const paoUnits = this.paoYakumanUnits(winP, rawWin);
      if (paoSeat != null) winP.baoPaiWin = true;
      const paoTotal = paoUnits * (isDealerWin ? 48_000 : 32_000);
      const win = this.applyExtraFan(rawWin, extraFan, isDealerWin);
      if (res.type === "tsumo") {
        let pureGain = 0;
        for (let seat = 0; seat < n; seat++) {
          if (seat === winner) continue;
          const base = isDealerWin ? win.oya[0] || 0 : seat === this.dealerSeat ? win.ko[0] || 0 : win.ko[1] || 0;
          const payment = base + this.honba * 100;
          scores[seat] -= payment;
          scores[winner] += payment;
          huDelta[seat] -= base;
          pureGain += base;
        }
        if (paoSeat != null && paoTotal > 0) {
          for (let seat = 0; seat < n; seat++) {
            if (seat === winner) continue;
            const paoShare = (isDealerWin || seat === this.dealerSeat ? 16_000 : 8_000) * paoUnits;
            // The responsible player pays all honba for pao (liability); non-pao yakuman portions still settle normally.
            scores[seat] += paoShare + this.honba * 100;
            scores[winner] -= paoShare + this.honba * 100;
            huDelta[seat] += paoShare;
            pureGain -= paoShare;
          }
          const paoPayment = paoTotal + (n - 1) * this.honba * 100;
          scores[paoSeat] -= paoPayment;
          scores[winner] += paoPayment;
          huDelta[paoSeat] -= paoTotal;
          pureGain += paoTotal;
        }
        huDelta[winner] += pureGain;
      } else {
        const base = win.ten || 0;
        const honbaPayment = winnerIndex === 0 ? this.honba * 300 : 0;
        scores[res.loser] -= base + honbaPayment;
        scores[winner] += base + honbaPayment;
        huDelta[res.loser] -= base;
        huDelta[winner] += base;
        if (paoSeat != null && paoSeat !== res.loser && paoTotal > 0) {
          const split = paoTotal / 2;
          scores[res.loser] += split + honbaPayment;
          scores[paoSeat] -= split + honbaPayment;
          huDelta[res.loser] += split;
          huDelta[paoSeat] -= split;
        }
      }
      const yakuInfo = mapYaku(win.yaku, {
        roundWind: this.roundWind,
        seatWind: this.seatWindOf(winner)
      });
      details.set(winner, {
        yiFans: this.rebuildYiFans(yakuInfo.yiFans),
        isYiMan: yakuInfo.isYiMan || win.yakuman > 0,
        manType: manTypeFromResult({ han: win.han, fu: win.fu, yakuman: win.yakuman, name: win.name }),
        baoFan: doraBreak.omote,
        liBaoFan: doraBreak.ura,
        redBaoFan: doraBreak.aka,
        baBeiFan: doraBreak.babei,
        fu: win.fu,
        // The client picks the settlement title from manType=YiMan as: isYiMan ? 5 + totalFan : 5 (counted yakuman),
        // with titles configured for 1x-6x; so a true yakuman sends its multiplier here, not the library's han 0.
        totalFan: win.yakuman > 0 ? Math.min(win.yakuman, 6) : win.han,
        yakuman: win.yakuman || 0
      });
    }
    const stickBonus = this.riichiSticks * 1e3;
    if (stickBonus) scores[winners[0]] += stickBonus;
    this.riichiSticks = 0;
    dealerContinues = winners.includes(this.dealerSeat);
    const gameOver = this.decideGameOver(dealerContinues, scores, {
      multiRonDealerContinuation: res.type === "ron" && winners.length > 1 && dealerContinues
    });
    this.renchanCount = dealerContinues ? this.renchanCount + 1 : 0;
    this.recordHumanHandStats(res, huDelta, dealerContinues);
    this.prepareFinalResult(scores, gameOver, details.get(0) || null);
    ui = this.buildStopUserInfos(scores, winners, details, null, gameOver, huDelta);
    this.emit(RiichiMsg.ENtfGameStop, {
      huSeats: winners,
      huCardSeat: res.type === "ron" ? res.loser : winners[0],
      huCard: res.card || 0,
      liBaoPreCards: winners.some((seat) => this.players[seat].riichi) ? this.uraIndicators.slice() : [],
      isFinal: gameOver,
      userInfos: ui,
      baoPreCards: this.doraIndicators.slice(),
      liuJuManGuanSeats: [],
      liuJuType: 0,
      liuJuSeat: -1,
      duiCards: [],
      duiCardsStr: "",
      duiCardsStrSalt: "",
      stopType: 0,
      winningStreak: 0
    });
    await this.finishHand(gameOver, dealerContinues, scores);
  }
  // Add the han counts that the riichi library's result lacks (currently only North pull), and recompute points by the standard formula.
  // Yakuman is not affected by dora and is returned unchanged.
  applyExtraFan(w, extraFan, isDealerWin) {
    if (!extraFan || !w || !w.isAgari || w.yakuman > 0) return w;
    const han = (w.han || 0) + extraFan;
    const fu = w.fu || 20;
    let base2;
    if (han >= 13) base2 = 8e3;
    else if (han >= 11) base2 = 6e3;
    else if (han >= 8) base2 = 4e3;
    else if (han >= 6) base2 = 3e3;
    else if (han === 5) base2 = 2e3;
    else base2 = Math.min(fu * 2 ** (2 + han), 2e3);
    const c = (x) => Math.ceil(x / 100) * 100;
    return {
      ...w,
      han,
      ten: c(base2 * (isDealerWin ? 6 : 4)),
      oya: [c(base2 * 2)],
      // Dealer tsumo: each opponent pays base×2
      ko: [c(base2 * 2), c(base2)]
      // Non-dealer tsumo: the dealer pays base×2, each other non-dealer pays base
    };
  }
  // Dora breakdown statistics (regular / ura / red / North pull)
  countDora(p, ronTile) {
    const tiles = p.hand.concat(ronTile != null ? [ronTile] : []);
    for (const m of p.melds) if (m.type !== "babei") tiles.push(...m.tiles);
    const babeiTiles = [];
    for (const m of p.melds) if (m.type === "babei") babeiTiles.push(...m.tiles);
    const count = (indList, list) => {
      let n = 0;
      for (const ind of indList) {
        const k = kindOf2(doraFromIndicator(ind, this.sanma));
        n += list.filter((t) => kindOf2(t) === k).length;
      }
      return n;
    };
    const babeiAsDora = count(this.doraIndicators, babeiTiles) + (p.riichi ? count(this.uraIndicators, babeiTiles) : 0);
    return {
      omote: count(this.doraIndicators, tiles) + count(this.doraIndicators, babeiTiles),
      ura: p.riichi ? count(this.uraIndicators, tiles) + count(this.uraIndicators, babeiTiles) : 0,
      aka: tiles.filter((t) => this.akaSet.has(t)).length,
      babei: babeiTiles.length,
      babeiAsDora
    };
  }
  // Remove the "ドラ" entries that the library merges in.
  //
  // Real-machine 15/15 cases prove dora does **not** enter yiFans; it only flows through the four dedicated fields baoFan / liBaoFan / redBaoFan / baBeiFan,
  // and totalFan = Σ(yiFans.fan) + the sum of the four dora fields.
  // Previously dora was pushed back into yiFans, so when the client settlement screen renders
  // "yaku list + dora row", dora was counted twice.
  rebuildYiFans(yiFans) {
    return yiFans.filter((y) => y.yiType !== YiType.Bao && y.yiType !== YiType.RedBao && y.yiType !== YiType.LiBao && y.yiType !== YiType.BaBeiBao);
  }
  recordHumanHandStats(result, huDelta, dealerContinues) {
    const stats = this.matchStats;
    const human = this.players[0];
    stats.hands += 1;
    if (human.riichi) stats.riichi += 1;
    if (human.melds.some((meld) => meld.type === "chi" || meld.type === "pon" || meld.type === "kan")) stats.calls += 1;
    const winners = result.type === "tsumo" ? [result.winner] : result.type === "ron" ? result.winners : [];
    if (winners.includes(0)) {
      stats.wins += 1;
      stats[result.type] += 1;
      stats.winPoints += Math.max(0, huDelta?.[0] || 0);
      stats.winTurns += this.xunNum;
    }
    if (result.type === "ron" && result.loser === 0) stats.dealIns += 1;
    if (dealerContinues && this.dealerSeat === 0) stats.maxRenchan = Math.max(stats.maxRenchan, this.renchanCount);
  }

  // humanWin: the human seat's winning details for this hand (null if not won), used by the one-round match to award rewards by han.
  prepareFinalResult(scores, isFinal, humanWin = null) {
    if (!isFinal || this._finalResult || !this.onFinalResult) return;
    this._finalResult = this.onFinalResult(scores.slice(), this, humanWin) || null;
  }

  buildStopUserInfos(scores, winner, detail, tenpai, isFinal, huDelta) {
    const out = [];
    const order = this.players.map((_, seat) => seat).sort((left, right) => scores[right] - scores[left] || this.startOrder(left) - this.startOrder(right));
    const rankOf = [];
    order.forEach((seat, index) => {
      rankOf[seat] = index + 1;
    });
    const winnerSeats = new Set(Array.isArray(winner) ? winner : winner == null ? [] : [winner]);
    const uma = this.playersN === 3 ? [15, 0, -15] : [15, 5, -5, -15];
    for (let s = 0; s < this.playersN; s++) {
      const p = this.players[s];
      const isWinner = winnerSeats.has(s);
      const currentDetail = detail instanceof Map ? detail.get(s) : isWinner ? detail : null;
      const rankResult = isFinal && s === 0 ? this._finalResult?.rank : null;
    const change = huDelta ? huDelta[s] || 0 : 0;
    // changeScore = net score change for this hand (including riichi sticks / honba sticks, consistent with the real machine);
    // yiFanChangeDian = pure han/fu payment (excluding riichi and honba sticks; the earlier requirement).
    // handStart takes the cumulative score at the end of the previous hand (this.scores); for the first hand, startScore is used.
    const handStart = this.scores ? this.scores[s] : this.startScore;
    const netDelta = scores[s] - handStart;
    const rank = rankOf[s];
      const jing = isFinal ? (scores[s] - this.startScore) / 1e3 + uma[rank - 1] : 0;
      out.push({
        seat: s,
        score: scores[s],
        handCards: p.hand.slice(),
        changeScore: netDelta,
        yiFans: currentDetail?.yiFans || [],
        baoFan: currentDetail?.baoFan || 0,
        liBaoFan: currentDetail?.liBaoFan || 0,
        redBaoFan: currentDetail?.redBaoFan || 0,
        fu: currentDetail?.fu || 0,
        totalFan: currentDetail?.totalFan || 0,
        isYiMan: currentDetail?.isYiMan || false,
        manType: currentDetail?.manType || 0,
        baBeiFan: currentDetail?.baBeiFan || 0,
        doorCardsInfos: p.melds.filter((m) => m.type !== "babei").map((m) => ({
          cards: m.tiles.slice(),
          action: m.type === "chi" ? PlayAction.Chi : m.type === "pon" ? PlayAction.Peng : m.type === "ankan" ? PlayAction.AnGang : PlayAction.MingGang,
          qiangSeat: m.from != null ? m.from : s
        })),
        // tings are also tile-kind encoded (copy=0): real-machine exhaustive-draw samples [230]/[260,230]/[160,130]
        tings: tenpai ? tenpai[s] ? (p.waits || []).map((k) => k * 10) : [] : [],
        alreadyRiichi: p.riichi,
        baBeiCards: p.melds.filter((m) => m.type === "babei").map((m) => m.tiles[0]),
        rank,
        // Pure payment from the yaku han of a win (only han/fu, excluding honba / riichi sticks / tenpai penalties).
        yiFanChangeDian: change,
        jingSuanScore: jing,
        jieBi: Math.round(jing * 100),
        changePT: rankResult?.change || 0,
        isBaoPai: p.baoPaiWin === true,
        matchingScore: 0,
        isMatchingAward: false,
        lianZhuang: this.honba,
        maxFan: currentDetail?.totalFan || 0,
        realJieBi: 0,
        finalBi: 0,
        // Affinity does not change with the match; the human seat echoes its current level, to avoid the settlement panel showing Lv.0.
        level: s === 0 ? this.selfLoveLevel : 0,
        loveValue: 0,
        oldLevel: s === 0 ? this.selfLoveLevel : 0,
        oldLoveValue: 0,
        ptLevel: rankResult?.level || 0,
        ptPoint: rankResult?.point || 0,
        oldPTLevel: rankResult?.oldLevel || 0,
        oldPTPoint: rankResult?.oldPoint || 0,
        itemRewardLevel: isFinal && s === 0 ? this._finalResult?.itemRewardLevel || 0 : 0,
        itemRewards: isFinal && s === 0 ? this._finalResult?.itemRewards || [] : []
      });
    }
    return out;
  }
  decideGameOver(dealerContinues, scores, { drawNoPenalty = false, multiRonDealerContinuation = false } = {}) {
    if (scores.some((score) => score < 0)) return true;
    if (this.handIndex + 1 >= this.maxHands) return true;
    if (drawNoPenalty) return false;

    const necessary = this.playersN === 3 ? 40_000 : 30_000;
    const order = this.players.map((_, seat) => seat).sort((left, right) => scores[right] - scores[left] || this.startOrder(left) - this.startOrder(right));
    const topSeat = order[0];
    const topMeets = scores[topSeat] >= necessary;
    const lastSeat = this.juNum === this.playersN - 1;

    if (this.roundWind < this.regularWinds || this.roundWind === this.regularWinds && !lastSeat) return false;
    if (this.roundWind === this.regularWinds) {
      if (dealerContinues) return topSeat === this.dealerSeat && topMeets;
      return topMeets;
    }

    if (multiRonDealerContinuation) return false;
    if (topMeets) return true;
    return lastSeat && !dealerContinues;
  }
  async finishHand(gameOver, dealerContinues, scores, { draw = false } = {}) {
    this.scores = scores.slice();
    this.handIndex += 1;
    if (draw || dealerContinues) {
      this.honba += 1;
    } else {
      this.honba = 0;
    }
    if (!dealerContinues) {
      this.juNum += 1;
      this.dealerSeat = this.nextSeat(this.dealerSeat);
      if (this.juNum >= this.playersN) {
        this.juNum = 0;
        this.roundWind += 1;
      }
    }
    this.note("hand", `end scores[${scores.join(",")}]${gameOver ? " match over" : ""} next hand ${WIND_NAME[this.roundWind]}${this.juNum + 1}-${this.honba} dealer P${this.dealerSeat}`);
    if (gameOver) {
      this.matchOver = true;
      this.finished = true;
      return;
    }
    await this._d(this.T.hand);
  }
  /** Reset to a brand-new East-wind match (scores restored, hand/honba/dealer counters cleared).
   *  Note: the end of the match does NOT go through here: the real server stops the engine after the final hand, and a new match is a newly matched room
   *  that creates a new GameEngine through the 20403 chain (see the comment in finishHand). This method is kept only for external reuse. */
  resetMatch() {
    this.scores = new Array(this.playersN).fill(this.startScore);
    this.handIndex = 0;
    this.juNum = 0;
    this.roundWind = 1;
    this.honba = 0;
    this.renchanCount = 0;
    this.dealerSeat = this.startDealer;
  }
  // ================= AI =================
  aiLevelOf(seat) {
    return this.aiLevels?.[seat] || "intermediate";
  }
  styleRngOf(seat) {
    return this._styleRngs?.[seat] || null;
  }
  aiTurn(seat, drew, can, cantPlays = []) {
    const level = this.aiLevelOf(seat);
    const p = this.players[seat];
    if (can.includes(PlayAction.Hu)) return { action: PlayAction.Hu, card: p.drawnTile };
    // Advanced: riichi evaluation, push/fold decisions and discard search share this decision's computation budget.
    const budget = createDecisionBudget();
    const danger = this.dangerKinds(seat);
    if (can.includes(PlayAction.BaBei)) {
      const north = this.northInHand(p);
      // North may be a required tile for kokushi, a pair or a triplet; do not break the shanten for one dora han.
      if (north != null && (p.riichi
        || handShanten(p.hand.filter((tile) => tile !== north), p.melds) <= this.currentShanten(p))) {
        return { action: PlayAction.BaBei, card: north };
      }
    }
    if (can.includes(PlayAction.Riichi)) {
      const decision = riichiPolicy(this, seat, this.formalTenpaiDiscards(p), level, budget);
      if (decision?.action === "riichi") {
        this.note("ai", `P${seat} riichi discard ${this.cardName(decision.card)}`);
        return { action: PlayAction.Riichi, card: decision.card };
      }
      if (decision?.action === "dama") {
        this.note("ai", `P${seat} dama discard ${this.cardName(decision.card)}`);
        return { action: PlayAction.Normal, card: decision.card };
      }
    }
    const kanOk = (can.includes(PlayAction.AnGang) || can.includes(PlayAction.PengGang))
      && this.aiWantsKan(p, danger) && !shouldFoldHand(this, seat, level, budget);
    if (kanOk && can.includes(PlayAction.AnGang)) {
      return { action: PlayAction.AnGang, card: this.concealedQuadTile(p) };
    }
    if (kanOk && can.includes(PlayAction.PengGang)) {
      return { action: PlayAction.PengGang, card: this.addedKanTile(p) };
    }
    const forbiddenKinds = new Set(cantPlays.map((value) => Math.floor(value / 10)));
    if (p.riichi && p.riichiTurn !== this.xunNum) {
      const forced = this.bestDiscard(p, { forbiddenKinds, forced: p.drawnTile }).discardId;
      this.note("ai", `P${seat} riichi tsumogiri ${this.cardName(forced)}`);
      return { action: PlayAction.Normal, card: forced };
    }
    const best = chooseDiscardByPolicy(this, seat, { forbiddenKinds, level, budget });
    this.note("ai", `P${seat} discard ${this.cardName(best.discardId)} ${this.currentShanten(p)}-shanten->${best.shanten}-shanten` +
      ` ukeire ${best.ukeire} EV${best.ev >= 0 ? "+" : ""}${best.ev.toFixed(1)}${best.fold ? " fold" : ""}` +
      (best.searched ? ` search ${best.searched} calc ${best.budget?.calcUsed || 0}` : "") +
      (best.budget?.exhausted ? " budget exhausted" : ""));
    return { action: PlayAction.Normal, card: best.discardId };
  }
  dangerKinds(seat) {
    const threats = this.players
      .filter((player) => player.seat !== seat)
      .map((player) => ({
        player,
        openMelds: player.melds.filter((meld) => meld.type !== "ankan" && meld.type !== "babei").length,
        level: player.riichi ? 1 : player.melds.filter((meld) => meld.type !== "ankan" && meld.type !== "babei").length >= 2 ? 0.55 : 0
      }))
      .filter((threat) => threat.level > 0);
    if (!threats.length) return null;
    const visible = this.visibleCounts();
    const riskByKind = new Map();
    const safe = new Set();
    const risky = new Set();
    for (let suit = 1; suit <= 4; suit++) {
      const maxRank = suit === 4 ? 7 : 9;
      for (let rank = 1; rank <= maxRank; rank++) {
        const kind = suit * 10 + rank;
        const idx = tileIndex(tileId(suit, rank, 1));
        let risk = 0;
        for (const { player, level } of threats) {
          if (player.discardKinds.has(kind)) continue;
          let threatRisk;
          if (suit === 4) {
            const shown = visible[idx] || 0;
            threatRisk = shown >= 3 ? 0 : shown === 2 ? 4 : shown === 1 ? 9 : 14;
          } else {
            threatRisk = rank === 1 || rank === 9 ? 8 : rank === 2 || rank === 8 ? 12 : rank === 3 || rank === 7 ? 15 : 19;
            const sujiSafe = [rank - 3, rank + 3].some((otherRank) => otherRank >= 1 && otherRank <= 9 && player.discardKinds.has(suit * 10 + otherRank));
            if (sujiSafe) threatRisk *= 0.48;
            const leftWall = rank > 1 && visible[idx - 1] >= 4;
            const rightWall = rank < 9 && visible[idx + 1] >= 4;
            if (leftWall || rightWall) threatRisk *= 0.55;
            if ((rank === 1 && rightWall) || (rank === 9 && leftWall)) threatRisk = 0;
          }
          risk = Math.max(risk, threatRisk * level);
        }
        riskByKind.set(kind, risk);
        if (risk === 0) safe.add(kind);
        else if (risk >= 12) risky.add(kind);
      }
    }
    return { threats: threats.length, safe, risky, riskByKind };
  }
  aiWantsKan(p, danger = null) {
    const scores = this.players.map((player) => player.score);
    const leading = p.score === Math.max(...scores);
    if (danger) return false;
    // Kan-loving style: any safe-looking kan is taken.
    if (resolveStyle(this, p.seat).kan) return true;
    if (this.isAllLast() && leading) return false;
    if (p.riichi) return true;
    const shanten = this.currentShanten(p);
    const dora = p.hand.filter((tile) => this.doraKinds().has(kindOf2(tile)) || this.akaSet.has(tile)).length;
    return shanten >= 2 || dora >= 2 || p.seat === this.dealerSeat && shanten >= 1;
  }
  aiClaim(seat, discarderSeat, card, can) {
    const p = this.players[seat];
    if (can.includes(PlayAction.Hu)) return { action: PlayAction.Hu };
    const level = this.aiLevelOf(seat);
    return this.aiClaimByPolicy(seat, card, can, level);
  }
  // All levels compare chii, pon, open kan and skip with the same EV model; opening still requires a clear yaku route.
  aiClaimByPolicy(seat, card, can, level) {
    const p = this.players[seat];
    const danger = this.dangerKinds(seat);
    const options = [];
    if (can.includes(PlayAction.MingGang) && this.worthOpening(p, card, "kan") && this.aiWantsKan(p, danger)) {
      options.push({ action: PlayAction.MingGang, type: "kan", used: this.previewTiles(p, card, 3) });
    }
    if (can.includes(PlayAction.Peng) && this.worthOpening(p, card, "pon")) {
      const used = this.previewTiles(p, card, 2);
      options.push({ action: PlayAction.Peng, type: "pon", used, forbiddenKinds: this.kuikaeKinds(PlayAction.Peng, [...used, card], card) });
    }
    if (can.includes(PlayAction.Chi)) {
      for (const used of this.chiOptions(p, card)) {
        if (!this.worthOpening(p, card, "chi", used)) continue;
        options.push({ action: PlayAction.Chi, type: "chi", used, forbiddenKinds: this.kuikaeKinds(PlayAction.Chi, [...used, card], card) });
      }
    }
    const choice = claimPolicy(this, seat, card, options, level, createDecisionBudget());
    if (!choice) {
      this.note("ai", `P${seat} saw ${this.cardName(card)} no call (${options.length} options)`);
    } else {
      this.note("ai", `P${seat} ${this.claimName(choice.action)} ${this.cardName(card)}` +
        (choice.used?.length ? ` using ${choice.used.map((tile) => this.cardName(tile)).join("")}` : ""));
    }
    return choice ? { action: choice.action, otherCards: choice.used } : null;
  }
  currentShanten(p) {
    return handShanten(p.hand, p.melds);
  }
  isYakuhaiKind(p, kind) {
    const { suit, rank } = decodeId(tileId(Math.floor(kind / 10), kind % 10, 1));
    return suit === 4 && (rank >= 5 || rank === this.roundWind || rank === this.seatWindOf(p.seat));
  }
  hasOpenYakuRoute(p, card, claimKind, used = []) {
    const proposedType = claimKind === "chi" ? "chi" : claimKind === "kan" ? "kan" : "pon";
    const claimTiles = claimKind === "chi" ? used : this.previewTiles(p, card, claimKind === "kan" ? 3 : 2);
    const hand = p.hand.filter((tile) => !claimTiles.includes(tile));
    const proposed = { type: proposedType, tiles: [...claimTiles, card] };
    // A pulled North is not a meld, nor is it an honor tile in the tanyao / honitsu shape.
    // The real tiles of the proposed call move from the closed hand into a meld and may be counted only once.
    const melds = realMelds(p.melds).concat([proposed]);
    const tiles = hand.concat(melds.flatMap((meld) => meld.tiles));
    const tripletKinds = new Set(melds
      .filter((meld) => meld.type === "pon" || meld.type === "kan" || meld.type === "ankan")
      .map((meld) => kindOf2(meld.tiles[0])));
    if (claimKind !== "chi" && this.isYakuhaiKind(p, kindOf2(card))) return true;
    if ([...tripletKinds].some((kind) => this.isYakuhaiKind(p, kind))) return true;
    const decoded = tiles.map(decodeId);
    if (decoded.every(({ suit, rank }) => suit !== 4 && rank >= 2 && rank <= 8)) return true;
    const suits = new Set(decoded.filter(({ suit }) => suit !== 4).map(({ suit }) => suit));
    if (suits.size <= 1) return true;
    if (melds.every((meld) => meld.type !== "chi")) {
      const counts = new Map();
      for (const tile of hand) counts.set(kindOf2(tile), (counts.get(kindOf2(tile)) || 0) + 1);
      const pairOrTriplet = [...counts.values()].filter((count) => count >= 2).length;
      if (pairOrTriplet + melds.length >= 4) return true;
    }
    return false;
  }
  worthOpening(p, card, kind, used = []) {
    if (!this.hasOpenYakuRoute(p, card, kind, used)) return false;
    const current = this.currentShanten(p);
    if (kind === "pon" && this.isYakuhaiKind(p, kindOf2(card))) return true;
    const doraKinds = this.doraKinds();
    const dora = p.hand.filter((tile) => doraKinds.has(kindOf2(tile)) || this.akaSet.has(tile)).length;
    return current <= resolveStyle(this, p.seat).callReach || dora >= 2;
  }
  shantenAfterClaim(p, card, kind, chiTiles = null) {
    const hand = p.hand.slice();
    let meld;
    if (kind === "pon") {
      const used = [];
      for (let i = 0; i < 2; i++) {
        const idx = hand.findIndex((t) => kindOf2(t) === kindOf2(card));
        if (idx >= 0) used.push(hand.splice(idx, 1)[0]);
      }
      if (used.length < 2) return 99;
      meld = { type: "pon", tiles: [...used, card] };
    } else {
      if (!chiTiles) return 99;
      for (const t of chiTiles) {
        const i = hand.indexOf(t);
        if (i >= 0) hand.splice(i, 1);
      }
      meld = { type: "chi", tiles: [...chiTiles, card] };
    }
    const action = kind === "chi" ? PlayAction.Chi : PlayAction.Peng;
    const forbiddenKinds = this.kuikaeKinds(action, meld.tiles, card);
    try {
      return chooseDiscard(hand, p.melds.concat([meld]), {
        doraKinds: this.doraKinds(),
        akaSet: this.akaSet,
        forbiddenKinds
      }).shanten;
    } catch {
      return 99;
    }
  }
  previewTiles(p, card, n) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const t of p.hand) {
      if (kindOf2(t) === kindOf2(card) && !seen.has(t)) {
        out.push(t);
        seen.add(t);
      }
      if (out.length >= n) break;
    }
    return out;
  }
  // ================= Human input =================
  // Race condition: awaitTurn emits NtfSendCard first, then awaits waitHuman('draw') to set _pending.
  // The client may call submitDraw the instant it receives NtfSendCard, when _pending is not yet ready,
  // and a direct call would become a no-op and the engine would wait forever. So submitDraw/submitClaim cache the request when not ready,
  // and waitHuman consumes the buffer immediately upon entering the wait, to avoid a deadlock.
  setInternalState(values) {
    for (const [key, value] of Object.entries(values || {})) {
      const state = Number(key);
      if (Number.isInteger(state) && state >= 0 && state <= 5) this.internalState[state] = !!value;
    }
  }
  setHumanAutoplay(enabled) {
    this.autoHuman = !!enabled;
    if (!this.autoHuman) return;
    if (this._prepareWaiter) this._prepareWaiter();
    if (!this._pending) return;
    const pending = this._pending;
    this.resolveHumanPending(pending, this.timeoutHumanAction(pending.kind), "autoplay");
  }
  automaticHumanAction(kind) {
    const expected = kind === "draw" ? this._expectedDraw : this._expectedClaim;
    if (!expected) return null;
    if (expected.actions.includes(PlayAction.Hu) && this.internalState[1]) return { action: PlayAction.Hu };
    if (kind === "claim") return this.internalState[2] ? { action: PlayAction.Guo, otherCards: [] } : null;
    const player = this.players[expected.seat];
    if (expected.actions.includes(PlayAction.AnGang) && player.riichi && this.internalState[4]) {
      return { action: PlayAction.AnGang, card: this.concealedQuadTile(player) };
    }
    if (expected.actions.includes(PlayAction.BaBei) && player.riichi && this.internalState[5]) {
      return { action: PlayAction.BaBei, card: this.northInHand(player) };
    }
    if (this.internalState[3] && expected.drew && player.drawnTile != null) {
      return { action: PlayAction.Normal, card: player.drawnTile };
    }
    return null;
  }
  timeoutHumanAction(kind) {
    if (kind === "claim") return { action: PlayAction.Guo, otherCards: [] };
    const expected = this._expectedDraw;
    const player = this.players[expected.seat];
    if (expected.drew && player.drawnTile != null) return { action: PlayAction.Normal, card: player.drawnTile };
    const forbiddenKinds = new Set((expected.cantPlays || []).map((value) => Math.floor(value / 10)));
    return { action: PlayAction.Normal, card: this.bestDiscard(player, { forbiddenKinds }).discardId };
  }
  resolveHumanPending(pending, payload, source = "client") {
    if (this._pending !== pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this._freezeHumanClock();
    const time = this.humanTime();
    const player = this.players[0];
    const bankBefore = player.timeBank;
    player.timeBank = time.bankLeft;
    if (source === "client" && payload?.isTimeout) source = "client-timeout";
    this.note("clock", JSON.stringify({ event: "resolve", ...time, source, bankBefore, bankAfter: player.timeBank }));
    this._humanClock = null;
    this._publishHumanClock();
    if (pending.kind === "draw") this._expectedDraw = null;
    else this._expectedClaim = null;
    this._pending = null;
    const applied = {};
    for (const key of ["action", "card", "otherCards"]) if (payload?.[key] != null) applied[key] = payload[key];
    const act = pending.kind === "claim" ? (applied.action === PlayAction.Guo ? "pass" : this.claimName(applied.action)) : "discard";
    const cards = [applied.card, ...(applied.otherCards || [])].filter((value) => value != null).map((value) => this.cardName(value)).join(" ");
    this.note("human", act + (cards ? " " + cards : "") + " time used " + (time.elapsedMs / 1000).toFixed(1) + "s time bank " + Math.round(player.timeBank * 10) / 10 + "s");
    this._record([pending.kind === "draw" ? "d" : "c", applied, player.timeBank]);
    pending.resolve(payload || {});
  }
  _armHumanTimer(pending) {
    if (!this._humanClock?.ready) return;
    const time = this.humanTime();
    this.note("clock", JSON.stringify({ event: "arm", ...time, deadline: Date.now() + time.timeoutMs }), true);
    pending.timer = setTimeout(() => {
      if (this._pending !== pending || !this.humanPresent) return;
      const payload = this.timeoutHumanAction(pending.kind);
      this.note("timeout", "window#" + time.id + " server timeout, executing default action");
      this.resolveHumanPending(pending, payload, "server-timeout");
      this._timedOut = { kind: pending.kind, payload, id: time.id };
    }, time.timeoutMs);
  }
  waitHuman(kind) {
    if (!this._humanClock) this._openHumanClock(kind);
    const replayed = this._replayNext(kind === "draw" ? "d" : "c");
    if (replayed) {
      this._humanClock = null;
      this._publishHumanClock();
      if (kind === "draw") this._expectedDraw = null;
      else this._expectedClaim = null;
      this.players[0].timeBank = replayed[2];
      this._record(replayed);
      return Promise.resolve({ ...replayed[1] });
    }
    return new Promise((resolve) => {
      const pending = { kind, resolve, timer: null };
      this._pending = pending;
      const buffered = kind === "draw" ? this._bufferedDraw : this._bufferedClaim;
      this.note("clock", JSON.stringify({ event: "wait", ...this.humanTime(), buffered: buffered != null }), true);
      if (buffered != null) {
        if (kind === "draw") this._bufferedDraw = null;
        else this._bufferedClaim = null;
        this.note("clock", JSON.stringify({ event: "consume-buffer", ...this.humanTime() }), true);
        this.resolveHumanPending(pending, buffered);
        return;
      }
      if (this.autoHuman) {
        const payload = this.automaticHumanAction(kind) || this.timeoutHumanAction(kind);
        queueMicrotask(() => this.resolveHumanPending(pending, payload, "autoplay"));
        return;
      }
      if (this.humanPresent) {
        this._armHumanTimer(pending);
        this._queueAutomatic(pending);
      }
    });
  }
  /** Run the client-authorized auto action (tsumogiri / no-call) for a pending human wait, if one still applies. */
  _queueAutomatic(pending) {
    if (!this.automaticHumanAction(pending.kind)) return;
    // The client may cancel the no-call before the microtask runs, or clear the old authorization after reconnecting.
    // In that case keep the original deadline and wait for the human; do not keep executing the captured stale auto-action.
    queueMicrotask(() => {
      if (this._pending !== pending || !this.humanPresent) return;
      const automatic = this.automaticHumanAction(pending.kind);
      if (automatic) this.resolveHumanPending(pending, automatic, "client-setting");
    });
  }
  /**
   * The client's countdown can still be running when the server times the window out (the two clocks start at
   * different moments). Its late request is then rejected and the client keeps the buttons up. A late request that
   * matches what the server already did (Pass, or the same auto discard) is acknowledged as a no-op: no state change,
   * no time charge, no humanLog entry. Anything else (a late Pon, Ron or a different discard) still fails.
   * The receipt lives until the next window of the same kind opens.
   */
  ackTimedOut(kind, payload) {
    const done = this._timedOut;
    if (!done || done.kind !== kind || (kind === "draw" ? this._expectedDraw : this._expectedClaim)) return false;
    if (Number(payload?.action ?? PlayAction.Normal) !== done.payload.action) return false;
    const accepted = kind === "claim" ? done.payload.action === PlayAction.Guo : Number(payload?.card) === done.payload.card;
    if (accepted) this.note("clock", JSON.stringify({ event: "late-ack", id: done.id, kind }));
    return accepted;
  }
  submitDraw(payload) {
    if (this.ackTimedOut("draw", payload)) return Result.Succ;
    if (!this.humanPresent) return Result.Fail_InvalidSequence;
    const result = this.validateTurnPayload(payload);
    if (result !== Result.Succ) return result;
    this._freezeHumanClock();
    this._expectedDraw = null;
    this._processing = true;
    if (this._pending && this._pending.kind === "draw") {
      this.resolveHumanPending(this._pending, payload || {});
    } else {
      this._bufferedDraw = payload || {};
    }
    return Result.Succ;
  }
  submitClaim(payload) {
    if (this.ackTimedOut("claim", payload)) return Result.Succ;
    if (!this.humanPresent) return Result.Fail_InvalidSequence;
    const result = this.validateClaimPayload(payload);
    if (result !== Result.Succ) {
      // A claim arriving with no window open means the client still believes it is choosing: its button presses would
      // keep being swallowed there. Push the authoritative close (pass + empty end) so it drops them and resumes.
      if (!this._expectedClaim && !this.handEnded && !this.matchOver) this.resyncClaimWindow();
      return result;
    }
    this._freezeHumanClock();
    this._expectedClaim = null;
    this._processing = true;
    if (this._pending && this._pending.kind === "claim") {
      this.resolveHumanPending(this._pending, payload || {});
    } else {
      this._bufferedClaim = payload || {};
    }
    return Result.Succ;
  }
  /** Tell the human's client that no claim window is open: it hides the buttons only on its own pass notice. */
  resyncClaimWindow() {
    this.emit(RiichiMsg.ENtfQiangCard, this.buildQiang(0, PlayAction.Guo, []));
    this.emit(RiichiMsg.ENtfQiangCardEnd, this.buildQiangEnd(null, PlayAction.Guo, [], []));
  }
  cancelPending() {
    if (this._humanClock) this.note("clock", JSON.stringify({ event: "cancel", ...this.humanTime() }));
    this._humanClock = null;
    this._publishHumanClock();
    this._expectedDraw = null;
    this._expectedClaim = null;
    this._timedOut = null;
    this._bufferedDraw = null;
    this._bufferedClaim = null;
    if (!this._pending) return;
    if (this._pending.timer) clearTimeout(this._pending.timer);
    const resolve = this._pending.resolve;
    this._pending = null;
    resolve({});
  }
  /** Record for reload recovery, in the form accepted back as opts.replayLog. */
  matchRecord() {
    return this.humanLog.map((entry) => entry.slice());
  }
  // Debug snapshot
  snapshot() {
    return {
      ju: this.juNum,
      honba: this.honba,
      dealer: this.dealerSeat,
      remain: this.remain,
      dora: this.doraIndicators.map(tileName),
      players: this.players.map((p) => ({
        seat: p.seat,
        score: p.score,
        riichi: p.riichi,
        hand: p.hand.map(tileName).join(" "),
        melds: p.melds.map((m) => m.type + ":" + m.tiles.map(tileName).join("")).join(" ")
      }))
    };
  }
};
function mulberry32(a) {
  return function() {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export { GameEngine, mulberry32 };
