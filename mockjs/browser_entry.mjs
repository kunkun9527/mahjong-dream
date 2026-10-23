import { GameEngine } from './engine.mjs';
import { encodeMsg, decodeMsg } from './pb.mjs';
import { RiichiMsg, PlayAction, ManType, YiType, LiuJuType } from './proto_enum.mjs';
import { tileName, decodeId, tileId } from './tiles.mjs';
import * as shop from './shop.mjs';
import * as oneRound from './one_round.mjs';
import { buildRiichiReloadScene } from './riichi_reload.mjs';
import { createProfileHost } from './profile_host.mjs';
import { createDefaultProfile, normalizeProfile } from './profile.mjs';
import * as npc from './npc_roster.mjs';

// Claim actions as they read in the log ([claim] lines); numeric codes alone make a stuck window hard to spot.
var CLAIM_NAME = { 1: "pass", 2: "chi", 3: "pon", 4: "open kan", 8: "ron" };
var claimText = (action) => CLAIM_NAME[action] || action;

var MSG_NAME = {
  1: "ReqPrepare",
  2: "RspPrepare",
  3: "ReqPlayCard",
  4: "RspPlayCard",
  5: "ReqQiangCard",
  6: "RspQiangCard",
  7: "ReqSetInternalState",
  8: "RspSetInternalState",
  9: "ReqCloseOfflineTip",
  10: "RspCloseOfflineTip",
  11: "ReqClickUI",
  12: "RspClickUI",
  1001: "NtfToPrepare",
  1002: "NtfPrepare",
  1003: "NtfGameStart",
  1004: "NtfSendCard",
  1005: "NtfPlayCard",
  1006: "NtfQiangCard",
  1007: "NtfQiangCardEnd",
  1008: "NtfGameStop",
  1009: "NtfOfflineToolTip"
};
var RiichiSession = class {
  constructor(opts = {}) {
    this.opts = {
      players: opts.players != null ? opts.players : 4,
      akaCount: opts.akaCount != null ? opts.akaCount : 1,
      startScore: opts.startScore != null ? opts.startScore : opts.players === 3 ? 35e3 : 25e3,
      matchLength: opts.matchLength === "hanchan" ? "hanchan" : "east",
      maxHands: opts.maxHands != null ? opts.maxHands : opts.matchLength === "hanchan" ? 64 : 32,
      // AI thinking-delay multiplier. 0 = instant (for self-tests), 1 = normal feel
      speed: opts.speed != null ? opts.speed : 1,
      seed: opts.seed,
      baseTime: opts.baseTime != null ? opts.baseTime : 5,
      extraTime: opts.extraTime != null ? opts.extraTime : 20,
      internalState: { ...(opts.internalState || {}) },
      autoHuman: opts.autoHuman != null ? opts.autoHuman : false,
      // AI difficulty: intermediate / advanced (decided per room by the server)
      aiLevel: opts.aiLevel,
      // Per-seat NPC play styles (seat 0 = player, null)
      aiStyles: opts.aiStyles || null,
      // The current player's warrior affinity level: display only on the settlement panel, never changes it
      selfLoveLevel: opts.selfLoveLevel || 0,
      // Seat → real userID; must exactly match the table uids sent in 20408/20014
      uids: opts.uids || null,
      // Reload recovery: saved human-decision log to replay, and whether the player is connected
      replayLog: opts.replayLog || null,
      humanPresent: opts.humanPresent !== false,
      onHumanClock: opts.onHumanClock || null,
      deferHumanClock: !!opts.deferHumanClock,
      debug: !!opts.debug
    };
    // Called with the full record after every human decision (and once when the engine starts)
    this.onRecord = opts.onRecord || (() => {
    });
    let replayDone;
    this.replayDone = new Promise((resolve) => { replayDone = resolve; });
    this._replayDone = replayDone;
    this.onFrame = opts.onFrame || (() => {
    });
    this.onFinish = opts.onFinish || (() => {
    });
    this.onFinalResult = opts.onFinalResult || (() => null);
    this.onSettingsChange = opts.onSettingsChange || (() => {
    });
    this.log = opts.log || (() => {
    });
    // The saved / previous-match cache was not synced to Unity through the start-of-match protocol, so it cannot authorize automatic actions in the current UI.
    // Only items explicitly submitted by the client's ReqSetInternalState in this session may be used for auto win / no-call / tsumogiri.
    this.clientInternalState = {};
    this.engine = null;
    this.stopped = false;
    this.matchOver = false;
  }
  /** A new connection has not yet synced its auto-action toggles and must not inherit the old page's authorization; this does not change saves or timers. */
  resetClientSettings() {
    this.clientInternalState = {};
    if (this.engine) this.engine.setInternalState({ 1: false, 2: false, 3: false, 4: false, 5: false });
  }
  /** Encode and push one server event back */
  send(ev, payload) {
    if (this.stopped) return;
    const name = MSG_NAME[ev];
    if (!name) {
      this.log("[riichi] Unknown event number " + ev);
      return;
    }
    let bytes;
    if (this.opts.debug && ev === RiichiMsg.ENtfQiangCard) {
      this.log(`[claim] -> NtfQiangCard seat=${payload?.seat} action=${claimText(payload?.action)} other=${JSON.stringify(payload?.otherCards || [])}`);
    } else if (this.opts.debug && ev === RiichiMsg.ENtfQiangCardEnd) {
      this.log(`[claim] -> NtfQiangCardEnd seats=${JSON.stringify(payload?.seats || [])} action=${claimText(payload?.action)}`);
    } else if (this.opts.debug && ev === RiichiMsg.ENtfGameStart) {
      this.log(`[game] -> GameStart ju=${payload?.juNum} zhuang=${payload?.zhuangSeat} benChang=${payload?.benChangNum} bao=${payload?.baoPreCard} remain=${payload?.remainDuiCardNum}`);
    } else if (this.opts.debug && ev === RiichiMsg.ENtfGameStop) {
      this.log(`[game] -> GameStop type=${payload?.stopType} hu=${JSON.stringify(payload?.huSeats || [])} liuJu=${payload?.liuJuType} final=${payload?.isFinal ? 1 : 0} scores=${JSON.stringify((payload?.userInfos || []).map((u) => u.score))}`);
    }
    try {
      bytes = encodeMsg(name, payload);
    } catch (e) {
      this.log("[riichi] Encode failed " + name + ": " + e.message);
      return;
    }
    this.onFrame(ev, bytes);
  }
  /** Lazily create the engine. When a match (East-wind game) ends, the session is over: the engine stops and matchOver is set,
   *  and the engine must NEVER be rebuilt in the same session afterwards: a new match must be re-matched by the client via 20403,
   *  and server.js's 20403 handler stops the old session and creates a new RiichiSession. */
  ensureEngine() {
    if (this.matchOver) return null;
    if (this.engine) return this.engine;
    const o = this.opts;
    const seed = o.seed != null ? o.seed : Math.random() * 2147483647 | 0;
    const eng = new GameEngine({
      players: o.players,
      akaCount: o.akaCount,
      startScore: o.startScore,
      matchLength: o.matchLength,
      maxHands: o.maxHands,
      speed: o.speed,
      seed,
      baseTime: o.baseTime,
      extraTime: o.extraTime,
      debug: o.debug,
      internalState: this.clientInternalState,
      uids: o.uids,
      autoHuman: o.autoHuman,
      aiLevel: o.aiLevel,
      aiStyles: o.aiStyles,
      selfLoveLevel: o.selfLoveLevel,
      replayLog: o.replayLog,
      humanPresent: o.humanPresent,
      deferHumanClock: o.deferHumanClock,
      onHumanClock: (clock) => { if (!eng.replaying && o.onHumanClock) o.onHumanClock(clock); },
      // While replaying, the saved record is still the complete one; publish again only once the replay has caught up.
      onRecord: () => {
        if (!eng.replaying) this.onRecord(eng.matchRecord());
      },
      onReplayDone: (clean) => {
        this.onRecord(eng.matchRecord());
        this.log("[riichi] " + (clean ? "match record replay complete" : "match record replay diverged, continuing from current state"));
        this._replayDone(clean);
      },
      onFinalResult: (scores, engine, humanWin) => this.onFinalResult(scores, engine, humanWin),
      // false = human at seat 0, true = AI plays for them (for testing)
      emit: (ev, payload) => this.send(ev, payload),
      onFinish: (scores) => {
        this.matchOver = true;
        this.onFinish(scores.slice(), eng);
        this.log("[riichi] match over, engine stopped; waiting for client 20102 (match closed) or 20403 (re-match)");
      }
    });
    this.engine = eng;
    eng.log = (s) => this.log(s);
    if (!o.replayLog) {
      this._replayDone(true);
      this.onRecord(eng.matchRecord());
    }
    this.log("[riichi] New round players=" + o.players + " seed=" + seed + " maxHands=" + o.maxHands);
    eng.start().catch((e) => this.log("[riichi] Engine error: " + (e && e.stack || e)));
    return eng;
  }
  /** Handle one inner message uplinked by the client */
  handleClient(msgType, innerBytes) {
    if (this.matchOver) {
      if (!this._mutedLogged) {
        this._mutedLogged = true;
        this.log("[riichi] Ignoring client uplink after game end (matches real server: no response), waiting for 20102/20403");
      }
      return;
    }
    const name = MSG_NAME[msgType];
    let payload = {};
    if (name && innerBytes && innerBytes.length) {
      try {
        payload = decodeMsg(name, innerBytes);
      } catch (e) {
        this.log("[riichi] Decode failed mt=" + msgType + ": " + e.message);
      }
    }
    switch (msgType) {
      case RiichiMsg.EReqPrepare: {
        const e = this.ensureEngine();
        if (!e) return;
        this.log("[client] <- ReqPrepare");
        this.send(RiichiMsg.ERspPrepare, { result: 0 });
        e.submitPrepare();
        break;
      }
      case RiichiMsg.EReqPlayCard: {
        const e = this.ensureEngine();
        if (!e) return;
        const clock = e.humanTime();
        const result = e.submitDraw(payload);
        if (this.opts.debug || result !== 0) this.log(`[clock-request] ${JSON.stringify({ ...clock, kind: "draw", result, present: e.humanPresent, buffered: e._bufferedDraw != null })}`);
        this.log(`[client] <- ReqPlayCard action=${payload?.action} card=${payload?.card ? tileName(payload.card) : "-"}` +
          ` timeout=${payload?.isTimeout ? 1 : 0} -> ${result}`);
        this.send(RiichiMsg.ERspPlayCard, { result });
        break;
      }
      case RiichiMsg.EReqQiangCard: {
        const e = this.ensureEngine();
        if (!e) return;
        const open = e._expectedClaim;
        const pending = e._pending;
        const clock = e.humanTime();
        const elapsed = pending?.kind === "claim" ? clock.elapsedMs : null;
        const result = e.submitClaim(payload);
        if (this.opts.debug || result !== 0) this.log(`[clock-request] ${JSON.stringify({ ...clock, kind: "claim", result, present: e.humanPresent, buffered: e._bufferedClaim != null })}`);
        const windowText = open
          ? `seat${open.seat}<from${open.discarderSeat} card${open.card} can[${open.actions.map(claimText).join("/")}]`
          : "closed";
        this.log(`[claim] <- ReqQiangCard action=${claimText(payload?.action)} other=${JSON.stringify(payload?.otherCards || [])}`
          + ` timeout=${payload?.isTimeout ? 1 : 0} at=${elapsed == null ? "-" : elapsed + "ms"} -> ${result} window=${windowText}`);
        this.send(RiichiMsg.ERspQiangCard, { result });
        break;
      }
      case RiichiMsg.EReqSetInternalState: {
        const values = payload.InternalState || payload.internalState || {};
        this.opts.internalState = { ...this.opts.internalState, ...values };
        this.clientInternalState = { ...this.clientInternalState, ...values };
        if (this.engine) this.engine.setInternalState(values);
        this.log(`[client] <- ReqSetInternalState ${JSON.stringify(values)}`);
        this.onSettingsChange({ ...this.opts.internalState });
        this.send(RiichiMsg.ERspSetInternalState, { result: 0 });
        break;
      }
      case RiichiMsg.EReqCloseOfflineTip:
        this.send(RiichiMsg.ERspCloseOfflineTip, { result: 0 });
        break;
      case RiichiMsg.EReqClickUI:
        this.send(RiichiMsg.ERspClickUI, { result: 0 });
        break;
      default:
        this.log("[riichi] Unhandled client message mt=" + msgType);
    }
  }
  /** Reconnect snapshot: fold this hand's cached frames [ev, bytes][] into Offline2OnlineGameScene bytes; return null if it cannot be restored safely. */
  reloadScene(frames) {
    if (!this.engine || this.matchOver) return null;
    try {
      const scene = buildRiichiReloadScene(frames, this.engine, 0);
      this.log(`[reload] snapshot build ${scene ? "succeeded" : "abandoned, falling back to full-hand replay"} frames=${frames.length}`);
      return scene ? encodeMsg("Offline2OnlineGameScene", scene) : null;
    } catch (e) {
      this.log("[riichi] reconnect snapshot build failed, falling back to full-hand replay: " + (e && e.message || e));
      return null;
    }
  }
  /** Connection dropped: let the engine stop naturally and stop pushing */
  stop() {
    this.stopped = true;
    this.log("[riichi] session stopped (connection lost or re-matched)");
    const eng = this.engine;
    this.engine = null;
    if (!eng) return;
    eng.emit = () => {
    };
    eng.finished = true;
    eng.handEnded = true;
    try {
      eng.submitPrepare();
    } catch (e) {
    }
    try {
      eng.cancelPending();
    } catch (e) {
    }
  }
};
var _g = typeof window !== "undefined" ? window : globalThis;
var _MJ = _g.__mj || (_g.__mj = {});
_MJ.shop = shop;
_MJ.oneRound = oneRound;
_MJ.npc = npc;
// Used by web-host.js when the page runs without the Node service.
_MJ.host = { createProfileHost, createDefaultProfile, normalizeProfile };
_MJ.riichi = {
  RiichiSession,
  GameEngine,
  MSG_NAME,
  encodeMsg,
  decodeMsg,
  RiichiMsg,
  PlayAction,
  ManType,
  LiuJuType,
  YiType,
  tileName,
  decodeId,
  tileId
};

export { RiichiSession, GameEngine, MSG_NAME, encodeMsg, decodeMsg, RiichiMsg, PlayAction, ManType, LiuJuType, YiType, tileName, decodeId, tileId };
