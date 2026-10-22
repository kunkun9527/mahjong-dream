// Search correctness and whole-decision budget of the advanced AI: a hypothetical draw deducts the remaining count, riichi legality, kokushi risk,
// deterministic fallback on budget exhaustion, and the hidden-field trap installed before the first evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../mockjs/engine.mjs';
import { PlayAction } from '../mockjs/proto_enum.mjs';
import { tileId } from '../mockjs/tiles.mjs';
import { calcWin } from '../mockjs/ai.mjs';
import {
  chooseDiscardByPolicy, claimPolicy, createDecisionBudget, makeSearch, publicContext, readThreats, riichiPolicy,
} from '../mockjs/riichi_ai_policy.mjs';
import { kokushiModel } from '../mockjs/riichi_ai_read.mjs';

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

function makeEngine(players) {
  const engine = new GameEngine({ players: players.length, speed: 0, aiLevel: 'advanced' });
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

function discard(engine, seat, kind, { riichi = false } = {}) {
  const p = engine.players[seat];
  p.discards.push(tileId(Math.floor(kind / 10), kind % 10, 4));
  p.discardKinds.add(kind);
  engine.discardLog.push({ seat, kind, tsumogiri: false, riichi });
  if (riichi) p.riichi = true;
}

const kindOfId = (id) => Math.floor(id / 10);
const idx = (kind) => {
  const suit = Math.floor(kind / 10);
  const rank = kind % 10;
  return suit === 4 ? 27 + rank - 1 : (suit - 1) * 9 + rank - 1;
};

// 123m 456m 789p white tanki (13 tiles).
const WHITE_TANKI = [[1, [1, 2, 3, 4, 5, 6]], [2, [7, 8, 9]], [3, [2, 3, 4]], [4, [5]]];
// 123m 456m 789p 24s 99s: kanchan wait on 3s; menzen with no yaku (only riichi or tsumo wins).
const KANCHAN_NO_YAKU = [[1, [1, 2, 3, 4, 5, 6]], [2, [7, 8, 9]], [3, [2, 4, 9, 9]]];

test('搜索：路径上假想摸入的牌从待牌剩余枚数中扣除，缓存键区分已摸牌', () => {
  const hand = makeTiles(WHITE_TANKI);
  const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)]);
  const search = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900);
  const root = search.tenpaiProfile(hand);
  const after = search.tenpaiProfile(hand, [], [idx(45)]);
  assert.equal(root.ukeire, 3);
  assert.equal(after.ukeire, 2, '白已被摸走一张');
  assert.equal(search.tenpaiProfile(hand).ukeire, 3, '同一手牌不同 drawn 不共用缓存');
  // Counter-example: drawing a tile unrelated to the waits does not change the ukeire.
  assert.equal(search.tenpaiProfile(hand, [], [idx(11)]).ukeire, 3);
});

test('估值：立直不合法（点棒不足）时荣和受入不按立直计，合法时才计', () => {
  const hand = makeTiles(KANCHAN_NO_YAKU);
  const profileOf = (score) => {
    const engine = makeEngine([makePlayer(0, hand, score), makePlayer(1), makePlayer(2), makePlayer(3)]);
    const search = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900);
    return search.tenpaiProfile(hand);
  };
  const legal = profileOf(25_000);
  const illegal = profileOf(500);
  assert.ok(legal.ronUkeire > 0, '合法立直：嵌张无役听牌可荣和');
  assert.equal(illegal.ronUkeire, 0, '立直不合法且默听无役：只剩自摸，不计荣和');
  assert.ok(illegal.ukeire > 0, '门清自摸仍可和');
  assert.ok(legal.points > illegal.points, '合法立直的打点更高');
});

test('读牌：国士区分单面与十三面振听；舍过幺九或拔北不代表不可能国士', () => {
  const avail = new Array(34).fill(3);
  const furiten = new Set([idx(25)]);
  const model = kokushiModel({ riichi: true, melds: [], discardKinds: new Set([25]) }, furiten, avail);
  assert.ok(model && model.prior > 0);
  assert.ok(model.hit[idx(41)] > 0 && model.hit[idx(19)] > 0, '未见幺九牌有放铳可能');
  assert.equal(model.hit[idx(15)], 0, '中张不可能放国士');
  // An open or closed-kan hand truly cannot be kokushi; North pull is not a meld.
  assert.equal(kokushiModel({ riichi: true, melds: [{ type: 'chi', tiles: [] }], discardKinds: new Set() }, new Set(), avail), null);
  assert.equal(kokushiModel({ riichi: true, melds: [{ type: 'ankan', tiles: [] }], discardKinds: new Set() }, new Set(), avail), null);
  assert.ok(kokushiModel({ riichi: true, melds: [{ type: 'babei', tiles: [441] }], discardKinds: new Set() }, new Set(), avail));
  const two = new Set([idx(11), idx(41)]);
  const discarded = kokushiModel({ riichi: true, melds: [], discardKinds: new Set([11, 41]) }, two, avail);
  assert.ok(discarded.prior > 0 && discarded.prior < model.prior);
  assert.equal(discarded.hit[idx(11)], 0);
  assert.ok(discarded.hit[idx(19)] > 0 && discarded.hit[idx(19)] < model.hit[idx(19)], '十三面因振听排除，但单面仍可能');
  // A tile with zero unseen count may still be in our own hand: the opponent lacks this kind, yet can still ron the last copy we discard.
  const none = avail.slice();
  none[idx(41)] = 0;
  assert.ok(kokushiModel({ riichi: true, melds: [], discardKinds: new Set() }, new Set(), none).hit[idx(41)] > 0);
  none[idx(11)] = 0;
  assert.equal(kokushiModel({ riichi: true, melds: [], discardKinds: new Set() }, new Set(), none), null);
  // Integration: a riichi player's deal-in loss on a tile includes the yakuman component, and genbutsu is still zero.
  const players = [makePlayer(0), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  discard(engine, 1, 25, { riichi: true });
  const t = readThreats(engine, 0, () => 3).threats.find((x) => x.seat === 1);
  assert.ok(t.lossHit, '立直者带国士混合损失');
  assert.equal(t.hit[idx(25)], 0);
  assert.ok(t.hit[idx(41)] > 0);
});

test('预算：耗尽后确定性回退，仍返回手中的合法弃牌，且不触发搜索', () => {
  const hand = makeTiles([[1, [1, 2, 3, 4, 6]], [2, [2, 3, 5, 7, 8]], [3, [3, 4, 5, 9]]]);
  const run = (budget) => {
    const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)]);
    discard(engine, 1, 41);
    discard(engine, 1, 18, { riichi: true });
    return chooseDiscardByPolicy(engine, 0, { level: 'advanced', budget });
  };
  const a = run(createDecisionBudget({ calc: 0, work: 0 }));
  const b = run(createDecisionBudget({ calc: 0, work: 0 }));
  assert.equal(a.discardId, b.discardId);
  assert.ok(hand.includes(a.discardId));
  assert.equal(a.budget.exhausted, true);
  assert.equal(a.searched, 0);
  // Counter-example: under the normal budget it is not exhausted.
  const normal = run(createDecisionBudget());
  assert.equal(normal.budget.exhausted, false);
  assert.ok(hand.includes(normal.discardId));
});

test('预算：整次决策共享——立直评估与鸣牌各选项不超出预算，耗尽时立直评估返回空', () => {
  const hand = makeTiles([...KANCHAN_NO_YAKU, [4, [5]]]);
  const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)]);
  const kinds = engine.formalTenpaiDiscards(engine.players[0]);
  assert.ok(kinds.length > 0);
  const tiny = createDecisionBudget({ calc: 0, work: 100_000 });
  assert.equal(riichiPolicy(engine, 0, kinds, 'advanced', tiny), null, '一个候选都没评估完则不宣告');
  assert.equal(tiny.exhausted, true);
  const ok = riichiPolicy(engine, 0, kinds, 'advanced', createDecisionBudget());
  assert.equal(ok.action, 'riichi');

  const open = makeTiles([[4, [7, 7, 7]], [1, [2, 3, 4, 6, 7]], [3, [5, 5]]]);
  const p = makePlayer(1, open);
  p.melds = [{ type: 'pon', tiles: [tileId(2, 2, 1), tileId(2, 2, 2), tileId(2, 2, 3)], from: 0 }];
  p.menzen = false;
  const claimEngine = makeEngine([makePlayer(0), p, makePlayer(2), makePlayer(3)]);
  const card = tileId(1, 5, 4);
  const options = [
    { action: PlayAction.Chi, type: 'chi', used: [open[1], open[2]], forbiddenKinds: new Set() },
    { action: PlayAction.Chi, type: 'chi', used: [open[3], open[4]], forbiddenKinds: new Set() },
  ];
  const budget = createDecisionBudget({ calc: 20, work: 6_000 });
  const first = claimPolicy(claimEngine, 1, card, options, 'advanced', budget);
  assert.ok(budget.calcUsed <= 20, `calcWin 次数 ${budget.calcUsed} 不超过整次预算`);
  const again = claimPolicy(claimEngine, 1, card, options, 'advanced', createDecisionBudget({ calc: 20, work: 6_000 }));
  assert.deepEqual(again && { a: again.action, u: again.used }, first && { a: first.action, u: first.used });
});

test('预算：零预算与鸣牌分片不允许负预算或超支', () => {
  const hand = makeTiles([[1, [1, 2, 3, 4, 6]], [2, [2, 3, 5, 7, 8]], [3, [3, 4, 5, 9]]]);
  const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)]);
  for (const work of [0, 35, 500]) {
    const budget = createDecisionBudget({ calc: 0, work });
    const result = chooseDiscardByPolicy(engine, 0, { level: 'advanced', budget });
    assert.ok(hand.includes(result.discardId));
    assert.ok(budget.workUsed <= work, `${budget.workUsed} 超出 ${work}`);
    assert.ok(budget.workUsed >= 0 && budget.calcUsed === 0);
  }
});

test('搜索：相同牌种但保留赤宝不同的手牌不能共用打点缓存', () => {
  const hand = makeTiles([[1, [1, 2, 3, 4, 5, 6]], [2, [7, 8, 9]], [3, [2, 3, 4]], [4, [5]]]);
  const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)]);
  engine.akaSet.add(tileId(1, 5, 1));
  const normal = hand.map((id) => id === tileId(1, 5, 1) ? tileId(1, 5, 2) : id);
  const search = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900);
  const red = search.tenpaiProfile(hand);
  const plain = search.tenpaiProfile(normal);
  assert.ok(red.points > plain.points, `${red.points} 应高于 ${plain.points}`);
});

test('搜索：立直漏和振听不能计荣和，余牌不足不能假设未来立直', () => {
  const hand = makeTiles(KANCHAN_NO_YAKU);
  const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)]);
  engine.players[0].riichi = true;
  engine.players[0].riichiFuriten = true;
  assert.equal(makeSearch(publicContext(engine, 0, null, 'advanced'), []).tenpaiProfile(hand).ronUkeire, 0);
  engine.players[0].riichi = false;
  engine.players[0].riichiFuriten = false;
  engine.remain = 3;
  assert.equal(makeSearch(publicContext(engine, 0, null, 'advanced'), []).tenpaiProfile(hand).ronUkeire, 0);
});

test('三麻估值：拔北按真实符数补番，北同时为宝牌时逐张指示牌叠加', () => {
  const hand = makeTiles([[2, [1, 2, 3, 4, 5, 6]], [3, [7, 8, 9, 2, 3, 4]], [4, [5]]]);
  const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2)]);
  engine.players[0].melds = [{ type: 'babei', tiles: [tileId(4, 4, 1)] }];
  for (const indicators of [[], [431], [431, 432]]) {
    engine.doraIndicators = indicators;
    const ctx = publicContext(engine, 0, null, 'advanced');
    const profile = makeSearch(ctx, engine.players[0].melds).tenpaiProfile(hand);
    const raw = calcWin(hand, engine.players[0].melds, engine.akaSet, {
      ronTile: tileId(4, 5, 2), riichi: true, doraTiles: ctx.doraTiles, roundWind: 1, seatWind: engine.seatWindOf(0),
    });
    const expected = engine.applyExtraFan(raw, 1 + indicators.length, true).ten * 1.3;
    assert.equal(profile.points, expected, `拔北与 ${indicators.length} 张西指示牌`);
  }
});

test('三麻高级：北是国士必需牌或唯一雀头时保留，闲张北仍拔出', () => {
  const shapes = [
    [[1, [1, 9]], [2, [1, 9, 5]], [3, [1, 9]], [4, [1, 2, 3, 4, 5, 6, 7]]],
    [[2, [1, 2, 3, 4, 5, 6, 7, 8, 9]], [3, [2, 3, 4]], [4, [4, 4]]],
  ];
  for (const shape of shapes) {
    const hand = makeTiles(shape);
    const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2)]);
    const before = structuredClone(engine.players[0]);
    const result = engine.aiTurn(0, true, [PlayAction.Normal, PlayAction.BaBei]);
    assert.notEqual(result.action, PlayAction.BaBei);
    assert.deepEqual(engine.players[0], before, '假想拔北不改变实体手牌');
  }
  const hand = makeTiles([[2, [1, 2, 3, 4, 5, 6]], [3, [1, 2, 3, 5, 6, 8, 8]], [4, [4]]]);
  const engine = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2)]);
  assert.equal(engine.aiTurn(0, true, [PlayAction.Normal, PlayAction.BaBei]).action, PlayAction.BaBei);
});

// Install the hidden-field trap before the first evaluation: opponents' hand / draw / tenpai, the wall / rinshan / ura dora.
function installTraps(engine, seat) {
  const deny = (object, key) => Object.defineProperty(object, key, {
    get() { assert.fail(`AI 读取了隐藏字段 ${key}`); },
  });
  for (const q of engine.players) {
    if (q.seat === seat) continue;
    for (const key of ['hand', 'drawnTile', 'waits', 'waitTiles', 'shanten']) deny(q, key);
  }
  for (const key of ['wall', 'replacements', 'uraIndicators']) deny(engine, key);
}

test('隐藏信息：首次评估前安装陷阱，立直、鸣牌、预算耗尽三种情形都不读取', () => {
  // Riichi
  const riichiHand = makeTiles([...KANCHAN_NO_YAKU, [4, [5]]]);
  const a = makeEngine([makePlayer(0, riichiHand), makePlayer(1), makePlayer(2), makePlayer(3)]);
  a.doraIndicators = [tileId(2, 4, 4)];
  discard(a, 1, 41);
  installTraps(a, 0);
  const turn = a.aiTurn(0, true, [PlayAction.Normal, PlayAction.Riichi]);
  assert.equal(turn.action, PlayAction.Riichi);
  assert.equal(kindOfId(turn.card), 45);
  assert.deepEqual(a.aiTurn(0, true, [PlayAction.Normal, PlayAction.Riichi]), turn);

  // Call
  const open = makeTiles([[4, [7, 7, 7]], [1, [2, 3, 4, 6, 7]], [3, [5, 5]]]);
  const p = makePlayer(1, open);
  p.melds = [{ type: 'pon', tiles: [tileId(2, 2, 1), tileId(2, 2, 2), tileId(2, 2, 3)], from: 0 }];
  p.menzen = false;
  const b = makeEngine([makePlayer(0), p, makePlayer(2), makePlayer(3)]);
  b.doraIndicators = [tileId(4, 6, 4)];
  const zhong = tileId(4, 7, 4);
  b.players[0].discards.push(zhong);
  installTraps(b, 1);
  const can = [PlayAction.MingGang, PlayAction.Peng, PlayAction.Guo];
  const claim = b.aiClaim(1, 0, zhong, can);
  assert.deepEqual(b.aiClaim(1, 0, zhong, can), claim);
  assert.ok(claim === null || can.includes(claim.action));

  // Budget exhausted
  const hand = makeTiles([[1, [1, 2, 3, 4, 6]], [2, [2, 3, 5, 7, 8]], [3, [3, 4, 5, 9]]]);
  const c = makeEngine([makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)]);
  discard(c, 1, 18, { riichi: true });
  installTraps(c, 0);
  const exhausted = () => chooseDiscardByPolicy(c, 0, { level: 'advanced', budget: createDecisionBudget({ calc: 0, work: 0 }) });
  const first = exhausted();
  assert.equal(first.budget.exhausted, true);
  assert.equal(exhausted().discardId, first.discardId);
});
