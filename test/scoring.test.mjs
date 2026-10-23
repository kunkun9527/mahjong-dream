import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../mockjs/engine.mjs';
import { RiichiMsg } from '../mockjs/proto_enum.mjs';
import { tileId } from '../mockjs/tiles.mjs';

function makePlayer(seat, score = 25_000) {
  return {
    seat,
    isHuman: seat === 0,
    score,
    scoreAtStart: score,
    hand: [],
    melds: [],
    discards: [],
    discardKinds: new Set(),
    riichi: false,
    riichiPending: false,
    riichiTurn: -1,
    ippatsu: false,
    menzen: true,
    waits: [],
    tempFuriten: false,
    riichiFuriten: false,
    drawnTile: null,
    rinshan: false,
  };
}

function scoringEngine(scores) {
  const frames = [];
  const engine = new GameEngine({
    players: 4,
    startScore: 25_000,
    speed: 0,
    maxHands: 1,
    emit: (event, payload) => frames.push({ event, payload }),
  });
  engine.players = scores.map((score, seat) => makePlayer(seat, score));
  engine.scores = scores.slice();
  engine.akaSet = new Set();
  engine.doraIndicators = [];
  engine.uraIndicators = [];
  engine.handEnded = false;
  engine.honba = 1;
  engine.riichiSticks = 2;
  return { engine, frames };
}

function basicRon(points = 1_000) {
  return {
    isAgari: true,
    hasYaku: true,
    han: 1,
    fu: 30,
    ten: points,
    yakuman: 0,
    yaku: { '立直': '1飜' },
    name: '',
    oya: [500],
    ko: [500, 300],
  };
}

test('double ron settles separately; riichi sticks and honba go to the winner nearest the discarder next seat', async () => {
  const { engine, frames } = scoringEngine([23_000, 25_000, 25_000, 25_000]);
  await engine.endHand({
    type: 'ron',
    winners: [1, 2],
    loser: 0,
    card: tileId(4, 7, 1),
    wins: new Map([[1, basicRon()], [2, basicRon()]]),
  });

  assert.deepEqual(engine.scores, [20_700, 28_300, 26_000, 25_000]);
  assert.equal(engine.riichiSticks, 0);
  const stop = frames.find(({ event }) => event === RiichiMsg.ENtfGameStop)?.payload;
  assert.deepEqual(stop.huSeats, [1, 2]);
  assert.equal(stop.userInfos.find(({ seat }) => seat === 1).totalFan, 1);
  assert.equal(stop.userInfos.find(({ seat }) => seat === 2).totalFan, 1);
});

test('dealing in on the riichi declaration tile revokes riichi and returns the declaration stick', async () => {
  const { engine } = scoringEngine([24_000, 25_000, 25_000, 25_000]);
  engine.riichiSticks = 1;
  const loser = engine.players[0];
  loser.riichi = true;
  loser.riichiPending = true;
  loser.riichiTurn = 3;
  loser.ippatsu = true;

  const winner = engine.players[1];
  winner.hand = [
    [1, 1], [1, 2], [1, 3],
    [2, 1], [2, 2], [2, 3],
    [3, 1], [3, 2], [3, 3],
    [4, 5], [4, 5], [4, 5],
    [4, 7],
  ].map(([suit, rank], index) => tileId(suit, rank, index % 4 + 1));
  winner.waits = [47];

  let result;
  engine.endHand = async (value) => { result = value; };
  await engine.winRons([1], 0, tileId(4, 7, 2));
  assert.equal(loser.score, 25_000);
  assert.equal(loser.riichi, false);
  assert.equal(loser.riichiPending, false);
  assert.equal(engine.riichiSticks, 0);
  assert.deepEqual(result.winners, [1]);
});

test('four-player final placement points use the Majsoul 5-15 scheme', () => {
  const { engine } = scoringEngine([40_000, 30_000, 20_000, 10_000]);
  const infos = engine.buildStopUserInfos([40_000, 30_000, 20_000, 10_000], null, null, null, true);
  assert.deepEqual(infos.map(({ jingSuanScore }) => jingSuanScore), [30, 10, -10, -30]);
});

test('unclaimed riichi sticks at an exhaustive-draw finish go to first place', async () => {
  const { engine } = scoringEngine([23_000, 30_000, 25_000, 20_000]);
  await engine.endHand({
    type: 'draw',
    liuJuType: 0,
    tenpai: [false, false, false, false],
    noPenalty: true,
  });
  assert.deepEqual(engine.scores, [23_000, 32_000, 25_000, 20_000]);
  assert.equal(engine.riichiSticks, 0);
});

test('nagashi mangan settles as a mangan tsumo and adds no honba', async () => {
  const { engine, frames } = scoringEngine([25_000, 25_000, 25_000, 25_000]);
  engine.honba = 3;
  engine.riichiSticks = 0;
  await engine.endHand({
    type: 'draw',
    liuJuType: 0,
    tenpai: [false, false, false, false],
    nagashiWinners: [1],
  });
  assert.deepEqual(engine.scores, [21_000, 33_000, 23_000, 23_000]);
  const stop = frames.find(({ event }) => event === RiichiMsg.ENtfGameStop)?.payload;
  assert.deepEqual(stop.liuJuManGuanSeats, [1]);
});

test('nagashi mangan requires all discards to be terminals or honors and none to be called', async () => {
  const { engine } = scoringEngine([25_000, 25_000, 25_000, 25_000]);
  engine.players[0].discards = [tileId(1, 1, 1), tileId(4, 1, 1), tileId(3, 9, 1)];
  engine.players[1].discards = [tileId(1, 1, 2)];
  engine.players[1].discardClaimed = true;
  engine.players[2].discards = [tileId(1, 2, 1)];
  engine.players[3].discards = [tileId(4, 7, 1)];
  for (const player of engine.players) player.hand = [];
  engine.isTenpai = () => false;
  let result;
  engine.endHand = async (value) => { result = value; };
  await engine.exhaustiveDraw();
  assert.deepEqual(result.nagashiWinners, [0, 3]);
});

function daisangen() {
  return {
    isAgari: true, hasYaku: true, han: 13, fu: 40, ten: 32_000, yakuman: 1,
    yaku: { '大三元': '役満' }, name: '役満', oya: [16_000], ko: [16_000, 8_000],
  };
}

test('big three dragons pao on ron is split between the discarder and the liable player', async () => {
  const { engine } = scoringEngine([25_000, 25_000, 25_000, 25_000]);
  engine.honba = 0;
  engine.riichiSticks = 0;
  engine.players[1].pao = { daisangen: 3 };
  await engine.endHand({
    type: 'ron', winners: [1], loser: 2, card: tileId(4, 1, 1),
    wins: new Map([[1, daisangen()]]),
  });
  assert.deepEqual(engine.scores, [25_000, 57_000, 9_000, 9_000]);
});

test('big three dragons pao on tsumo is paid in full by the liable player', async () => {
  const { engine } = scoringEngine([25_000, 25_000, 25_000, 25_000]);
  engine.honba = 0;
  engine.riichiSticks = 0;
  engine.players[1].pao = { daisangen: 3 };
  await engine.endHand({ type: 'tsumo', winner: 1, win: daisangen() });
  assert.deepEqual(engine.scores, [25_000, 57_000, 25_000, -7_000]);
});

test('a ron completing the third dragon meld records the discarder as the liable player, and the pao flag is sent with the settlement', async () => {
  const { engine, frames } = scoringEngine([25_000, 25_000, 25_000, 25_000]);
  engine.honba = 0;
  engine.riichiSticks = 0;
  engine.recordPaoOnRon(engine.players[1], 2, daisangen());
  assert.equal(engine.players[1].pao.daisangen, 2);
  await engine.endHand({
    type: 'ron', winners: [1], loser: 2, card: tileId(4, 1, 1),
    wins: new Map([[1, daisangen()]]),
  });
  // The liable player is the discarder; the amount matches a normal ron and is not split
  assert.deepEqual(engine.scores, [25_000, 57_000, -7_000, 25_000]);
  const stop = frames.filter((frame) => frame.event === RiichiMsg.ENtfGameStop).at(-1).payload;
  assert.equal(stop.userInfos[1].isBaoPai, true);
  assert.equal(stop.userInfos[2].isBaoPai, false);
});

test('tsumo pao is also flagged as isBaoPai in the settlement', async () => {
  const { engine, frames } = scoringEngine([25_000, 25_000, 25_000, 25_000]);
  engine.honba = 0;
  engine.riichiSticks = 0;
  engine.players[1].pao = { daisangen: 3 };
  await engine.endHand({ type: 'tsumo', winner: 1, win: daisangen() });
  const stop = frames.filter((frame) => frame.event === RiichiMsg.ENtfGameStop).at(-1).payload;
  assert.equal(stop.userInfos[1].isBaoPai, true);
  assert.equal(stop.userInfos[0].isBaoPai, false);
});

test('an open third dragon meld and fourth wind meld record the pao liable player', () => {
  const { engine } = scoringEngine([25_000, 25_000, 25_000, 25_000]);
  const player = engine.players[1];
  player.pao = {};
  player.melds = [45, 46, 47].map((kind) => ({ type: 'pon', tiles: [kind * 10 + 1] }));
  engine.recordPao(player, 2);
  assert.equal(player.pao.daisangen, 2);
  player.melds = [41, 42, 43, 44].map((kind) => ({ type: 'kan', tiles: [kind * 10 + 1] }));
  engine.recordPao(player, 3);
  assert.equal(player.pao.daisuushi, 3);
});

test('final settlement writes local rank changes into the original client fields', () => {
  const { engine } = scoringEngine([30_000, 25_000, 23_000, 22_000]);
  engine._finalResult = { rank: { oldLevel: 11, oldPoint: 390, level: 12, point: 400, change: 40 } };
  const info = engine.buildStopUserInfos([30_000, 25_000, 23_000, 22_000], null, null, [false, false, false, false], true)[0];
  assert.equal(info.changePT, 40);
  assert.equal(info.oldPTLevel, 11);
  assert.equal(info.oldPTPoint, 390);
  assert.equal(info.ptLevel, 12);
  assert.equal(info.ptPoint, 400);
});
