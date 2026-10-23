import test from 'node:test';
import assert from 'node:assert/strict';
import { seatLayouts, ratioStat, pairedStat, routeAiMethods } from '../tools/ai_benchmark.mjs';

test('benchmark: 3p/4p layouts do not repeat, both groups are balanced across seats, and 3p covers both the majority and the minority', () => {
  for (const n of [3, 4]) {
    const layouts = seatLayouts(n);
    assert.equal(layouts.length, 6);
    assert.equal(new Set(layouts.map((l) => l.join(''))).size, 6);
    for (let seat = 0; seat < n; seat++) assert.equal(layouts.reduce((sum, l) => sum + l[seat], 0), 3);
    for (const l of layouts) assert.ok(Math.abs(l.reduce((sum, side) => sum + side, 0) * 2 - n) <= 1);
  }
  assert.throws(() => seatLayouts(2), /players/);
});

test('benchmark: the dynamic meld helper of the legacy entry also uses the old strategy and does not pollute new seats', () => {
  const engine = {
    marker: 17,
    aiTurn(seat) { return ['new-turn', this.marker, this.aiClaimByPolicy(seat)]; },
    aiClaim(seat) { return ['new-claim', this.aiClaimByPolicy(seat)]; },
    aiClaimByPolicy(seat) { return ['new-policy', seat]; },
  };
  const old = {
    aiTurn(seat) { return ['old-turn', this.marker, this.aiClaimByPolicy(seat)]; },
    aiClaim(seat) { return ['old-claim', this.aiClaimByPolicy(seat)]; },
    aiClaimByPolicy(seat) { return ['old-policy', seat]; },
  };
  routeAiMethods(engine, [{ old: false }, { old: true }], old);
  assert.deepEqual(engine.aiTurn(1), ['old-turn', 17, ['old-policy', 1]]);
  assert.deepEqual(engine.aiClaim(1), ['old-claim', ['old-policy', 1]]);
  assert.deepEqual(engine.aiTurn(0), ['new-turn', 17, ['new-policy', 0]]);
  assert.deepEqual(engine.aiClaim(0), ['new-claim', ['new-policy', 0]]);
});

test('benchmark: standard errors are clustered by seed, so copying the same position does not falsely shrink them', () => {
  const samples = [{ seed: 1, num: 10, den: 1 }, { seed: 2, num: 30, den: 1 }];
  const stat = ratioStat(samples);
  assert.equal(stat.value, 20);
  assert.equal(stat.se, 10);
  assert.equal(ratioStat([...samples, ...samples]).se, stat.se);
  assert.deepEqual(pairedStat([10, 30]), { mean: 20, se: 10, lo: 0.3999999999999986, hi: 39.6, k: 2 });
  assert.equal(ratioStat([samples[0]]).se, null);
  assert.equal(pairedStat([10]).lo, null);
});
