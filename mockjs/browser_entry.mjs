import { GameEngine } from './engine.mjs';
import { encodeMsg, decodeMsg } from './pb.mjs';
import { RiichiMsg, PlayAction, ManType, YiType, LiuJuType } from './proto_enum.mjs';
import { tileName, decodeId, tileId } from './tiles.mjs';
import * as shop from './shop.mjs';
import * as oneRound from './one_round.mjs';
import { buildRiichiReloadScene } from './riichi_reload.mjs';
import { createProfileHost } from './profile_host.mjs';
import { createDefaultProfile, normalizeProfile } from './profile.mjs';

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
      // The current player's warrior affinity level: display only on the settlement panel, never changes it
      selfLoveLevel: opts.selfLoveLevel || 0,
      // Seat → real userID; must exactly match the table uids sent in 20408/20014
      uids: opts.uids || null
    };
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
      this.log("[riichi] \u672A\u77E5\u4E8B\u4EF6\u53F7 " + ev);
      return;
    }
    let bytes;
    try {
      bytes = encodeMsg(name, payload);
    } catch (e) {
      this.log("[riichi] \u7F16\u7801\u5931\u8D25 " + name + ": " + e.message);
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
      internalState: this.clientInternalState,
      uids: o.uids,
      autoHuman: o.autoHuman,
      aiLevel: o.aiLevel,
      selfLoveLevel: o.selfLoveLevel,
      onFinalResult: (scores, engine, humanWin) => this.onFinalResult(scores, engine, humanWin),
      // false = human at seat 0, true = AI plays for them (for testing)
      emit: (ev, payload) => this.send(ev, payload),
      onFinish: (scores) => {
        this.matchOver = true;
        this.onFinish(scores.slice(), eng);
        this.log("[riichi] 终局，引擎停止；等客户端 20102 收场或 20403 重新匹配");
      }
    });
    this.engine = eng;
    this.log("[riichi] \u65B0\u5BF9\u5C40 players=" + o.players + " seed=" + seed + " maxHands=" + o.maxHands);
    eng.start().catch((e) => this.log("[riichi] \u5F15\u64CE\u5F02\u5E38: " + (e && e.stack || e)));
    return eng;
  }
  /** Handle one inner message uplinked by the client */
  handleClient(msgType, innerBytes) {
    if (this.matchOver) {
      if (!this._mutedLogged) {
        this._mutedLogged = true;
        this.log("[riichi] \u7EC8\u5C40\u540E\u5FFD\u7565\u5BA2\u6237\u7AEF\u4E0A\u884C\uFF08\u5BF9\u9F50\u771F\u5B9E\u670D\uFF1A\u96F6\u54CD\u5E94\uFF09\uFF0C\u7B49 20102/20403");
      }
      return;
    }
    const name = MSG_NAME[msgType];
    let payload = {};
    if (name && innerBytes && innerBytes.length) {
      try {
        payload = decodeMsg(name, innerBytes);
      } catch (e) {
        this.log("[riichi] \u89E3\u7801\u5931\u8D25 mt=" + msgType + ": " + e.message);
      }
    }
    switch (msgType) {
      case RiichiMsg.EReqPrepare: {
        const e = this.ensureEngine();
        if (!e) return;
        this.send(RiichiMsg.ERspPrepare, { result: 0 });
        e.submitPrepare();
        break;
      }
      case RiichiMsg.EReqPlayCard: {
        const e = this.ensureEngine();
        if (!e) return;
        const result = e.submitDraw(payload);
        this.send(RiichiMsg.ERspPlayCard, { result });
        break;
      }
      case RiichiMsg.EReqQiangCard: {
        const e = this.ensureEngine();
        if (!e) return;
        const result = e.submitClaim(payload);
        this.send(RiichiMsg.ERspQiangCard, { result });
        break;
      }
      case RiichiMsg.EReqSetInternalState: {
        const values = payload.InternalState || payload.internalState || {};
        this.opts.internalState = { ...this.opts.internalState, ...values };
        this.clientInternalState = { ...this.clientInternalState, ...values };
        if (this.engine) this.engine.setInternalState(values);
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
        this.log("[riichi] \u672A\u5904\u7406\u7684\u5BA2\u6237\u7AEF\u6D88\u606F mt=" + msgType);
    }
  }
  /** Reconnect snapshot: fold this hand's cached frames [ev, bytes][] into Offline2OnlineGameScene bytes; return null if it cannot be restored safely. */
  reloadScene(frames) {
    if (!this.engine || this.matchOver) return null;
    try {
      const scene = buildRiichiReloadScene(frames, this.engine, 0);
      return scene ? encodeMsg("Offline2OnlineGameScene", scene) : null;
    } catch (e) {
      this.log("[riichi] 重连快照构造失败，改用整手重放: " + (e && e.message || e));
      return null;
    }
  }
  /** Connection dropped: let the engine stop naturally and stop pushing */
  stop() {
    this.stopped = true;
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
