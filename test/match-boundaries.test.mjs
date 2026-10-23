import test from 'node:test';
import assert from 'node:assert/strict';
import { RiichiMsg } from '../mockjs/proto_enum.mjs';
import { applyRankResult, createDefaultProfile, recordMatch } from '../local/profile.mjs';
import { ECONOMY_CATALOG as C } from '../mockjs/economy_catalog.mjs';
import { engineFixture } from './helpers/riichi-fixtures.mjs';

for (const players of [3, 4]) for (const matchLength of ['east', 'hanchan']) {
  test(`${players}p ${matchLength === 'east' ? 'east-only' : 'hanchan'} final round without the required points goes to extension; the extension final round is capped and never enters the next wind`, async () => {
    const { engine } = engineFixture({ players, matchLength });
    engine.roundWind = engine.regularWinds;
    engine.juNum = players - 1;
    engine.dealerSeat = players - 1;
    const scores = new Array(players).fill(engine.startScore);
    assert.equal(engine.isAllLast(), true);
    assert.equal(engine.decideGameOver(false, scores), false);
    await engine.finishHand(false, false, scores);
    assert.equal(engine.roundWind, engine.regularWinds + 1);
    assert.equal(engine.dealerSeat, 0);
    assert.equal(engine.juNum, 0);
    assert.equal(engine.isAllLast(), true);
    assert.equal(engine.decideGameOver(false, scores), false);
    engine.juNum = players - 1;
    assert.equal(engine.decideGameOver(false, scores), true);
    assert.equal(engine.decideGameOver(true, scores), false, 'without the required points, a dealer on renchan must not be forced into ending the match');
    await engine.finishHand(true, false, scores);
    assert.equal(engine.matchOver, true);
    assert.equal(engine.finished, true);
  });
}

test('All Last: on a tie, the starting-seat order decides the win-stop; zero points continue, while negative points end the match immediately by tobi', () => {
  for (const players of [3, 4]) {
    const { engine } = engineFixture({ players });
    engine.juNum = players - 1;
    const threshold = players === 3 ? 40_000 : 30_000;
    const scores = new Array(players).fill(10_000);
    scores[0] = threshold;
    scores[players - 1] = threshold;
    engine.dealerSeat = players - 1;
    assert.equal(engine.decideGameOver(true, scores), false, 'tied on points, the starting seat leads, so the last-place dealer is not first place');
    engine.dealerSeat = 0;
    assert.equal(engine.decideGameOver(true, scores), true);
    engine.juNum = 0;
    const zero = new Array(players).fill(engine.startScore);
    zero[1] = 0;
    assert.equal(engine.decideGameOver(false, zero), false);
    zero[1] = -100;
    assert.equal(engine.decideGameOver(false, zero), true);
  }
});

test('3p/4p final results break ties by starting seat, and placement points and net score changes are correct for every seat', () => {
  for (const [players, scores, ranks, jing] of [
    [4, [35_000, 35_000, 15_000, 15_000], [1, 2, 3, 4], [25, 15, -15, -25]],
    [3, [40_000, 40_000, 25_000], [1, 2, 3], [20, 5, -25]],
    [3, [30_000, 45_000, 30_000], [2, 1, 3], [-5, 25, -20]],
  ]) {
    const { engine } = engineFixture({ players, scores });
    const infos = engine.buildStopUserInfos(scores, null, null, null, true);
    assert.deepEqual(infos.map((info) => info.rank), ranks);
    assert.deepEqual(infos.map((info) => info.jingSuanScore), jing);
    assert.deepEqual(infos.map((info) => info.jieBi), jing.map((value) => value * 100));
    assert.equal(infos.reduce((sum, info) => sum + info.jingSuanScore, 0), 0);
  }
});

test('3p/4p exhaustive-draw final round: riichi sticks go to the tied first place by starting seat; the callback result matches the settlement frame and is called exactly once', async () => {
  for (const players of [3, 4]) {
    const start = players === 3 ? 35_000 : 25_000;
    const { engine, frames } = engineFixture({ players, maxHands: 1,
      scores: Array.from({ length: players }, (_, seat) => start - (seat === players - 1 ? 2000 : 0)) });
    engine.riichiSticks = 2;
    let calls = 0;
    let finalScores;
    engine.onFinalResult = (scores) => { calls++; finalScores = scores; return {}; };
    const result = { type: 'draw', liuJuType: 0, noPenalty: true, tenpai: new Array(players).fill(false) };
    await engine.endHand(result);
    await engine.endHand(result);
    assert.equal(calls, 1);
    const expected = Array.from({ length: players }, (_, seat) => start + (seat === 0 ? 2000 : seat === players - 1 ? -2000 : 0));
    assert.deepEqual(finalScores, expected);
    assert.deepEqual(engine.scores, expected);
    assert.equal(engine.riichiSticks, 0);
    const stop = frames.filter((frame) => frame.event === RiichiMsg.ENtfGameStop);
    assert.equal(stop.length, 1);
    assert.equal(stop[0].payload.isFinal, true);
    assert.deepEqual(stop[0].payload.userInfos.map((p) => p.score), expected);
  }
});

test('the extension final-round threshold does not pre-collect unclaimed riichi sticks, and the official required-points boundary is exact', () => {
  for (const players of [3, 4]) {
    const { engine } = engineFixture({ players });
    engine.roundWind = 2;
    const necessary = players === 3 ? 40_000 : 30_000;
    const scores = new Array(players).fill(20_000);
    scores[0] = necessary - 100;
    engine.riichiSticks = 10;
    assert.equal(engine.decideGameOver(false, scores), false);
    scores[0] += 100;
    assert.equal(engine.decideGameOver(false, scores), true);
  }
});

for (const players of [3, 4]) for (const matchLength of ['east', 'hanchan']) {
  test(`${players}p ${matchLength === 'east' ? 'east-only' : 'hanchan'} original rank table: PT is checked per tier and per seat, with exact promotion/demotion boundaries and mode isolation`, () => {
    const key = players === 3 ? 'sanma' : 'yonma';
    const other = players === 3 ? 'yonma' : 'sanma';
    const table = C[`${key}Ranks`];
    const prefix = matchLength === 'east' ? 'east' : 'half';
    for (const rank of table) {
      const level = table.indexOf(rank) + 1;
      for (const rule of C.rankPoints.filter((row) => row.rank === level)) {
        for (let placement = 1; placement <= players; placement++) {
          const delta = rule[`${prefix}${placement}_${players}`];
          const profile = createDefaultProfile();
          const otherRank = structuredClone(profile.ranks[other]);
          profile.ranks[key] = { level, point: rank.initial };
          const result = applyRankResult(profile, { players, matchLength, placement, roomId: rule.room });
          assert.equal(result.change, delta);
          assert.deepEqual(profile.ranks[other], otherRank);
          assert.equal(result.oldLevel, level);
          assert.equal(result.oldPoint, rank.initial);
          // Derives the boundary values independently from the original table; does not mistake the initial PT for the demotion floor.
          if (delta > 0 && level < table.length) {
            if (rank.up > delta) {
              profile.ranks[key] = { level, point: rank.up - delta - 1 };
              assert.equal(applyRankResult(profile, { players, matchLength, placement, roomId: rule.room }).level, level);
            }
            // A low-tier match reward may already exceed the whole promotion threshold; the minimum legal starting point is zero.
            profile.ranks[key] = { level, point: Math.max(0, rank.up - delta) };
            const up = applyRankResult(profile, { players, matchLength, placement, roomId: rule.room });
            assert.equal(up.level, level + 1);
            assert.equal(up.point, table[level].inherit ? Math.max(rank.up, delta) : table[level].initial);
          }
          if (delta < 0) {
            profile.ranks[key] = { level, point: -delta };
            const zero = applyRankResult(profile, { players, matchLength, placement, roomId: rule.room });
            assert.equal(zero.level, level);
            assert.equal(zero.point, 0);
            profile.ranks[key] = { level, point: -delta - 1 };
            const down = applyRankResult(profile, { players, matchLength, placement, roomId: rule.room });
            const decreases = level > 1 && rank.canDecrease;
            assert.equal(down.level, decreases ? level - 1 : level);
            assert.equal(down.point, decreases ? table[level - 2].down || table[level - 2].initial : 0);
          }
        }
      }
    }
  });
}

test('original rank settlement uses starting-seat order for ties and only updates the matching 3p/4p and length records', () => {
  for (const players of [3, 4]) for (const matchLength of ['east', 'hanchan']) {
    const profile = createDefaultProfile();
    const key = players === 3 ? 'sanma' : 'yonma';
    const other = players === 3 ? 'yonma' : 'sanma';
    const untouched = structuredClone({ rank: profile.ranks[other], stats: profile.stats[other] });
    const result = recordMatch(profile, { players, matchLength, roomId: 3, scores: new Array(players).fill(30_000) });
    assert.equal(result.placement, 1);
    assert.equal(profile.stats[key].games, 1);
    assert.equal(profile.stats[key].byLength[matchLength].games, 1);
    assert.equal(profile.stats[key].byLength[matchLength === 'east' ? 'hanchan' : 'east'].games, 0);
    assert.deepEqual({ rank: profile.ranks[other], stats: profile.stats[other] }, untouched);
    assert.equal(profile.coins, 1_000_099);
  }
});
