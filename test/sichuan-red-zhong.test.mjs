import test from 'node:test';
import assert from 'node:assert/strict';
import { SichuanEngine } from '../mockjs/sichuan_engine.mjs';
import { SichuanSession } from '../mockjs/sichuan_session.mjs';
import { SichuanNotifications } from '../mockjs/sichuan_notifications.mjs';
import { handleSichuanRequest } from '../mockjs/sichuan_requests.mjs';
import { analyzeSichuanHand, buildSichuanWall, isRedZhong, legalSichuanDiscards, sichuanKind,
  sichuanWaitKinds } from '../mockjs/sichuan_hand.mjs';
import { scoreSichuanHand } from '../mockjs/sichuan_score.mjs';
import { chooseSichuanExchange, chooseSichuanMissingSuit } from '../mockjs/sichuan_ai.mjs';
import { MaJiangAction as Action, MaJiangMsg as Msg, MaJiangResult as Result,
  decodeMaJiangEnvelope, encodeMaJiangEnvelope } from '../mockjs/majiang_pb.mjs';
import { sichuanRoom, sichuanRoomRules } from '../mockjs/sichuan_table.mjs';

const act = (type, tiles = []) => ({ type, tiles });
const wild = { missingSuit: 3, wild: true };
// 一万到九万、一二三筒：四副顺子，只差将牌。
const sequences = [111, 121, 131, 141, 151, 161, 171, 181, 191, 211, 221, 231];
const pons = [[111, 112, 113], [121, 122, 123], [211, 212, 213], [221, 222, 223]]
  .map((tiles) => ({ type: 'pon', tiles }));

function rig({ hands = [[], [], [], []], extra = 29, tail = [], missing = [3, 3, 3, 3] } = {}) {
  const pool = buildSichuanWall({ wild: true });
  const take = (kind) => {
    const index = pool.findIndex((tile) => Math.floor(tile / 10) === kind);
    assert.notEqual(index, -1, `牌例没有多余的${kind}`);
    return pool.splice(index, 1)[0];
  };
  const initial = hands.map((kinds) => kinds.map(take));
  const additional = take(extra);
  const end = tail.map(take);
  // 补足起手时跳过红中，避免随机红中干扰候选断言。
  for (const hand of initial) {
    while (hand.length < 13) hand.push(pool.splice(pool.findIndex((tile) => !isRedZhong(tile)), 1)[0]);
  }
  const engine = new SichuanEngine({ gameType: 5023, exchange: false, topBei: 256,
    wall: [...initial.flat(), additional, ...pool, ...end] });
  for (let seat = 0; seat < 4; seat += 1) submit(engine, seat, act('missing', [missing[seat]]));
  return engine;
}

function submit(engine, seat, chosen) {
  const result = engine.submit(seat, chosen, engine.windowId);
  assert.equal(result.ok, true, JSON.stringify({ seat, chosen, result }));
  invariant(engine);
}

// 114张实体逐动作守恒：牌墙、暗手、副露、未被鸣的牌河、自摸胡牌区与红中杠区恰好各一次。
function invariant(engine) {
  const state = engine.snapshot();
  const owned = [...state.wall, ...state.robbedTiles];
  for (const player of state.players) {
    owned.push(...player.hand, ...player.melds.flatMap((meld) => meld.tiles), ...player.redKongs,
      ...player.river.filter((entry) => !entry.claimed).map((entry) => entry.tile),
      ...player.wins.filter((record) => record.from === null).map((record) => record.tile));
    for (const meld of player.melds) assert.ok(!meld.tiles.some(isRedZhong), '红中不能进入碰杠副露');
  }
  assert.deepEqual([...owned].sort((a, b) => a - b), buildSichuanWall({ wild: true }));
  assert.equal(state.scores.reduce((sum, points) => sum + points, 0), 0);
}

test('红中血流牌墙为108张序数牌加451..456六张红中，普通血战血流仍拒绝红中', () => {
  const wall = buildSichuanWall({ wild: true });
  assert.equal(wall.length, 114);
  assert.equal(new Set(wall).size, 114);
  assert.deepEqual(wall.filter(isRedZhong), [451, 452, 453, 454, 455, 456]);
  assert.equal(sichuanKind(451, true), 27);
  assert.throws(() => sichuanKind(451), RangeError);
  assert.throws(() => new SichuanEngine({ gameType: 5022, wall }), /牌山/);
  assert.throws(() => new SichuanEngine({ gameType: 5023, wall: buildSichuanWall() }), /114/);
  assert.equal(new SichuanEngine({ gameType: 5023, seed: 3 }).snapshot().wall.length, 114 - 53);
});

test('红中可替任意非缺门牌组成顺子、刻子与七对，但不能做将牌单吊', () => {
  // 红中替二筒组成一二三筒，五筒对子为将。
  assert.ok(analyzeSichuanHand([...sequences.slice(0, 10), 451, 251, 252, 231], { ...wild, winTile: 231 }).length);
  // 单吊：四副面子已成，剩一张红中等五筒。红中与和牌组将无效，自摸第二张红中可成（红中金钩钓的同类牌形）。
  assert.equal(analyzeSichuanHand([...sequences, 451, 251], { ...wild, winTile: 251 }).length, 0);
  assert.ok(analyzeSichuanHand([...sequences, 451, 452], { ...wild, winTile: 452 }).length);
  // 金钩钓只剩一张红中：没有可荣和的序数牌等待；暗手里拆面子与真牌组将仍是合法等待。
  assert.deepEqual(sichuanWaitKinds([451], { ...wild, melds: pons }), []);
  const waits = sichuanWaitKinds([...sequences, 451], wild);
  assert.ok(waits.includes(0) && !waits.includes(13), JSON.stringify(waits));
  // 两面等待中的红中照常可用：一二万+红中+...，红中不影响非单吊的等待。
  assert.deepEqual(sichuanWaitKinds([111, 121, 131, 141, 151, 161, 171, 181, 191, 211, 221, 251, 451], wild), [11, 13]);
  // 七对：六对加一张单牌与一张红中，和单牌那种牌也是红中单吊，不成和；真对子照常。
  const pairs = [111, 112, 131, 132, 151, 152, 171, 172, 211, 212, 231, 232];
  assert.equal(analyzeSichuanHand([...pairs, 451, 251], { ...wild, winTile: 251 }).length, 0);
  assert.ok(analyzeSichuanHand([...pairs, 251, 252], { ...wild, winTile: 252 }).length);
  // 红中不能作为碰杠副露，打牌候选也不含红中（打出即红中杠）。
  assert.throws(() => analyzeSichuanHand([111, 112], { ...wild, melds: [{ type: 'pon', tiles: [451, 452, 453] }] }),
    RangeError);
  assert.deepEqual(legalSichuanDiscards([111, 451], 3, true), [111]);
  assert.deepEqual(legalSichuanDiscards([451, 452], 3, true), [451, 452]);
});

test('红中血流计分：红中杠按张数取2~12倍，杠上炮只用于荣和，红中金钩钓只能自摸', () => {
  const hand = [...sequences, 251, 252];
  const names = (result) => result.yaku.map((item) => item.name);
  const base = { missingSuit: 3, gameType: 5023, topBei: 256 };
  const one = scoreSichuanHand(hand, { ...base, winType: 'tsumo', afterKong: true, redKongs: 1 });
  assert.deepEqual(names(one), ['一条龙', '自摸', '杠上开花', '红中杠']);
  assert.equal(one.bei, 4 * 2 * 2 * 2);
  for (const [count, bei] of [[2, 4], [3, 6], [6, 12]]) {
    const result = scoreSichuanHand(hand, { ...base, winType: 'tsumo', redKongs: count });
    assert.equal(result.yaku.at(-1).bei, bei);
    assert.equal(result.yaku.at(-1).name, `红中杠×${count}`);
  }
  assert.ok(names(scoreSichuanHand(hand, { ...base, kongDiscard: true })).includes('杠上炮'));
  assert.throws(() => scoreSichuanHand(hand, { ...base, winType: 'tsumo', kongDiscard: true }), RangeError);
  assert.throws(() => scoreSichuanHand(hand, { ...base, gameType: 5021, redKongs: 1 }), RangeError);
  const hook = scoreSichuanHand([451, 452], { ...base, melds: pons, winType: 'tsumo', winTile: 452 });
  assert.ok(names(hook).includes('红中金钩钓'));
  assert.ok(!names(hook).includes('金钩钓') && !names(hook).includes('碰碰胡'));
});

test('红中杠：不开抢牌窗口、不收底分，从牌尾补牌并可杠上开花', () => {
  const engine = rig({ hands: [[11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 45], [], [], []], extra: 29, tail: [29] });
  const options = engine.legalActions(0);
  const red = options.find((option) => option.type === 'redKong');
  assert.ok(red && isRedZhong(red.tiles[0]));
  assert.ok(!options.some((option) => option.type === 'discard' && isRedZhong(option.tiles[0])));
  submit(engine, 0, red);
  const state = engine.snapshot();
  assert.equal(state.phase, 'turn');
  assert.equal(state.turn, 0, '红中杠后同席补牌，不开抢牌窗口');
  assert.deepEqual(state.players[0].redKongs, red.tiles);
  assert.deepEqual(state.scores, [0, 0, 0, 0], '红中杠不收底分');
  assert.equal(Math.floor(state.drawnTile / 10), 29);
  assert.ok(engine.legalActions(0).some((option) => option.type === 'hu'));
  submit(engine, 0, act('hu'));
  const win = engine.snapshot().players[0].wins[0].score;
  assert.ok(win.yaku.some((item) => item.name === '杠上开花'));
  assert.ok(win.yaku.some((item) => item.name === '红中杠'));
});

test('红中血流换三张可选任意三张；AI换牌不送出红中，定缺不会选红中', () => {
  const engine = new SichuanEngine({ gameType: 5023, seed: 11, topBei: 256 });
  const suits = (tiles) => new Set(tiles.map((tile) => Math.floor(tile / 100))).size;
  assert.ok(engine.legalActions(0).some((option) => suits(option.tiles) > 1));
  const hand = engine.view(0).hand;
  const exchange = chooseSichuanExchange(hand, true);
  assert.equal(exchange.length, 3);
  assert.ok(!exchange.some(isRedZhong));
  assert.ok([1, 2, 3].includes(chooseSichuanMissingSuit([...hand.slice(0, 12), 451, 452].slice(0, 14), true)));
  const plain = new SichuanEngine({ gameType: 5022, seed: 11, topBei: 128 });
  assert.ok(plain.legalActions(0).every((option) => suits(option.tiles) === 1));
});

test('红中血流AI自战逐动作守恒、只在牌墙摸完时结束且固定种子可复现', { timeout: 120000 }, () => {
  for (const seed of [1, 2, 5]) {
    const play = () => {
      const engine = new SichuanEngine({ gameType: 5023, seed, dealer: seed % 4, topBei: 256, baseScore: 2 });
      let count = 0;
      while (engine.phase !== 'ended') {
        assert.ok(count++ < 800, `seed ${seed} 卡局`);
        const seat = [0, 1, 2, 3].find((value) => engine.legalActions(value).length);
        submit(engine, seat, engine.chooseAction(seat));
      }
      assert.equal(engine.snapshot().endReason, 'wall');
      return engine.snapshot();
    };
    assert.deepEqual(play(), play());
  }
});

test('房间：红中血流可组桌，免费场原表封顶0按128倍执行，无血流累计输分上限', () => {
  assert.deepEqual(sichuanRoomRules(sichuanRoom(5023, 502301)),
    { gameType: 5023, exchange: true, topBei: 128, baseScore: 1 });
  assert.equal(sichuanRoomRules(sichuanRoom(5023, 502306)).topBei, 256);
  assert.equal(new SichuanEngine({ gameType: 5023, topBei: 256 }).snapshot().rules.lossCap, null);
});

test('上行：原客户端以 Normal 打出红中时裁决为红中杠，普通出牌不受影响', () => {
  const calls = [];
  const view = { phase: 'turn', hand: [111, 451], connectionId: 3, windowId: 8, status: 'playing', connected: true,
    options: [act('discard', [111]), act('redKong', [451])] };
  const session = { view: () => structuredClone(view), submit(chosen) { calls.push(chosen); return { ok: true }; } };
  const send = (card) => {
    const result = handleSichuanRequest(session, encodeMaJiangEnvelope(Msg.EReqPlayCard, { action: Action.Normal, card }),
      session.view());
    return decodeMaJiangEnvelope(result.response).payload.result;
  };
  assert.equal(send(451), Result.Succ);
  assert.equal(send(111), Result.Succ);
  assert.deepEqual(calls, [act('redKong', [451]), act('discard', [111])]);
});

class ControlledSession extends SichuanSession {
  phaseStatus = 'idle';
  constructor(engine) {
    super({ gameType: 5023, humanSeat: 0 });
    this.engine = engine;
  }
  get status() { return this.engine.phase === 'ended' ? 'ended' : this.phaseStatus; }
  snapshot() { return this.engine.snapshot(); }
  view() { return { ...this.engine.view(0), status: this.status }; }
}

function project(engine) {
  const session = new ControlledSession(engine);
  const projection = new SichuanNotifications(session, { gameID: 'red-zhong', userIds: [1, 2, 3, 4],
    initialScores: [1000, 1000, 1000, 1000], scoreType: 1 });
  const read = () => projection.read().map((frame) => decodeMaJiangEnvelope(frame.bytes));
  session.phaseStatus = 'preparing';
  read();
  session.phaseStatus = 'playing';
  return { read, start: read().find((frame) => frame.name === 'NtfGameStart').payload };
}

test('下行：开局下发红中赖子450与任意换牌规则，红中杠按 Normal 出牌并接补牌', () => {
  const { start } = project(new SichuanEngine({ gameType: 5023, seed: 4, topBei: 256 }));
  assert.deepEqual(start.guiCards, [450]);
  assert.equal(start.changeCardRule, 2);
  assert.equal(project(new SichuanEngine({ gameType: 5022, seed: 4 })).start.guiCards.length, 0);

  // 庄家起手只有万子和一张红中，定缺条子后可直接红中杠。
  const pool = buildSichuanWall({ wild: true });
  const ordinary = pool.filter((tile) => !isRedZhong(tile));
  const wall = [...ordinary.slice(0, 12), 451, ...ordinary.slice(12), ...pool.filter((tile) => tile > 451)];
  const engine = new SichuanEngine({ gameType: 5023, exchange: false, topBei: 256, wall });
  const { read } = project(engine);
  for (let seat = 0; seat < 4; seat += 1) {
    assert.equal(engine.submit(seat, act('missing', [3]), engine.windowId).ok, true);
    read();
  }
  const option = engine.legalActions(0).find((entry) => entry.type === 'redKong');
  assert.deepEqual(option, act('redKong', [451]));
  assert.equal(engine.submit(0, option, engine.windowId).ok, true);
  const frames = read();
  const names = frames.map((frame) => frame.name);
  const playCard = frames.find((frame) => frame.name === 'NtfPlayCard');
  assert.equal(playCard.payload.card, 451);
  assert.equal(playCard.payload.action, Action.Normal);
  const sendCard = frames.find((frame) => frame.name === 'NtfSendCard');
  assert.equal(sendCard.payload.seat, 0);
  assert.ok(names.indexOf('NtfPlayCard') < names.indexOf('NtfSendCard'), names.join());
});
