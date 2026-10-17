import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { GameEngine } from '../mockjs/engine.mjs';
import { PlayAction } from '../mockjs/proto_enum.mjs';
import { tileId } from '../mockjs/tiles.mjs';
import { chooseDiscardByPolicy, makeSearch, publicContext, winCurve } from '../mockjs/riichi_ai_policy.mjs';

function makeTiles(groups) {
  const copies = new Map();
  return groups.flatMap(([suit, ranks]) => ranks.map((rank) => {
    const key = suit * 10 + rank;
    const copy = (copies.get(key) || 0) + 1;
    copies.set(key, copy);
    return tileId(suit, rank, copy);
  }));
}

function makePlayer(seat, hand = [], score = 25_000) {
  return {
    seat, isHuman: false, score, timeBank: 0,
    hand: hand.slice(), melds: [], discards: [], discardClaimed: false, discardKinds: new Set(),
    riichi: false, doubleRiichi: false, riichiTurn: -1, riichiPending: false, ippatsu: false, menzen: true,
    waits: [], waitTiles: [], tempFuriten: false, riichiFuriten: false,
    drawnTile: hand.at(-1) ?? null, rinshan: false, pao: {},
  };
}

function makeEngine(players, opts = {}) {
  const engine = new GameEngine({ players: players.length, speed: 0, ...opts });
  engine.players = players;
  engine.akaSet = new Set();
  engine.doraIndicators = [];
  engine.uraIndicators = [];
  engine.roundWind = 1;
  engine.juNum = 0;
  engine.dealerSeat = 0;
  engine.remain = 40;
  engine.xunNum = 8;
  return engine;
}

function riichiOpponent(player, discardKinds) {
  player.riichi = true;
  player.discardKinds = new Set(discardKinds);
  player.discards = discardKinds.map((kind) => tileId(Math.floor(kind / 10), kind % 10, 4));
}

test('难度：默认中级，可按座位指定，未知值回落中级', () => {
  assert.deepEqual(new GameEngine({ players: 4 }).aiLevels, Array(4).fill('intermediate'));
  assert.deepEqual(new GameEngine({ players: 3, aiLevel: 'advanced' }).aiLevels, Array(3).fill('advanced'));
  assert.deepEqual(
    new GameEngine({ players: 4, aiLevels: ['basic', 'advanced', 'bogus'] }).aiLevels,
    ['basic', 'advanced', 'intermediate', 'intermediate'],
  );
});

test('和牌概率随向听下降、随受入和剩余巡数上升', () => {
  const ctx = { unseen: 100, n: 4, survival: 0.95 };
  assert.ok(winCurve(ctx, 0, 8, 12) > winCurve(ctx, 1, 20, 12));
  assert.ok(winCurve(ctx, 1, 20, 12) > winCurve(ctx, 2, 40, 12));
  assert.ok(winCurve(ctx, 1, 30, 12) > winCurve(ctx, 1, 12, 12));
  assert.ok(winCurve(ctx, 0, 8, 12) > winCurve(ctx, 0, 8, 3));
  assert.equal(winCurve(ctx, 0, 8, 0), 0);
});

test('中级：远向听低打点面对立直时打现物弃和', () => {
  // 三向听、无宝牌；手里唯一的现物是 9p。
  const hand = makeTiles([
    [1, [1, 4, 7]],
    [2, [2, 5, 9]],
    [3, [3, 6, 8]],
    [4, [1, 2, 3, 5]],
    [1, [9]],
  ]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  riichiOpponent(players[1], [29, 47]);
  const engine = makeEngine(players);
  const decision = chooseDiscardByPolicy(engine, 0, { level: 'intermediate' });
  assert.equal(Math.floor(decision.discardId / 10), 29);
  assert.equal(decision.fold, true);
});

test('中级：一向听且宝牌多时面对立直继续进攻，不为现物拆搭子', () => {
  // 一向听，三张宝牌（指示牌 4m → 5m 宝牌），浮牌 9s 不是现物，现物只有手里的 3p（拆好型）。
  const hand = makeTiles([
    [1, [2, 3, 4, 5, 5, 5]],
    [2, [3, 4]],
    [3, [6, 7, 9]],
    [2, [6, 6]],
    [4, [7]],
  ]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  riichiOpponent(players[1], [23]);
  const engine = makeEngine(players);
  engine.doraIndicators = [tileId(1, 4, 4)];
  const decision = chooseDiscardByPolicy(engine, 0, { level: 'intermediate' });
  assert.notEqual(Math.floor(decision.discardId / 10), 23);
  assert.equal(decision.fold, false);
  assert.equal(decision.shanten, 1);
});

test('中级：效率相同时保留宝牌', () => {
  // 1s 与 9s 都是孤张幺九，9s 是宝牌（指示牌 8s）。
  const hand = makeTiles([
    [1, [1, 2, 3, 5, 6, 7]],
    [2, [2, 3, 4, 7, 8]],
    [3, [1, 9]],
    [2, [5]],
  ]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  engine.doraIndicators = [tileId(3, 8, 4)];
  const decision = chooseDiscardByPolicy(engine, 0, { level: 'intermediate' });
  assert.equal(Math.floor(decision.discardId / 10), 31);
});

test('高级：搜索按真实役种估值，开门无役的待牌不计入有效受入', () => {
  // 吃 234m 后门前 234p 456m 55p 78s：待 6s/9s；和 9s 成 789s 破坏断幺，开门无役。
  const concealed = makeTiles([[2, [2, 3, 4, 5, 5]], [1, [4, 5, 6]], [3, [7, 8]]]);
  const chi = { type: 'chi', tiles: [tileId(1, 2, 2), tileId(1, 3, 2), tileId(1, 4, 2)] };
  const player = makePlayer(0, concealed);
  player.melds = [chi];
  player.menzen = false;
  const engine = makeEngine([player, makePlayer(1), makePlayer(2), makePlayer(3)]);
  const search = makeSearch(publicContext(engine, 0), player.melds, 900);
  const profile = search.tenpaiProfile(concealed);
  assert.equal(profile.ukeire, 4, '只有 6s 有役');
  assert.ok(profile.points >= 1000);
});

test('高级：决策确定、不读隐藏信息，且单次决策在 1 秒内', () => {
  const hand = makeTiles([
    [1, [1, 2, 3, 4, 6]],
    [2, [2, 3, 5, 7, 8]],
    [3, [3, 4, 5, 9]],
  ]);
  const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)], { aiLevel: 'advanced' });
  engine.doraIndicators = [tileId(2, 4, 4)];
  const evaluate = () => engine.aiTurn(0, true, [PlayAction.Normal]);
  const start = performance.now();
  const expected = evaluate();
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1_000, `高级决策耗时 ${elapsed.toFixed(1)}ms`);
  const denyRead = (object, key) => Object.defineProperty(object, key, {
    get() { assert.fail(`AI 读取了隐藏字段 ${key}`); },
  });
  for (const opponent of engine.players.slice(1)) {
    for (const key of ['hand', 'drawnTile', 'waits', 'waitTiles', 'shanten']) denyRead(opponent, key);
  }
  for (const key of ['wall', 'replacements', 'uraIndicators']) denyRead(engine, key);
  for (let i = 0; i < 5; i++) assert.deepEqual(evaluate(), expected);
});

test('中级：鸣牌与跳过同用期望值比较——门清高打点听牌不大明杠，开门役牌刻子可大明杠并提交三张实体牌', () => {
  // 门清听牌（1m 刻子为宝牌）：大明杠会失去立直与门清价值。
  const closed = [111, 112, 113, 211, 212, 213, 221, 222, 223, 231, 232, 233, 241];
  const a = makeEngine([makePlayer(0), makePlayer(1, closed), makePlayer(2), makePlayer(3)]);
  a.doraIndicators = [191];
  a.players[0].discards.push(114);
  assert.equal(a.aiClaim(1, 0, 114, [PlayAction.MingGang, PlayAction.Peng, PlayAction.Guo]), null);

  // 已碰 2p 的开门听牌，暗刻中且中是宝牌：大明杠中不改变听牌，多一次杠宝机会。
  const open = makeTiles([[4, [7, 7, 7]], [1, [2, 3, 4, 6, 7]], [3, [5, 5]]]);
  const p = makePlayer(1, open);
  p.melds = [{ type: 'pon', tiles: [tileId(2, 2, 1), tileId(2, 2, 2), tileId(2, 2, 3)], from: 0 }];
  p.menzen = false;
  const b = makeEngine([makePlayer(0), p, makePlayer(2), makePlayer(3)]);
  b.doraIndicators = [tileId(4, 6, 4)];
  const zhong = tileId(4, 7, 4);
  b.players[0].discards.push(zhong);
  const decision = b.aiClaim(1, 0, zhong, [PlayAction.MingGang, PlayAction.Peng, PlayAction.Guo]);
  assert.equal(decision?.action, PlayAction.MingGang);
  assert.deepEqual([...decision.otherCards].sort(), open.slice(0, 3).sort());
});

test('AI 全自动对局：中级与高级混合打完东风战且守恒', async () => {
  for (const players of [3, 4]) {
    let final = null;
    const engine = new GameEngine({
      players,
      startScore: players === 3 ? 35_000 : 25_000,
      speed: 0,
      seed: 4242 + players,
      autoHuman: true,
      aiLevels: ['advanced', 'intermediate', 'advanced', 'intermediate'],
      emit: () => {},
      onFinish: (scores) => { final = scores.slice(); },
    });
    await engine.start();
    assert.ok(final, `${players} 人对局应终局`);
    const sticks = engine.riichiSticks * 1000;
    assert.equal(final.reduce((a, b) => a + b, 0) + sticks, players * (players === 3 ? 35_000 : 25_000));
  }
});
