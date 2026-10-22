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
 * Fold the notification frames already sent to the human seat in this hand into the client-visible position (same-process reconnect, 20163.f100).
 * Uses only frames the human seat received at the time, so it never leaks opponents' hidden tiles or the wall; match history (discards, tsumogiri, riichi declaration tile, meld order, dora, gameID)
 * matches the cut point. Returns null if this cut point cannot be restored from a snapshot; the caller must then fall back to a full-hand replay.
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
        // Closed-kan tiles are filled in by the caller from authoritative melds (the four tiles of an opponent's closed kan are already public on the table).
        player.melds.push({ action: PlayAction.AnGang, card: msg.card, cards: null, qiangSeat: msg.seat });
        player.count -= 4;
        if (player.hand) removeTiles(player.hand, player.hand.filter((tile) => kindOf(tile) === kindOf(msg.card)));
      } else if (msg.action === PlayAction.PengGang) {
        // The original Reload takes cards[0] as the added-kan tile and re-adds the rest after restoring the pon.
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
      // The original Reload treats cards[0..1] as the self contribution and the last tile as the called tile.
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
 * Build the riichi.Offline2OnlineGameScene object for 20163.f100.
 * Action window, scores, riichi, furiten, waits and timers are read from the engine's current values; all of them concern only the human seat or public information.
 * Returns null during the prepare phase, when the hand has ended, when 0 tiles remain (the original client does not use Reload then), or while waiting for a robbing-kan / robbing-North window.
 */
export function buildRiichiReloadScene(frames, engine, mySeat = 0, now = Date.now()) {
  const state = foldRiichiFrames(frames, mySeat);
  if (!state || state.remain <= 0 || engine.handEnded) return null;
  const me = engine.players[mySeat];
  if (!me || state.players[mySeat].hand.length !== me.hand.length) return null;
  const draw = engine._expectedDraw?.seat === mySeat ? engine._expectedDraw : null;
  const claim = engine._expectedClaim?.seat === mySeat ? engine._expectedClaim : null;
  if (claim && claim.card !== state.lastDiscard?.card) return null;
  // The human's drawn tile must be last in the hand; the rest of the hand order follows the notification fold result.
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
