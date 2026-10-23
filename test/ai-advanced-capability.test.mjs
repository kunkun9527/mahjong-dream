// Fixed cases for advanced AI capabilities: reading-based defense, pot odds, chasing riichi, riichi/dama and improvement, furiten awareness, seat utility,
// pot-odds gating of kans; also verifies read-only visible information, determinism and the time budget.
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

// Public discard: written to the river and the public log (the 4th physical copy, to avoid conflicting with the hand).
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

test('tile reading: genbutsu and post-riichi passed tiles are zero risk, suji/kabe/honors with visible copies lower risk, middle tiles are the most dangerous', () => {
  const players = [makePlayer(0), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  discard(engine, 1, 41);
  discard(engine, 1, 14);
  discard(engine, 1, 29, { riichi: true });
  discard(engine, 2, 26); // After riichi, the opponent discards and the riichi player does not ron: equally safe
  const read = readThreats(engine, 0, () => 3);
  // Only looks at the riichi player's hit rate (other menzen players each have a tiny tenpai probability).
  const loss = read.threats.find((t) => t.seat === 1).hit;
  assert.equal(loss[idx(14)], 0, 'genbutsu');
  assert.equal(loss[idx(29)], 0, 'genbutsu');
  assert.equal(loss[idx(26)], 0, 'post-riichi passed tile');
  assert.ok(loss[idx(17)] < loss[idx(15)], 'suji 7m of 4m is safer than non-suji 5m');
  assert.ok(loss[idx(11)] < loss[idx(15)], 'suji 1m is safer than 5m');
  assert.ok(loss[idx(23)] < loss[idx(22)], 'after 6p is passed, its suji 3p is safer than 2p');
  // Honor tiles: the more visible copies, the safer.
  const hitOf = (r) => r.threats.find((t) => t.seat === 1).hit[idx(45)];
  const one = hitOf(readThreats(engine, 0, (i) => (i === idx(45) ? 1 : 3)));
  const three = hitOf(readThreats(engine, 0, () => 3));
  assert.ok(one < three, 'an honor with 1 copy left can only be a tanki wait');
  const riichi = read.threats.find((t) => t.seat === 1);
  assert.equal(riichi.tenpai, 1);
  for (const t of read.threats.filter((x) => x.seat !== 1)) assert.ok(t.tenpai < 0.05, 'a closed hand with a short river is barely counted as a threat');
});

test('tile reading: a flush-going player with open melds barely threatens other suits; more melds mean a higher tenpai chance', () => {
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
  assert.ok(t.tenpai > 0.3, `two open melds and 7 discards should give a high tenpai probability: ${t.tenpai}`);
  assert.ok(t.hit[idx(24)] > 4 * t.hit[idx(14)], 'pin chinitsu reading: 4p is far more dangerous than 4m');
});

test('advanced: far-from-tenpai low-value hand folds to genbutsu against riichi', () => {
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

test('advanced: one-shanten with many dora keeps attacking against riichi', () => {
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

test('advanced: with equal efficiency while attacking, discard the safer tile', () => {
  // An isolated 5s and 1s are of similar efficiency; 1s is the riichi player's genbutsu.
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

test('advanced: good-shape high-value tenpai pushes its own riichi and does not fold because an opponent declared riichi first', () => {
  // 234m 567m 345p 66s 78s + dora 5m: waits on 69s ryanmen.
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

test('advanced: early closed tenpai declares riichi (kanchan with no yaku and ryanmen pinfu both declare, without dama waiting to improve)', () => {
  // 123m 567p 789s 99p + 24m/34m + 6s: discarding 6s waits on 3m kanchan (no yaku) or 2-5m ryanmen (pinfu) respectively.
  for (const ranks of [[1, 2, 3, 2, 4], [1, 2, 3, 3, 4]]) {
    const hand = makeTiles([[1, ranks], [2, [5, 6, 7, 9, 9]], [3, [7, 8, 9]], [3, [6]]]);
    const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
    const engine = makeEngine(players);
    engine.remain = 60;
    const decision = riichiPolicy(engine, 0, engine.formalTenpaiDiscards(players[0]), 'advanced');
    assert.equal(decision?.action, 'riichi', `hand ${ranks.join('')}m`);
  }
});

test('advanced: furiten tenpai only counts tsumo, ron ukeire is 0; discarding a waiting tile itself also makes furiten', () => {
  // 234m 678m 345p 55s 67s: waits on 5s / 8s.
  const hand = makeTiles([[1, [2, 3, 4, 6, 7, 8]], [2, [3, 4, 5]], [3, [5, 5, 6, 7]]]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  const fresh = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900).tenpaiProfile(hand);
  assert.ok(fresh.ukeire > 0 && fresh.ronUkeire > 0);
  const viaExtra = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900).tenpaiProfile(hand, [idx(38)]);
  assert.equal(viaExtra.ronUkeire, 0, 'discarding 8s and then waiting on 8s is furiten');
  discard(engine, 0, 38);
  const furiten = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900).tenpaiProfile(hand);
  assert.equal(furiten.ronUkeire, 0);
  assert.ok(furiten.ukeire > 0, 'tsumo is still possible');
});

test('advanced: among waits with the same count, an honor tanki weighs more for ron than a middle-tile tanki', () => {
  // 123m 456m 789p 234s + tanki: white vs 6s.
  const base = [[1, [1, 2, 3, 4, 5, 6]], [2, [7, 8, 9]], [3, [2, 3, 4]]];
  const honor = makeTiles([...base, [4, [5]]]);
  const middle = makeTiles([...base, [3, [6]]]);
  const engine = makeEngine([makePlayer(0, honor), makePlayer(1), makePlayer(2), makePlayer(3)]);
  const search = makeSearch(publicContext(engine, 0, null, 'advanced'), [], 900);
  const a = search.tenpaiProfile(honor);
  const b = search.tenpaiProfile(middle);
  assert.ok(a.ronUkeire / a.ukeire > b.ronUkeire / b.ukeire);
});

test('placement utility: All Last adds extra value for the points needed to reverse position, and extra penalty for dealing in and losing position', () => {
  const players = [makePlayer(0, [], 30_000), makePlayer(1, [], 27_000), makePlayer(2, [], 23_000), makePlayer(3, [], 20_000)];
  const engine = makeEngine(players);
  engine.isAllLast = () => true;
  const util = placementUtility(engine, 1);
  assert.ok(util.gain(3900) > 3900 + 5000, 'a 3900 win from 2nd reverses 1st place');
  assert.ok(Math.abs(util.gain(1000) - 1000) < 5000, '1000 points that do not change placement add almost no bonus');
  assert.ok(util.loss(3, 8000) > 8000 + 5000, 'dealing 8000 to last place drops position');
  engine.isAllLast = () => false;
  assert.equal(placementUtility(engine, 1), null, 'no placement adjustment outside All Last');
});

test('advanced: facing riichi with a poor hand, does not ankan; with no threat, ankan', () => {
  const hand = makeTiles([[1, [1, 1, 1, 1]], [2, [2, 5, 9]], [3, [3, 6, 8]], [4, [1, 2, 3]], [3, [1]]]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  const can = [PlayAction.Normal, PlayAction.AnGang];
  assert.equal(engine.aiTurn(0, true, can).action, PlayAction.AnGang);
  discard(engine, 1, 29, { riichi: true });
  assert.notEqual(engine.aiTurn(0, true, can).action, PlayAction.AnGang);
});

test('advanced: decisions facing a threat are deterministic, do not read hidden information, and take under 1 second', () => {
  const hand = makeTiles([[1, [1, 2, 3, 4, 6]], [2, [2, 3, 5, 7, 8]], [3, [3, 4, 5, 9]]]);
  const players = [makePlayer(0, hand), makePlayer(1), makePlayer(2), makePlayer(3)];
  const engine = makeEngine(players);
  engine.doraIndicators = [tileId(2, 4, 4)];
  discard(engine, 1, 41);
  discard(engine, 1, 18, { riichi: true });
  players[2].melds = [{ type: 'pon', tiles: [tileId(4, 5, 1), tileId(4, 5, 2), tileId(4, 5, 3)] }];
  players[2].menzen = false;
  const evaluate = () => engine.aiTurn(0, true, [PlayAction.Normal]);
  // The trap is installed before the first evaluation: even the first evaluation must not read hidden fields.
  const denyRead = (object, key) => Object.defineProperty(object, key, {
    get() { assert.fail(`AI read hidden field ${key}`); },
  });
  for (const opponent of engine.players.slice(1)) {
    for (const key of ['hand', 'drawnTile', 'waits', 'waitTiles', 'shanten']) denyRead(opponent, key);
  }
  for (const key of ['wall', 'replacements', 'uraIndicators']) denyRead(engine, key);
  const start = performance.now();
  const expected = evaluate();
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1_000, `advanced decision took ${elapsed.toFixed(1)}ms`);
  for (let i = 0; i < 5; i++) assert.deepEqual(evaluate(), expected);
});
