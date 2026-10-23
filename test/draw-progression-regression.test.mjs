import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../mockjs/engine.mjs';

function makePlayer(seat, score) {
  return {
    seat,
    score,
    scoreAtStart: score,
    hand: [],
    melds: [],
    discards: [],
    riichi: false,
    waits: [],
  };
}

function drawEngine({ players = 4, matchLength = 'east', scores, maxHands = 64, onFinalResult } = {}) {
  const initialScores = scores || new Array(players).fill(players === 3 ? 35_000 : 25_000);
  const engine = new GameEngine({ players, matchLength, speed: 0, maxHands, onFinalResult });
  engine.players = initialScores.map((score, seat) => makePlayer(seat, score));
  engine.scores = initialScores.slice();
  engine.doraIndicators = [];
  engine.uraIndicators = [];
  engine.handEnded = false;
  return engine;
}

async function endDraw(engine, tenpai, extra = {}) {
  await engine.endHand({ type: 'draw', liuJuType: 0, tenpai, ...extra });
}

test('exhaustive draw increases honba, but a dealer who is not tenpai still rotates', async () => {
  const engine = drawEngine();
  engine.honba = 2;

  await endDraw(engine, [false, false, false, false]);

  assert.equal(engine.honba, 3);
  assert.equal(engine.dealerSeat, 1);
  assert.equal(engine.juNum, 1);
});

test('sanma exhaustive draw likewise separates honba increase from tenpai renchan', async () => {
  const engine = drawEngine({ players: 3 });
  engine.honba = 1;
  engine.dealerSeat = 1;
  engine.juNum = 1;

  await endDraw(engine, [false, true, false]);

  assert.equal(engine.honba, 2);
  assert.equal(engine.dealerSeat, 1);
  assert.equal(engine.juNum, 1);
  assert.equal(engine.renchanCount, 1);
});

test('mid-hand draws in East-only and hanchan final rounds ignore the tenpai stop and continue with renchan', async () => {
  for (const matchLength of ['east', 'hanchan']) {
    const engine = drawEngine({ matchLength, scores: [20_000, 20_000, 25_000, 35_000] });
    engine.roundWind = matchLength === 'east' ? 1 : 2;
    engine.juNum = 3;
    engine.dealerSeat = 3;

    await endDraw(engine, [false, false, false, false], { noPenalty: true });

    assert.equal(engine.finished, false, matchLength);
    assert.equal(engine.dealerSeat, 3, matchLength);
    assert.equal(engine.juNum, 3, matchLength);
    assert.equal(engine.honba, 1, matchLength);
  }
});

test('mid-hand draw in extension play continues even if first place reaches the required points; tobi and maxHands still end the match', () => {
  const extension = drawEngine({ scores: [31_000, 24_000, 23_000, 22_000] });
  extension.roundWind = 2;
  extension.juNum = 0;
  assert.equal(extension.decideGameOver(true, extension.scores, { drawNoPenalty: true }), false);

  const busted = drawEngine({ scores: [-100, 30_100, 35_000, 35_000] });
  assert.equal(busted.decideGameOver(true, busted.scores, { drawNoPenalty: true }), true);

  const capped = drawEngine({ scores: [25_000, 25_000, 25_000, 25_000], maxHands: 1 });
  assert.equal(capped.decideGameOver(true, capped.scores, { drawNoPenalty: true }), true);
});
test('in extension play, multi-ron including the dealer prefers renchan even if the other winner reaches the required points', () => {
  const engine = drawEngine({ scores: [29_000, 29_000, 20_000, 22_000] });
  engine.roundWind = 2;
  engine.juNum = 0;
  engine.dealerSeat = 0;

  assert.equal(engine.decideGameOver(true, [30_000, 31_000, 19_000, 20_000], { multiRonDealerContinuation: true }), false);
  assert.equal(engine.decideGameOver(true, [31_000, 29_000, 20_000, 20_000]), true);
});


test('the win-stop and the exhaustive-draw dealer tenpai stop remain in effect', () => {
  const engine = drawEngine({ scores: [20_000, 20_000, 25_000, 35_000] });
  engine.roundWind = 1;
  engine.juNum = 3;
  engine.dealerSeat = 3;

  assert.equal(engine.decideGameOver(true, engine.scores), true);
  assert.equal(engine.decideGameOver(true, engine.scores, { drawNoPenalty: false }), true);
});

test('personal consecutive renchan count is independent of inherited honba and resets when the dealer rotates', async () => {
  let finalStats;
  const engine = drawEngine({
    maxHands: 2,
    onFinalResult: (_scores, current) => {
      finalStats = { ...current.matchStats };
      return {};
    },
  });
  engine.honba = 2;

  await endDraw(engine, [true, false, false, false]);
  assert.equal(engine.renchanCount, 1);
  assert.equal(engine.matchStats.maxRenchan, 1);

  engine.handEnded = false;
  engine.players.forEach((player, seat) => {
    player.score = engine.scores[seat];
    player.scoreAtStart = engine.scores[seat];
  });
  await endDraw(engine, [false, false, false, false]);

  assert.equal(engine.renchanCount, 0);
  assert.equal(engine.matchStats.maxRenchan, 1);
  assert.equal(finalStats.maxRenchan, 1);
});

test('the tenpai hint still carries own tenpai info while others act (13-tile hand)', () => {
  const engine = drawEngine();
  const human = engine.players[0];
  // 123m456m789m 11p 34p, waits 2p/5p
  human.hand = [110, 120, 130, 140, 150, 160, 170, 180, 190, 210, 211, 230, 240];
  human.isHuman = true;
  human.discardKinds = new Set();
  human.waits = [];

  assert.deepEqual(engine.buildTingInfos(human).map((i) => i.ting), [220, 250], 'a 13-tile hand must also report tenpai');
  assert.deepEqual(engine.buildTingInfos(human, 250).map((i) => i.play), [250, 250], 'play encodes the tile kind using the tile just discarded');

  const playCard = engine.buildPlayCard(1, 250, 0, false, []);
  assert.deepEqual(playCard.userInfos[0].tingInfos.map((i) => i.ting), [220, 250], 'no tenpai info is sent when others discard, which would clear the right-side hint on the client');
  assert.equal(playCard.userInfos[1].tingInfos.length, 0, 'concealed hands of other players are not sent');
});

test('the first hand and later draws in a match only announce the actual bank remainder, without adding 8 seconds', async () => {
  const engine = drawEngine();
  const frames = [];
  engine.emit = (ev, payload) => frames.push({ ev, payload });
  engine.players[0].isHuman = true;
  engine.players[0].timeBank = 20;
  engine.players[0].hand = [111, 112, 113];
  engine.wall = [191, 192, 193, 194, 195];
  engine.remain = engine.wall.length;
  engine.waitHuman = () => new Promise(() => {});
  void engine.turnDraw(0);
  const frame = (items) => items.find((item) => item.payload?.userInfos);
  assert.equal(frame(frames).payload.userInfos[0].leftTimer, 20, 'first hand: only 20 seconds of bank beyond the 5-second base');
  engine.cancelPending(); // A real hand transition closes the preceding decision window.
  engine.handIndex = 1;
  frames.length = 0;
  void engine.turnDraw(0);
  assert.equal(frame(frames).payload.userInfos[0].leftTimer, 20, 'afterwards only the bank remainder is announced');
});
