import { decodeMsg } from './pb.mjs';
import { PlayAction, RiichiMsg } from './proto_enum.mjs';

const NAMES = {
  [RiichiMsg.ENtfGameStart]: 'NtfGameStart',
  [RiichiMsg.ENtfSendCard]: 'NtfSendCard',
  [RiichiMsg.ENtfPlayCard]: 'NtfPlayCard',
  [RiichiMsg.ENtfQiangCardEnd]: 'NtfQiangCardEnd',
};
const DISCARDS = new Set([PlayAction.Normal, PlayAction.Riichi]);
const CLAIMS = new Set([PlayAction.Chi, PlayAction.Peng, PlayAction.MingGang]);
const kindOf = (tile) => Math.floor(tile / 10);
const removeTiles = (hand, tiles) => {
  for (const tile of tiles) {
    const index = hand.indexOf(tile);
    if (index < 0) throw new Error(`重连快照：手牌缺少 ${tile}`);
    hand.splice(index, 1);
  }
};

/**
 * 把本手已下发给真人席的通知帧折叠成客户端可见局面（同进程断线重连，20163.f100）。
 * 只使用真人席当时收到的帧，因此不会泄漏他家暗牌或牌山；对局历史（牌河、摸切、立直宣言牌、副露顺序、宝牌、gameID）
 * 与切点一致。返回 null 表示该切点不能用快照恢复，调用方须退回整手重放。
 */
export function foldRiichiFrames(frames, mySeat) {
  let state = null;
  for (const [ev, bytes] of frames) {
    if (ev === RiichiMsg.ENtfGameStop) return null;
    const name = NAMES[ev];
    if (!name) continue;
    const msg = decodeMsg(name, bytes);
    if (ev === RiichiMsg.ENtfGameStart) {
      state = {
        changWind: msg.changWind, juNum: msg.juNum, benChangNum: msg.benChangNum, zhuangSeat: msg.zhuangSeat,
        dora: [msg.baoPreCard], remain: msg.remainDuiCardNum, gameID: msg.gameID,
        defaultMinTimeout: msg.defaultMinTimeout, redundant: msg.ServerRedundantTimeOut,
        players: msg.userInfos.map((info) => ({
          seat: info.seat, initScore: Number(info.initScore), count: info.seat === msg.zhuangSeat ? 14 : 13,
          hand: info.seat === mySeat ? info.handCards.slice() : null,
          played: [], otherTake: [], moQie: {}, riichiTag: 0, babei: [], melds: [],
        })),
        cur: { seat: msg.zhuangSeat, card: 0, action: PlayAction.Normal, qiang: [] }, pre: null, lastDiscard: null,
      };
      continue;
    }
    if (!state) continue;
    const step = (next) => { state.pre = state.cur; state.cur = next; };
    if (ev === RiichiMsg.ENtfSendCard) {
      const player = state.players[msg.seat];
      const card = msg.userInfos.find((info) => info.seat === msg.seat)?.card ?? 0;
      player.count += 1;
      if (player.hand) player.hand.push(card);
      state.remain -= 1;
      if (msg.baoPreCard) state.dora.push(msg.baoPreCard);
      state.cur = { ...state.cur, seat: msg.seat };
    } else if (ev === RiichiMsg.ENtfPlayCard) {
      const player = state.players[msg.seat];
      if (DISCARDS.has(msg.action)) {
        player.played.push(msg.card);
        player.moQie[msg.card] = msg.isMoQie;
        if (msg.action === PlayAction.Riichi) player.riichiTag = msg.card;
        player.count -= 1;
        if (player.hand) removeTiles(player.hand, [msg.card]);
        state.lastDiscard = { seat: msg.seat, card: msg.card };
      } else if (msg.action === PlayAction.BaBei) {
        player.babei.push(msg.card);
        player.count -= 1;
        if (player.hand) removeTiles(player.hand, [msg.card]);
      } else if (msg.action === PlayAction.AnGang) {
        // 暗杠实体由调用方从权威副露补齐（他家暗杠的四张实体本来就在桌面公开）。
        player.melds.push({ action: PlayAction.AnGang, card: msg.card, cards: null, qiangSeat: msg.seat });
        player.count -= 4;
        if (player.hand) removeTiles(player.hand, player.hand.filter((tile) => kindOf(tile) === kindOf(msg.card)));
      } else if (msg.action === PlayAction.PengGang) {
        // 原 Reload 取 cards[0] 为加杠张，其余按碰恢复后再加杠。
        const pon = player.melds.find((meld) => meld.action === PlayAction.Peng && kindOf(meld.cards[0]) === kindOf(msg.card));
        if (!pon) throw new Error('重连快照：加杠找不到对应的碰');
        pon.action = PlayAction.PengGang;
        pon.cards = [msg.card, ...pon.cards];
        player.count -= 1;
        if (player.hand) removeTiles(player.hand, [msg.card]);
      }
      step({ seat: msg.seat, card: msg.card, action: msg.action, qiang: [] });
    } else if (ev === RiichiMsg.ENtfQiangCardEnd) {
      if (!CLAIMS.has(msg.action) || !state.lastDiscard) continue;
      const seat = msg.seats[0];
      const { seat: from, card } = state.lastDiscard;
      const player = state.players[seat];
      state.players[from].otherTake.push(card);
      // 原 Reload 把 cards[0..1] 当己方贡献、最后一张当被鸣牌。
      player.melds.push({ action: msg.action, card, cards: [...msg.otherCards, card], qiangSeat: from });
      player.count -= msg.otherCards.length;
      if (player.hand) removeTiles(player.hand, msg.otherCards);
      state.lastDiscard = null;
      step({ seat, card, action: msg.action, qiang: [{ seat, action: msg.action, otherCards: msg.otherCards.slice() }] });
    }
  }
  return state;
}

/**
 * 生成 20163.f100 的 riichi.Offline2OnlineGameScene 对象。
 * 动作窗口、分数、立直、振听、听牌与计时读取引擎当前值；它们都只关于真人席或公开信息。
 * 准备阶段、本手已结束、余牌为0（原客户端此时不走 Reload）或正在等待抢杠/抢北时返回 null。
 */
export function buildRiichiReloadScene(frames, engine, mySeat = 0, now = Date.now()) {
  const state = foldRiichiFrames(frames, mySeat);
  if (!state || state.remain <= 0 || engine.handEnded) return null;
  const me = engine.players[mySeat];
  if (!me || state.players[mySeat].hand.length !== me.hand.length) return null;
  const draw = engine._expectedDraw?.seat === mySeat ? engine._expectedDraw : null;
  const claim = engine._expectedClaim?.seat === mySeat ? engine._expectedClaim : null;
  if (claim && claim.card !== state.lastDiscard?.card) return null;
  // 本人摸牌张必须在手牌最后；其余手牌顺序沿用通知折叠结果。
  const hand = state.players[mySeat].hand;
  if (me.drawnTile != null && hand.includes(me.drawnTile) && state.cur.seat === mySeat) {
    hand.splice(hand.indexOf(me.drawnTile), 1);
    hand.push(me.drawnTile);
  }
  const pending = engine._pending;
  const elapsed = pending ? Math.max(0, (now - pending.startedAt) / 1000) : 0;
  const baseLeft = Math.max(0, engine.baseTime - elapsed);
  const bankLeft = Math.max(0, me.timeBank - Math.max(0, elapsed - engine.baseTime));
  const internalState = {};
  for (const [key, value] of Object.entries(engine.internalState)) internalState[key] = value ? 1 : 0;
  const users = state.players.map((folded) => {
    const p = engine.players[folded.seat];
    const own = folded.seat === mySeat;
    const melds = folded.melds.map((meld) => {
      if (meld.cards) return { cards: meld.cards, action: meld.action, qiangSeat: meld.qiangSeat };
      const ankan = p.melds.find((item) => item.type === 'ankan' && kindOf(item.tiles[0]) === kindOf(meld.card));
      return { cards: ankan.tiles.slice(), action: meld.action, qiangSeat: meld.qiangSeat };
    });
    return {
      seat: folded.seat,
      handCardsNum: folded.count,
      doorCardsInfos: melds,
      handCards: own ? hand.slice() : [],
      playedCards: folded.played,
      PlayedCardsOtherTake: folded.otherTake,
      riichiTagCard: folded.riichiTag,
      alreadyRiichi: !!p.riichi,
      tingInfos: own ? engine.buildTingInfos(p) : [],
      score: p.score,
      canPlayActions: own && draw ? draw.actions.slice() : [],
      isZhenTing: engine.isFuriten(p),
      moQieMap: folded.moQie,
      leftTimer: own ? Math.ceil(bankLeft) : 0,
      cantPlays: own && draw ? draw.cantPlays.slice() : [],
      changeScore: p.score - folded.initScore,
      baBeiCards: folded.babei,
      internalState: own ? internalState : {},
      initScore: folded.initScore,
      canAnGangNoNumCardsAfterRiichi: engine.riichiFutureAnkanKinds(p),
      DefaultMinTimeout: own && pending ? Math.ceil(baseLeft) : state.defaultMinTimeout,
      ServerRedundantTimeOut: state.redundant,
      zhenTingTypes: engine.furitenTypes(p),
      zhenTingTypesGuo: [],
    };
  });
  const pre = state.pre;
  return {
    seat: mySeat,
    changWind: state.changWind,
    juNum: state.juNum,
    benChangNum: state.benChangNum,
    zhuangSeat: state.zhuangSeat,
    openBaoPreCards: state.dora,
    remainDuiCardNum: state.remain,
    currentSeat: state.cur.seat,
    currentPlayCard: state.cur.card,
    currentAction: state.cur.action,
    canQiangActions: claim ? claim.actions.slice() : [],
    qiangInfos: state.cur.qiang,
    offline2OnlineUserInfos: users,
    currentPlayEndTime: 0,
    currentQiangEndTime: 0,
    defaultMinTimeout: state.defaultMinTimeout,
    ServerRedundantTimeOut: state.redundant,
    riichiBangNum: engine.riichiSticks,
    gameID: state.gameID,
    preSeat: pre ? pre.seat : 0,
    prePlayCard: pre ? pre.card : 0,
    preAction: pre ? pre.action : 0,
    preQiangInfos: pre ? pre.qiang : [],
    duiCardsStrEncode: '',
    duiCardsStrSaltEncode: '',
    MapFriendPoll: {},
    FriendOutTime: 0,
  };
}
