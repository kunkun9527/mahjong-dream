import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../mockjs/engine.mjs';
import { buildWall } from '../mockjs/tiles.mjs';
import { PlayAction, RiichiMsg } from '../mockjs/proto_enum.mjs';

function player(seat, hand = []) {
  return {
    seat, hand, isHuman: false, score: 50_000, melds: [], discards: [],
    discardKinds: new Set(), waits: [], waitTiles: [], riichi: false,
    riichiPending: false, doubleRiichi: false, riichiTurn: -1, ippatsu: false,
    tempFuriten: false, riichiFuriten: false, menzen: true, pao: {},
    drawnTile: null, rinshan: false, timeBank: 20,
  };
}

function setup(kind, multiRon = false) {
  const isNorth = kind === 'babei';
  const card = isNorth ? 441 : kind === 'ankan' ? 111 : 251;
  const winningHand = isNorth
    ? [111, 191, 211, 291, 311, 391, 411, 421, 431, 451, 461, 471, 112]
    : kind === 'ankan'
      ? [191, 192, 211, 291, 311, 391, 411, 421, 431, 441, 451, 461, 471]
      : [111, 121, 131, 141, 151, 161, 311, 321, 331, 231, 241, 451, 452];
  const events = [];
  const engine = new GameEngine({ players: isNorth ? 3 : 4, speed: 0, emit: (id, data) => events.push({ id, data }) });
  engine.players = Array.from({ length: engine.playersN }, (_, seat) => player(seat));
  engine.players[1].hand = winningHand;
  if (multiRon) engine.players[2].hand = [113, 192, 212, 292, 312, 392, 412, 422, 432, 452, 462, 472, 114];
  const donor = engine.players[0];
  donor.hand = kind === 'ankan' ? [111, 112, 113, 114] : [card];
  if (kind === 'kakan') {
    donor.melds = [{ type: 'pon', tiles: [252, 253, 254], from: 2 }];
    donor.menzen = false;
  }
  const reserved = new Set(engine.players.flatMap((p) => p.hand.concat(p.melds.flatMap((m) => m.tiles))));
  const { tiles } = buildWall({ sanma: isNorth });
  donor.hand.push(...tiles.filter((tile) => !reserved.has(tile)).slice(0, 14 - donor.melds.length * 3 - donor.hand.length));
  donor.drawnTile = donor.hand.at(-1); // Also covers the case where the declared tile is not the one just drawn.
  engine.akaSet = new Set();
  engine.doraIndicators = [];
  engine.uraIndicators = [];
  engine.deadWall = [];
  engine.replacements = [tiles.at(-1)];
  engine.remain = 30;
  engine.kanCount = 0;
  engine.firstGoAround = false;
  engine.xunNum = 9;
  engine.finishHand = async () => {}; // Keeps the real settlement and protocol construction; only prevents the next hand from starting.
  for (const p of engine.players) engine.updateWaits(p);
  const physical = engine.players.flatMap((p) => p.hand.concat(p.melds.flatMap((m) => m.tiles)));
  assert.equal(new Set(physical).size, physical.length, 'test hand must not repeat a physical tile');
  return { engine, donor, card, events };
}

for (const [kind, label] of [['kakan', 'added kan robbery'], ['ankan', 'kokushi robbing closed kan'], ['babei', 'nukidora robbery']]) {
  test(`${label} settlement removes the robbed physical tile from the discarder concealed hand, but does not complete the kan or nukidora`, async () => {
    const { engine, donor, card, events } = setup(kind);
    const before = structuredClone(donor);
    let sawDeclaration = false;
    const emit = engine.emit;
    engine.emit = (id, data) => {
      if (id === RiichiMsg.ENtfPlayCard) {
        sawDeclaration = true;
        assert.deepEqual(donor.hand, before.hand, 'the declared tile must not be removed before the robbery window opens');
        assert.ok(data.userInfos[1].canQiangActions.includes(PlayAction.Hu));
      }
      emit(id, data);
    };
    if (kind === 'babei') await engine.doBaBei(0, card);
    else await engine.doKan(0, card, kind);
    assert.ok(sawDeclaration);
    const stop = events.find((event) => event.id === RiichiMsg.ENtfGameStop)?.data;
    assert.ok(stop, 'must reach the real win settlement');
    assert.deepEqual(stop.huSeats, [1]);
    assert.equal(stop.huCard, card);
    assert.deepEqual(donor.hand, before.hand.filter((tile) => tile !== card));
    assert.deepEqual(stop.userInfos[0].handCards, donor.hand);
    assert.equal(donor.drawnTile, null);
    assert.deepEqual(donor.melds, before.melds);
    assert.equal(engine.kanCount, 0);
    assert.deepEqual(engine.doraIndicators, []);
  });
}

test('nukidora multi-ron removes the robbed tile only once', async () => {
  const { engine, donor, card, events } = setup('babei', true);
  const before = donor.hand.slice();
  await engine.doBaBei(0, card);
  assert.deepEqual(events.find((event) => event.id === RiichiMsg.ENtfGameStop).data.huSeats, [1, 2]);
  assert.deepEqual(donor.hand, before.filter((tile) => tile !== card));
});

test('a normal ron no longer removes tiles from the discarder hand', async () => {
  const { engine, donor, card } = setup('babei');
  donor.hand.splice(donor.hand.indexOf(card), 1);
  donor.discards.push(card);
  donor.drawnTile = null;
  const before = structuredClone(donor);
  await engine.winRons([1], 0, card);
  assert.deepEqual(donor, before);
});

test('if any robbery winner is illegal, neither the hand nor the riichi state can be committed', async () => {
  const { engine, donor, card } = setup('babei');
  donor.riichi = true;
  donor.riichiPending = true;
  donor.score -= 1_000;
  engine.riichiSticks = 1;
  const before = structuredClone(donor);
  await assert.rejects(engine.winRons([1, 2], 0, card, {}, { robbed: true }), /invalid ron/);
  assert.deepEqual(donor, before);
  assert.equal(engine.riichiSticks, 1);
});

test('when a later winner in a multi-ron is illegal, the earlier winner pao flag also cannot be changed', async () => {
  const { engine, donor, events } = setup('kakan');
  const winner = engine.players[1];
  winner.hand = [471, 472, 111, 112, 113, 211, 212];
  winner.melds = [
    { type: 'pon', tiles: [451, 452, 453], from: 2 },
    { type: 'pon', tiles: [461, 462, 463], from: 3 },
  ];
  winner.menzen = false;
  const before = structuredClone(engine.players);
  await assert.rejects(engine.winRons([1, 2], donor.seat, 473), /invalid ron seat=2/);
  assert.deepEqual(engine.players, before);
  assert.equal(events.length, 0);
});

test('settlement is rejected when the robbed physical tile is not in hand, so the last hand tile is not deleted by mistake', async () => {
  const { engine, donor, card, events } = setup('babei');
  donor.hand.splice(donor.hand.indexOf(card), 1);
  const before = structuredClone(donor);
  await assert.rejects(engine.winRons([1], 0, card, {}, { robbed: true }), /robbed tile not in hand/);
  assert.deepEqual(donor, before);
  assert.equal(events.length, 0);
});
