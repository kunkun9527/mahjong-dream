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

test('荒牌流局本场增加但庄家未听仍轮庄', async () => {
  const engine = drawEngine();
  engine.honba = 2;

  await endDraw(engine, [false, false, false, false]);

  assert.equal(engine.honba, 3);
  assert.equal(engine.dealerSeat, 1);
  assert.equal(engine.juNum, 1);
});

test('三麻荒牌同样分离本场增加与听牌连庄', async () => {
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

test('东风与半庄末局的途中流局不适用听牌止且继续连庄重打', async () => {
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

test('延长场途中流局即使一位达到必要点也继续，击飞与maxHands仍终局', () => {
  const extension = drawEngine({ scores: [31_000, 24_000, 23_000, 22_000] });
  extension.roundWind = 2;
  extension.juNum = 0;
  assert.equal(extension.decideGameOver(true, extension.scores, { drawNoPenalty: true }), false);

  const busted = drawEngine({ scores: [-100, 30_100, 35_000, 35_000] });
  assert.equal(busted.decideGameOver(true, busted.scores, { drawNoPenalty: true }), true);

  const capped = drawEngine({ scores: [25_000, 25_000, 25_000, 25_000], maxHands: 1 });
  assert.equal(capped.decideGameOver(true, capped.scores, { drawNoPenalty: true }), true);
});
test('延长场多响含庄时优先连庄，即使另一赢家达到必要点', () => {
  const engine = drawEngine({ scores: [29_000, 29_000, 20_000, 22_000] });
  engine.roundWind = 2;
  engine.juNum = 0;
  engine.dealerSeat = 0;

  assert.equal(engine.decideGameOver(true, [30_000, 31_000, 19_000, 20_000], { multiRonDealerContinuation: true }), false);
  assert.equal(engine.decideGameOver(true, [31_000, 29_000, 20_000, 20_000]), true);
});


test('和了止与荒牌庄家听牌止保持生效', () => {
  const engine = drawEngine({ scores: [20_000, 20_000, 25_000, 35_000] });
  engine.roundWind = 1;
  engine.juNum = 3;
  engine.dealerSeat = 3;

  assert.equal(engine.decideGameOver(true, engine.scores), true);
  assert.equal(engine.decideGameOver(true, engine.scores, { drawNoPenalty: false }), true);
});

test('个人连续连庄独立于继承本场并在轮庄时清零', async () => {
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

test('听牌提示在别人行动时也带着自己的听牌信息（13 张手牌）', () => {
  const engine = drawEngine();
  const human = engine.players[0];
  // 123m456m789m 11p 34p，听 2p/5p
  human.hand = [110, 120, 130, 140, 150, 160, 170, 180, 190, 210, 211, 230, 240];
  human.isHuman = true;
  human.discardKinds = new Set();
  human.waits = [];

  assert.deepEqual(engine.buildTingInfos(human).map((i) => i.ting), [220, 250], '13 张手牌也要给出听牌');
  assert.deepEqual(engine.buildTingInfos(human, 250).map((i) => i.play), [250, 250], 'play 用刚打出的牌做牌种编码');

  const playCard = engine.buildPlayCard(1, 250, 0, false, []);
  assert.deepEqual(playCard.userInfos[0].tingInfos.map((i) => i.ting), [220, 250], '别人打牌时不下发听牌信息，客户端右侧提示会被清空');
  assert.equal(playCard.userInfos[1].tingInfos.length, 0, '不下发他人的暗手信息');
});

test('比赛第一手和后续摸牌都只公告实际备用余量，不另加8秒', async () => {
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
  assert.equal(frame(frames).payload.userInfos[0].leftTimer, 20, '第一手：基础5秒以外只有20秒备用');
  engine.cancelPending(); // A real hand transition closes the preceding decision window.
  engine.handIndex = 1;
  frames.length = 0;
  void engine.turnDraw(0);
  assert.equal(frame(frames).payload.userInfos[0].leftTimer, 20, '之后只公告备用余量');
});
