import test from 'node:test';
import assert from 'node:assert/strict';
import { RiichiSession, encodeMsg, decodeMsg } from '../mockjs/browser_entry.mjs';
import { buildRiichiReloadScene, foldRiichiFrames } from '../mockjs/riichi_reload.mjs';
import { PlayAction, RiichiMsg } from '../mockjs/proto_enum.mjs';

const sorted = (tiles) => [...tiles].sort((a, b) => a - b);
const macrotask = () => new Promise((resolve) => setImmediate(resolve));

// 真人席0按“积极鸣牌、能杠就杠、否则用AI出牌”的脚本应答，覆盖吃碰明杠/暗杠/加杠/立直/拔北的牌河与副露。
function humanAnswer(engine) {
  const p = engine.players[0];
  if (engine._pending.kind === 'claim') {
    const { actions, card } = engine._expectedClaim;
    if (actions.includes(PlayAction.Hu)) return { action: PlayAction.Hu, otherCards: [] };
    if (actions.includes(PlayAction.MingGang)) return { action: PlayAction.MingGang, otherCards: engine.previewTiles(p, card, 3) };
    if (actions.includes(PlayAction.Peng)) return { action: PlayAction.Peng, otherCards: engine.previewTiles(p, card, 2) };
    if (actions.includes(PlayAction.Chi)) return { action: PlayAction.Chi, otherCards: engine.chiTiles(p, card) };
    return { action: PlayAction.Guo, otherCards: [] };
  }
  const { drew, actions, cantPlays } = engine._expectedDraw;
  return engine.aiTurn(0, drew, actions, cantPlays);
}

// 快照只能由切点前下发的帧和公开/本人信息组成，并与权威状态逐项一致。
function checkScene(scene, engine, frames) {
  decodeMsg('Offline2OnlineGameScene', encodeMsg('Offline2OnlineGameScene', scene));
  assert.equal(scene.remainDuiCardNum, engine.remain);
  assert.deepEqual(scene.openBaoPreCards, engine.doraIndicators);
  assert.equal(scene.gameID, decodeMsg('NtfGameStart', frames.find(([ev]) => ev === RiichiMsg.ENtfGameStart)[1]).gameID);
  for (const user of scene.offline2OnlineUserInfos) {
    const p = engine.players[user.seat];
    assert.equal(user.handCardsNum, p.hand.length, `seat ${user.seat} 手牌数`);
    if (user.seat === 0) {
      assert.deepEqual(sorted(user.handCards), sorted(p.hand));
      if (engine._expectedDraw && p.drawnTile != null && scene.currentSeat === 0) assert.equal(user.handCards.at(-1), p.drawnTile);
    } else {
      assert.deepEqual(user.handCards, [], '不能泄漏他家暗牌');
    }
    const river = [...user.playedCards];
    for (const tile of user.PlayedCardsOtherTake) river.splice(river.indexOf(tile), 1);
    assert.deepEqual(river, p.discards, `seat ${user.seat} 牌河`);
    assert.equal(user.alreadyRiichi, !!p.riichi);
    if (p.riichi) assert.ok(user.playedCards.includes(user.riichiTagCard), '立直宣言牌在牌河历史中');
    const melds = p.melds.filter((meld) => meld.type !== 'babei');
    assert.equal(user.doorCardsInfos.length, melds.length);
    for (const door of user.doorCardsInfos) {
      const meld = melds.find((item) => item.tiles.includes(door.cards[0]));
      assert.ok(meld, '副露实体来自权威副露');
      assert.deepEqual(sorted(door.cards), sorted(meld.tiles));
      if (door.action === PlayAction.Chi || door.action === PlayAction.Peng) {
        assert.ok(engine.players[door.qiangSeat].discardClaimed !== undefined);
      }
    }
    assert.deepEqual(sorted(user.baBeiCards), sorted(p.melds.filter((meld) => meld.type === 'babei').flatMap((meld) => meld.tiles)));
  }
  const own = scene.offline2OnlineUserInfos[0];
  if (engine._expectedDraw) assert.deepEqual(own.canPlayActions, engine._expectedDraw.actions);
  if (engine._expectedClaim) assert.deepEqual(scene.canQiangActions, engine._expectedClaim.actions);
}

for (const players of [3, 4]) {
  test(`${players === 3 ? '三麻' : '四麻'}：每个真人动作窗口都能生成与权威局面一致、不泄漏暗牌的重连快照`, { timeout: 120000 }, async (t) => {
    const frames = [];
    const session = new RiichiSession({ players, speed: 0, seed: 20261017 + players, maxHands: 3,
      onFrame: (ev, bytes) => {
        if (ev === RiichiMsg.ENtfToPrepare) frames.length = 0;
        if (ev >= 1000) frames.push([ev, bytes]);
      } });
    t.after(() => session.stop());
    const prepare = () => session.handleClient(RiichiMsg.EReqPrepare, new Uint8Array());
    prepare();
    const engine = session.engine;
    let windows = 0;
    const seen = new Set();
    for (let step = 0; step < 20000 && !session.matchOver; step += 1) {
      await macrotask();
      if (engine._prepareWaiter && frames.at(-1)?.[0] !== RiichiMsg.ENtfGameStart) prepare();
      if (!engine._pending) continue;
      const scene = buildRiichiReloadScene(frames, engine, 0);
      if (scene) {
        windows += 1;
        checkScene(scene, engine, frames);
        for (const user of scene.offline2OnlineUserInfos) for (const door of user.doorCardsInfos) seen.add(door.action);
      }
      const answer = humanAnswer(engine);
      if (engine._pending.kind === 'claim') session.handleClient(RiichiMsg.EReqQiangCard, encodeMsg('ReqQiangCard', answer));
      else session.handleClient(RiichiMsg.EReqPlayCard, encodeMsg('ReqPlayCard', answer));
    }
    assert.ok(session.matchOver, '脚本应能打完整场');
    assert.ok(windows > 30, `快照窗口 ${windows}`);
    assert.ok([PlayAction.Peng, PlayAction.Chi].some((action) => seen.has(action)), `副露类型 ${[...seen]}`);
  });
}

test('切点在准备阶段、本手已结束或余牌为0时不给快照，调用方退回整手重放', () => {
  const engine = { players: [{ hand: [] }], handEnded: false };
  assert.equal(buildRiichiReloadScene([], engine, 0), null);
  const start = encodeMsg('NtfGameStart', { changWind: 0, juNum: 1, benChangNum: 0, zhuangSeat: 0, baoPreCard: 111,
    remainDuiCardNum: 0, userInfos: [{ seat: 0, handCards: [], score: 25000, initScore: 25000 }], gameID: 'g' });
  assert.equal(buildRiichiReloadScene([[RiichiMsg.ENtfGameStart, start]], engine, 0), null);
  assert.equal(foldRiichiFrames([[RiichiMsg.ENtfGameStart, start], [RiichiMsg.ENtfGameStop, new Uint8Array()]], 0), null);
});

test('吃副露按原 Reload 约定排列：两张己方贡献在前、被吃牌在后，被鸣牌记入出牌者 PlayedCardsOtherTake', () => {
  const start = encodeMsg('NtfGameStart', { zhuangSeat: 3, baoPreCard: 111, remainDuiCardNum: 50, gameID: 'g',
    userInfos: [0, 1, 2, 3].map((seat) => ({ seat, score: 25000, initScore: 25000,
      handCards: seat === 0 ? [121, 131, 211, 221, 231, 241, 251, 261, 271, 281, 291, 311, 321] : [] })) });
  const play = encodeMsg('NtfPlayCard', { seat: 3, card: 141, action: PlayAction.Normal, isMoQie: true });
  const end = encodeMsg('NtfQiangCardEnd', { seats: [0], action: PlayAction.Chi, otherCards: [121, 131] });
  const state = foldRiichiFrames([[RiichiMsg.ENtfGameStart, start], [RiichiMsg.ENtfPlayCard, play],
    [RiichiMsg.ENtfQiangCardEnd, end]], 0);
  assert.deepEqual(state.players[0].melds, [{ action: PlayAction.Chi, card: 141, cards: [121, 131, 141], qiangSeat: 3 }]);
  assert.deepEqual(state.players[3].played, [141]);
  assert.deepEqual(state.players[3].otherTake, [141]);
  assert.deepEqual(state.players[3].moQie, { 141: true });
  assert.equal(state.players[0].hand.length, 11);
  assert.deepEqual(state.cur, { seat: 0, card: 141, action: PlayAction.Chi,
    qiang: [{ seat: 0, action: PlayAction.Chi, otherCards: [121, 131] }] });
  assert.equal(state.pre.action, PlayAction.Normal);
});
