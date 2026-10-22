import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { GameEngine } from '../mockjs/engine.mjs';
import { PlayAction } from '../mockjs/proto_enum.mjs';
import { tileId } from '../mockjs/tiles.mjs';
import { chooseDiscardByPolicy, makeSearch, publicContext, winCurve, createDecisionBudget, riichiPolicy, estimateValue } from '../mockjs/riichi_ai_policy.mjs';

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

test('三档复用候选评估，高级保留搜索，中级移除搜索，低级再移除待牌质量细化', () => {
  const hand = makeTiles([[1, [2, 3, 4, 5, 5, 5]], [2, [3, 4]], [3, [6, 7, 9]], [2, [6, 6]], [4, [7]]]);
  const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)]);
  const results = ['basic', 'intermediate', 'advanced'].map((level) => {
    const budget = createDecisionBudget();
    const result = chooseDiscardByPolicy(engine, 0, { level, budget });
    assert.ok(hand.includes(result.discardId));
    assert.ok(Number.isFinite(result.ev));
    return result;
  });
  assert.equal(results[0].searched, 0);
  assert.equal(results[0].budget.calcUsed, 0);
  assert.equal(results[0].budget.workUsed, 0);
  assert.equal(results[1].searched, 0);
  assert.equal(results[1].budget.calcUsed, 0);
  assert.ok(results[1].budget.workUsed > 0);
  assert.ok(results[2].searched > 0);
  assert.ok(results[2].budget.calcUsed > 0);
  assert.equal(results[0].budget.baseWork, results[1].budget.baseWork);
  assert.equal(results[1].budget.baseWork, results[2].budget.baseWork);
});

for (const level of ['basic', 'intermediate', 'advanced']) {
  test(`${level}：裁减思考仍保留禁打、振听、拔北估值与隐藏信息隔离`, () => {
    const hand = makeTiles([[2, [1, 2, 3, 4, 5, 6]], [3, [2, 3, 4, 6, 7]], [4, [5, 5]], [2, [9]]]);
    const p = makePlayer(0, hand);
    p.riichiFuriten = true;
    p.melds = [{ type: 'babei', tiles: [441] }];
    const engine = makeEngine([p, makePlayer(1), makePlayer(2)], { aiLevel: level });
    engine.doraIndicators = [431, 432];
    const denyRead = (object, key) => Object.defineProperty(object, key, { get() { assert.fail(`AI 读取隐藏字段 ${key}`); } });
    for (const opponent of engine.players.slice(1)) {
      for (const key of ['hand', 'drawnTile', 'waits', 'waitTiles', 'shanten']) denyRead(opponent, key);
    }
    for (const key of ['wall', 'replacements', 'uraIndicators']) denyRead(engine, key);
    const forbiddenKinds = new Set([29]);
    const first = chooseDiscardByPolicy(engine, 0, { level, forbiddenKinds });
    assert.notEqual(Math.floor(first.discardId / 10), 29);
    assert.deepEqual(chooseDiscardByPolicy(engine, 0, { level, forbiddenKinds }), first);
    assert.deepEqual(engine.aiClaim(0, 1, 554, [PlayAction.Hu, PlayAction.Guo]), { action: PlayAction.Hu });
    const decision = riichiPolicy(engine, 0, [29], level);
    assert.ok(decision === null || ['riichi', 'dama'].includes(decision.action));
    const ctx = publicContext(engine, 0, null, level);
    assert.ok(estimateValue(ctx, hand.slice(0, -1), p.melds) > estimateValue(ctx, hand.slice(0, -1), []));
    assert.equal(chooseDiscardByPolicy(engine, 0, { level, budget: createDecisionBudget({ work: 0, calc: 0 }) }).budget.workUsed, 0);
  });
  test(`${level}：三麻保留国士必需北，不裁减规则安全检查`, () => {
    const hand = makeTiles([[1, [1, 9]], [2, [1, 9]], [3, [1, 9]], [4, [1, 2, 3, 4, 5, 6, 7]], [2, [5]]]);
    const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2)], { aiLevel: level });
    const decision = engine.aiTurn(0, true, [PlayAction.Normal, PlayAction.BaBei]);
    assert.equal(decision.action, PlayAction.Normal);
    assert.notEqual(Math.floor(decision.card / 10), 44);
  });
}

test('和牌概率随向听下降、随受入和剩余巡数上升', () => {
  const ctx = { unseen: 100, n: 4, survival: 0.95 };
  assert.ok(winCurve(ctx, 0, 8, 12) > winCurve(ctx, 1, 20, 12));
  assert.ok(winCurve(ctx, 1, 20, 12) > winCurve(ctx, 2, 40, 12));
  assert.ok(winCurve(ctx, 1, 30, 12) > winCurve(ctx, 1, 12, 12));
  assert.ok(winCurve(ctx, 0, 8, 12) > winCurve(ctx, 0, 8, 3));
  assert.equal(winCurve(ctx, 0, 8, 0), 0);
});

test('中级：远向听低打点面对立直时打现物弃和', () => {
  // Three-shanten, no dora; the only safe tile in hand is 9p.
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
  // One-shanten with three dora tiles (indicator 4m → dora 5m); the floating 9s is not genbutsu, and the only genbutsu is the 3p in hand (split shape).
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
  // 1s and 9s are both isolated terminals; 9s is dora (indicator 8s).
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
  // After chi 234m, the closed part 234p 456m 55p 78s waits on 6s/9s; winning on 9s forms 789s and breaks tanyao, so the open hand has no yaku.
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
  // Closed-hand tenpai (the 1m triplet is dora): an open kan would lose riichi and the menzen value.
  const closed = [111, 112, 113, 211, 212, 213, 221, 222, 223, 231, 232, 233, 241];
  const a = makeEngine([makePlayer(0), makePlayer(1, closed), makePlayer(2), makePlayer(3)]);
  a.doraIndicators = [191];
  a.players[0].discards.push(114);
  assert.equal(a.aiClaim(1, 0, 114, [PlayAction.MingGang, PlayAction.Peng, PlayAction.Guo]), null);

  // Open tenpai with a pon of 2p; the Chun triplet is dora, so an open kan does not change the wait and gives one more kan-dora chance.
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

test('AI 全自动对局：三档混合打完东风战且守恒', async () => {
  for (const players of [3, 4]) {
    let final = null;
    const engine = new GameEngine({
      players,
      startScore: players === 3 ? 35_000 : 25_000,
      speed: 0,
      seed: 4242 + players,
      autoHuman: true,
      aiLevels: ['advanced', 'intermediate', 'basic', 'basic'],
      emit: () => {},
      onFinish: (scores) => { final = scores.slice(); },
    });
    await engine.start();
    assert.ok(final, `${players} 人对局应终局`);
    const sticks = engine.riichiSticks * 1000;
    assert.equal(final.reduce((a, b) => a + b, 0) + sticks, players * (players === 3 ? 35_000 : 25_000));
  }
});
