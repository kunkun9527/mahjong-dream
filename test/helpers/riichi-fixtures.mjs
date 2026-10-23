import assert from 'node:assert/strict';
import { GameEngine } from '../../mockjs/engine.mjs';

export function tiles(text) {
  const copies = new Map();
  return [...text.matchAll(/([1-9]+)([mpsz])/g)].flatMap(([, digits, suit]) =>
    [...digits].map((rank) => {
      const kind = ('mpsz'.indexOf(suit) + 1) * 10 + Number(rank);
      const copy = (copies.get(kind) || 0) + 1;
      assert.ok(copy <= 4, `Test tile kind exceeds four copies: ${kind}`);
      copies.set(kind, copy);
      return kind * 10 + copy;
    }));
}

export function engineFixture({ players = 4, matchLength = 'east', maxHands = 64, scores } = {}) {
  const frames = [];
  const startScore = players === 3 ? 35_000 : 25_000;
  const engine = new GameEngine({ players, matchLength, maxHands, speed: 0, startScore,
    emit: (event, payload) => frames.push({ event, payload }) });
  engine.players = Array.from({ length: players }, (_, seat) => ({
    seat, isHuman: seat === 0, score: scores?.[seat] ?? startScore,
    scoreAtStart: scores?.[seat] ?? startScore, timeBank: 20,
    hand: [], melds: [], discards: [], discardKinds: new Set(), discardClaimed: false,
    riichi: false, riichiPending: false, doubleRiichi: false, riichiTurn: -1,
    ippatsu: false, menzen: true, waits: [], waitTiles: [], tempFuriten: false,
    riichiFuriten: false, drawnTile: null, rinshan: false, pao: {},
  }));
  engine.scores = engine.players.map((p) => p.score);
  engine.wall = [];
  engine.deadWall = [];
  engine.replacements = [];
  engine.akaSet = new Set();
  engine.doraIndicators = [];
  engine.uraIndicators = [];
  engine.remain = 40;
  engine.kanCount = 0;
  engine._deferredKanDora = 0;
  engine.firstGoAround = false;
  engine.xunNum = 5;
  engine.handEnded = false;
  return { engine, frames };
}
