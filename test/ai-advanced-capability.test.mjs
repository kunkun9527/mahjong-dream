// 高级 AI 能力固定用例：读牌防守、押引、追立直、立直/默听与改良、振听感知、顺位效用、
// 杠的押引门控；同时验证只读可见信息、确定性与耗时预算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { GameEngine } from '../mockjs/engine.mjs';
import { PlayAction } from '../mockjs/proto_enum.mjs';
import { tileId } from '../mockjs/tiles.mjs';
import { chooseDiscardByPolicy, makeSearch, placementUtility, publicContext, readThreats, riichiPolicy } from '../mockjs/riichi_ai_policy.mjs';

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
  const engine = new GameEngine({ players: players.length, speed: 0, aiLevel: 'advanced', ...opts });
  engine.players = players;
  engine.akaSet = new Set();
  engine.doraIndicators = [];
  engine.uraIndicators = [];
  engine.roundWind = 1;
  engine.juNum = 0;
  engine.dealerSeat = 0;
  engine.remain = 40;
  engine.xunNum = 8;
  engine.discardLog = [];
  return engine;
}

// 公开弃牌：写入牌河与公开日志（第 4 枚实体，避免与手牌冲突）。
function discard(engine, seat, kind, { riichi = false, tsumogiri = false } = {}) {
  const p = engine.players[seat];
  p.discards.push(tileId(Math.floor(kind / 10), kind % 10, 4));
  p.discardKinds.add(kind);
  engine.discardLog.push({ seat, kind, tsumogiri, riichi });
  if (riichi) p.riichi = true;
}

const suitOf = (id) => Math.floor(id / 100);
const kindOfId = (id) => Math.floor(id / 10);
const idx = (kind) => {
  const suit = Math.floor(kind / 10);
  const rank = kind % 10;
  return suit === 4 ? 27 + rank - 1 : (suit - 1) * 9 + rank - 1;
};

test('读牌：现物与立直后通过牌为零风险，筋/壁/字牌见张降低风险，中张最危险', () => {
  const players = [makePlayer(0), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  discard(engine, 1, 41);
  discard(engine, 1, 14);
  discard(engine, 1, 29, { riichi: true });
  discard(engine, 2, 26); // 立直后他家打出、立直者未荣和：同样安全
  const read = readThreats(engine, 0, () => 3);
  // 只看立直者的命中率（其他门清家各有极小听牌概率）。
  const loss = read.threats.find((t) => t.seat === 1).hit;
  assert.equal(loss[idx(14)], 0, '现物');
  assert.equal(loss[idx(29)], 0, '现物');
  assert.equal(loss[idx(26)], 0, '立直后通过牌');
  assert.ok(loss[idx(17)] < loss[idx(15)], '4m 的筋 7m 比无筋 5m 安全');
  assert.ok(loss[idx(11)] < loss[idx(15)], '筋 1m 比 5m 安全');
  assert.ok(loss[idx(23)] < loss[idx(22)], '6p 通过后其筋 3p 比 2p 安全');
  // 字牌：见张越多越安全。
  const hitOf = (r) => r.threats.find((t) => t.seat === 1).hit[idx(45)];
  const one = hitOf(readThreats(engine, 0, (i) => (i === idx(45) ? 1 : 3)));
  const three = hitOf(readThreats(engine, 0, () => 3));
  assert.ok(one < three, '剩 1 枚的字牌只剩单骑可能');
  const riichi = read.threats.find((t) => t.seat === 1);
  assert.equal(riichi.tenpai, 1);
  for (const t of read.threats.filter((x) => x.seat !== 1)) assert.ok(t.tenpai < 0.05, '牌河短的门清家几乎不计威胁');
});

test('读牌：副露染手者对其他花色几乎不构成威胁，副露越多听牌概率越高', () => {
  const players = [makePlayer(0), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  players[2].melds = [
    { type: 'pon', tiles: [tileId(2, 2, 1), tileId(2, 2, 2), tileId(2, 2, 3)] },
    { type: 'chi', tiles: [tileId(2, 5, 1), tileId(2, 6, 1), tileId(2, 7, 1)] },
  ];
  players[2].menzen = false;
  for (const k of [11, 19, 34, 38, 41, 15, 36]) discard(engine, 2, k);
  const read = readThreats(engine, 0, () => 3);
  const t = read.threats.find((x) => x.seat === 2);
  assert.ok(t.tenpai > 0.3, `两副露、7 张舍牌应有较高听牌概率：${t.tenpai}`);
  assert.ok(t.hit[idx(24)] > 4 * t.hit[idx(14)], '筒子清一色读牌：4p 远比 4m 危险');
});

test('高级：远向听低打点面对立直打现物弃和', () => {
  const hand = makeTiles([
    [1, [1, 4, 7]],
    [2, [2, 5, 9]],
    [3, [3, 6, 8]],
    [4, [1, 2, 3, 5]],
    [1, [9]],
  ]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  discard(engine, 1, 47);
  discard(engine, 1, 29, { riichi: true });
  const decision = chooseDiscardByPolicy(engine, 0, { level: 'advanced' });
  assert.equal(kindOfId(decision.discardId), 29);
  assert.equal(decision.fold, true);
});

test('高级：一向听且宝牌多时面对立直继续进攻', () => {
  const hand = makeTiles([
    [1, [2, 3, 4, 5, 5, 5]],
    [2, [3, 4]],
    [3, [6, 7, 9]],
    [2, [6, 6]],
    [4, [7]],
  ]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  engine.doraIndicators = [tileId(1, 4, 4)];
  discard(engine, 1, 23, { riichi: true });
  const decision = chooseDiscardByPolicy(engine, 0, { level: 'advanced' });
  assert.equal(decision.fold, false);
  assert.equal(decision.shanten, 1);
});

test('高级：进攻时效率相同则打更安全的牌', () => {
  // 孤张 5s 与 1s 效率相近；1s 是立直者现物。
  const hand = makeTiles([
    [1, [1, 2, 3, 5, 6, 7]],
    [2, [2, 3, 4, 7, 8]],
    [3, [1, 5]],
    [2, [5]],
  ]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  discard(engine, 1, 31, { riichi: true });
  const decision = chooseDiscardByPolicy(engine, 0, { level: 'advanced' });
  assert.equal(kindOfId(decision.discardId), 31);
});

test('高级：好型高打点听牌追立直，不因先制立直弃和', () => {
  // 234m 567m 345p 66s 78s + 宝牌 5m：听 69s 两面。
  const hand = makeTiles([
    [1, [2, 3, 4, 5, 6, 7]],
    [2, [3, 4, 5]],
    [3, [6, 6, 7, 8]],
    [4, [5]],
  ]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  engine.doraIndicators = [tileId(1, 4, 4)];
  discard(engine, 1, 45, { riichi: true });
  const kinds = engine.formalTenpaiDiscards(players[0]);
  const decision = riichiPolicy(engine, 0, kinds, 'advanced');
  assert.equal(decision?.action, 'riichi');
  assert.equal(kindOfId(decision.card), 45);
});

test('高级：门清早巡听牌立直（无役嵌张与两面平和都立直，不默听等改良）', () => {
  // 123m 567p 789s 99p + 24m/34m + 6s：打 6s 分别听 3m 嵌张（无役）、2-5m 两面（平和）。
  for (const ranks of [[1, 2, 3, 2, 4], [1, 2, 3, 3, 4]]) {
    const hand = makeTiles([[1, ranks], [2, [5, 6, 7, 9, 9]], [3, [7, 8, 9]], [3, [6]]]);
    const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
    const engine = makeEngine(players);
    engine.remain = 60;
    const decision = riichiPolicy(engine, 0, engine.formalTenpaiDiscards(players[0]), 'advanced');
    assert.equal(decision?.action, 'riichi', `手牌 ${ranks.join('')}m`);
  }
});

test('高级：振听听牌只计自摸，荣和受入为 0；打出待牌本身也构成振听', () => {
  // 234m 678m 345p 55s 67s：听 5s/8s。
  const hand = makeTiles([[1, [2, 3, 4, 6, 7, 8]], [2, [3, 4, 5]], [3, [5, 5, 6, 7]]]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  const fresh = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900).tenpaiProfile(hand);
  assert.ok(fresh.ukeire > 0 && fresh.ronUkeire > 0);
  const viaExtra = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900).tenpaiProfile(hand, [idx(38)]);
  assert.equal(viaExtra.ronUkeire, 0, '本次打出 8s 后听 8s 是振听');
  discard(engine, 0, 38);
  const furiten = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900).tenpaiProfile(hand);
  assert.equal(furiten.ronUkeire, 0);
  assert.ok(furiten.ukeire > 0, '仍可自摸');
});

test('高级：同枚数待牌中，字牌单骑比中张单骑荣和权重更高', () => {
  // 123m 456m 789p 234s + 单骑：白 vs 6s。
  const base = [[1, [1, 2, 3, 4, 5, 6]], [2, [7, 8, 9]], [3, [2, 3, 4]]];
  const honor = makeTiles([...base, [4, [5]]]);
  const middle = makeTiles([...base, [3, [6]]]);
  const engine = makeEngine([makePlayer(0, honor), makePlayer(1), makePlayer(2), makePlayer(3)]);
  const search = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900);
  const a = search.tenpaiProfile(honor);
  const b = search.tenpaiProfile(middle);
  assert.ok(a.ronUkeire / a.ukeire > b.ronUkeire / b.ukeire);
});

test('顺位效用：All Last 逆转所需的打点额外加值，放铳掉位额外扣值', () => {
  const players = [makePlayer(0, [], 30_000), makePlayer(1, [], 27_000), makePlayer(2, [], 23_000), makePlayer(3, [], 20_000)];
  const engine = makeEngine(players);
  engine.isAllLast = () => true;
  const util = placementUtility(engine, 1);
  assert.ok(util.gain(3900) > 3900 + 5000, '二位 3900 和牌逆转一位');
  assert.ok(Math.abs(util.gain(1000) - 1000) < 5000, '1000 点不改变顺位时几乎无加值');
  assert.ok(util.loss(3, 8000) > 8000 + 5000, '放铳给末位 8000 会掉位');
  engine.isAllLast = () => false;
  assert.equal(placementUtility(engine, 1), null, '非 All Last 不加顺位修正');
});

test('高级：面对立直且手牌差时不暗杠，无威胁时暗杠', () => {
  const hand = makeTiles([[1, [1, 1, 1, 1]], [2, [2, 5, 9]], [3, [3, 6, 8]], [4, [1, 2, 3]], [3, [1]]]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  const can = [PlayAction.Normal, PlayAction.AnGang];
  assert.equal(engine.aiTurn(0, true, can).action, PlayAction.AnGang);
  discard(engine, 1, 29, { riichi: true });
  assert.notEqual(engine.aiTurn(0, true, can).action, PlayAction.AnGang);
});

test('高级：面对威胁的决策确定、不读隐藏信息、耗时在 1 秒内', () => {
  const hand = makeTiles([[1, [1, 2, 3, 4, 6]], [2, [2, 3, 5, 7, 8]], [3, [3, 4, 5, 9]]]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  engine.doraIndicators = [tileId(2, 4, 4)];
  discard(engine, 1, 41);
  discard(engine, 1, 18, { riichi: true });
  players[2].melds = [{ type: 'pon', tiles: [tileId(4, 5, 1), tileId(4, 5, 2), tileId(4, 5, 3)] }];
  players[2].menzen = false;
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
