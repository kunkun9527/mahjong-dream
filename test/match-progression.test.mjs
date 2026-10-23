import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../mockjs/engine.mjs';

function engineFor(matchLength = 'east') {
  const engine = new GameEngine({ players: 4, matchLength, speed: 0 });
  engine.players = [0, 1, 2, 3].map((seat) => ({ seat }));
  engine.finished = false;
  engine.handIndex = 0;
  engine.maxHands = 64;
  return engine;
}

test('east-only: if no one reaches the required points by East 4, move on to South', async () => {
  const engine = engineFor('east');
  engine.roundWind = 1;
  engine.juNum = 3;
  engine.dealerSeat = 3;

  await engine.finishHand(false, false, [29_000, 25_000, 24_000, 22_000]);
  assert.equal(engine.finished, false);
  assert.equal(engine.roundWind, 2);
  assert.equal(engine.juNum, 0);
  assert.equal(engine.dealerSeat, 0);
});

test('hanchan: East 4 does not end the match early and proceeds normally to South 1', async () => {
  const engine = engineFor('hanchan');
  engine.roundWind = 1;
  engine.juNum = 3;
  engine.dealerSeat = 3;

  await engine.finishHand(false, false, [40_000, 25_000, 20_000, 15_000]);
  assert.equal(engine.finished, false);
  assert.equal(engine.roundWind, 2);
  assert.equal(engine.juNum, 0);
  assert.equal(engine.dealerSeat, 0);
});

test('the regular final round supports dealer win-stop', () => {
  const engine = engineFor('east');
  engine.roundWind = 1;
  engine.juNum = 3;
  engine.dealerSeat = 3;
  assert.equal(engine.decideGameOver(true, [25_000, 20_000, 20_000, 35_000]), true);
  assert.equal(engine.decideGameOver(true, [35_000, 20_000, 20_000, 25_000]), false);
});

test('in extension play, reaching the required points ends the match immediately; if the last round still does not reach them, the match is forced to end', () => {
  const east = engineFor('east');
  east.roundWind = 2;
  east.juNum = 0;
  assert.equal(east.decideGameOver(false, [31_000, 24_000, 23_000, 22_000]), true);
  east.juNum = 3;
  assert.equal(east.decideGameOver(false, [29_000, 25_000, 24_000, 22_000]), true);

  const hanchan = engineFor('hanchan');
  hanchan.roundWind = 3;
  hanchan.juNum = 3;
  assert.equal(hanchan.decideGameOver(false, [29_000, 25_000, 24_000, 22_000]), true);
});

test('3p and 4p use first-place required points of 40,000 and 30,000 respectively', () => {
  const yonma = engineFor('east');
  yonma.roundWind = 1;
  yonma.juNum = 3;
  assert.equal(yonma.decideGameOver(false, [31_000, 24_000, 23_000, 22_000]), true);

  const sanma = new GameEngine({ players: 3, matchLength: 'east' });
  sanma.players = [0, 1, 2].map((seat) => ({ seat }));
  sanma.roundWind = 1;
  sanma.juNum = 2;
  sanma.handIndex = 0;
  assert.equal(sanma.decideGameOver(false, [39_000, 35_000, 31_000]), false);
  assert.equal(sanma.decideGameOver(false, [40_000, 34_000, 31_000]), true);
});
