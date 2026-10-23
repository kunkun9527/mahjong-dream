import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayAction as A, Result as R, LiuJuType, RiichiMsg } from '../mockjs/proto_enum.mjs';
import { assertRejectedUnchanged } from './helpers/invariants.mjs';
import { engineFixture, tiles } from './helpers/riichi-fixtures.mjs';

const closedTenpai = '123m123p123s555z7z';

for (const [name, payload, actions, cantPlays, result] of [
  ['non-integer action', { action: 0.5, card: 471 }, [A.Normal], [], R.Fail_InvalidParam],
  ['action not provided', { action: A.Hu }, [A.Normal], [], R.Fail_ActionNotInCanPlayActions],
  ['forged tile entity', { action: A.Normal, card: 470 }, [A.Normal], [], R.Fail_CardNotInHand],
  ['kuikae-forbidden tile', { action: A.Normal, card: 471 }, [A.Normal], [470], R.Fail_CardInCantPlays],
  ['riichi discard that does not leave tenpai', { action: A.Riichi, card: 451 }, [A.Normal, A.Riichi], [], R.Fail_RiichiPlayCardWrong],
  ['ankan without four copies', { action: A.AnGang, card: 471 }, [A.Normal, A.AnGang], [], R.Fail_CardNotMatchAction],
  ['added kan without a pon', { action: A.PengGang, card: 471 }, [A.Normal, A.PengGang], [], R.Fail_CardNotMatchAction],
  ['nukidora on a non-north tile', { action: A.BaBei, card: 451 }, [A.Normal, A.BaBei], [], R.Fail_CardNotMatchAction],
]) {
  test(`draw/discard error code: ${name} returns the expected error via the submit entry and leaves all state unchanged`, () => {
    const { engine } = engineFixture();
    engine.players[0].hand = tiles(closedTenpai + '6z');
    engine.expectDraw(0, true, actions, cantPlays);
    assertRejectedUnchanged(engine, 'submitDraw', payload, result);
  });
}

for (const [name, payload, result] of [
  ['non-integer action', { action: 2.5 }, R.Fail_InvalidParam],
  ['action not provided', { action: A.Hu }, R.Fail_ActionNotInCanQiangActions],
  ['missing tile entity', { action: A.Peng, otherCards: [111] }, R.Fail_InvalidOtherCards],
  ['duplicate tile entity', { action: A.Peng, otherCards: [111, 111] }, R.Fail_InvalidOtherCards],
  ['tile entity of another kind', { action: A.Peng, otherCards: [111, 114] }, R.Fail_InvalidOtherCards],
  ['wrong tile kind', { action: A.Peng, otherCards: [111, 121] }, R.Fail_InvalidOtherCards],
  ['open kan missing one tile', { action: A.MingGang, otherCards: [111, 112] }, R.Fail_InvalidOtherCards],
  ['non-consecutive chi tiles', { action: A.Chi, otherCards: [121, 141] }, R.Fail_InvalidOtherCards],
]) {
  test(`claim error code: ${name} is rejected via the submit entry and leaves all state unchanged`, () => {
    const { engine } = engineFixture();
    engine.players[0].hand = tiles('11234m123p123s11z');
    engine.players[3].discards = [113];
    engine.expectClaim(0, 3, 113, [A.Peng, A.Chi, A.MingGang, A.Guo]);
    assertRejectedUnchanged(engine, 'submitClaim', payload, result);
  });
}

test('discard furiten blocks all waits, not only the discarded tile, but does not block tsumo', () => {
  const { engine } = engineFixture();
  const p = engine.players[0];
  p.hand = tiles('123m123p123s55z67s');
  engine.updateWaits(p);
  assert.deepEqual(p.waits, [35, 38]);
  assert.equal(engine.canRon(p, 351), true);
  p.discardKinds.add(38);
  assert.deepEqual(engine.furitenTypes(p), [2]);
  assert.equal(engine.canRon(p, 351), false);
  p.hand.push(351);
  p.drawnTile = 351;
  assert.equal(engine.canTsumo(p), true);
});

test('permanent furiten from passing on riichi persists after the next draw and still forbids ron', async () => {
  const { engine } = engineFixture();
  const p = engine.players[0];
  p.hand = tiles(closedTenpai);
  p.riichi = true;
  engine.updateWaits(p);
  engine.markPassedRon(p);
  assert.deepEqual(engine.furitenTypes(p), [0]);
  engine.wall = [461];
  engine.remain = 1;
  engine.awaitTurn = async () => {};
  await engine.turnDraw(0);
  assert.equal(p.riichiFuriten, true);
  p.hand.pop();
  assert.equal(engine.canRon(p, 472), false);
});

test('riichi declaration requires a closed hand, 1000 points and enough draws left; furiten and no-wait hands do not block it', () => {
  for (const players of [3, 4]) {
    const { engine } = engineFixture({ players });
    const p = engine.players[0];
    p.hand = tiles('123p123s789s555z7z6z');
    engine.remain = players;
    p.score = 1000;
    p.discardKinds.add(47);
    assert.equal(engine.canRiichi(p), true);
    p.score = 999;
    assert.equal(engine.canRiichi(p), false);
    p.score = 1000;
    engine.remain = players - 1;
    assert.equal(engine.canRiichi(p), false);
    engine.remain = players;
    p.menzen = false;
    assert.equal(engine.canRiichi(p), false);
    p.menzen = true;
    p.riichi = true;
    assert.equal(engine.canRiichi(p), false);
  }
});

test('riichi declaration actually deducts 1000 points; after no one calls ron on the discard, the riichi stick and ippatsu state are kept', async () => {
  const { engine } = engineFixture();
  const p = engine.players[0];
  p.hand = tiles(closedTenpai + '6z');
  p.drawnTile = 461;
  engine.firstGoAround = true;
  engine.turnDraw = async () => {};
  assert.equal(await engine.processTurnAction(0, A.Riichi, 461, true), R.Succ);
  assert.equal(p.score, 24_000);
  assert.equal(engine.riichiSticks, 1);
  assert.equal(p.riichi, true);
  assert.equal(p.doubleRiichi, true);
  assert.equal(p.riichiPending, false);
  assert.equal(p.ippatsu, true);
  assert.deepEqual(p.discards, [461]);
});

test('riichi ankan is rejected if it changes the wait tile kinds or is not made on the fresh draw', () => {
  const { engine } = engineFixture();
  const p = engine.players[0];
  // Nine Gates' thirteen-sided wait: after kanning the 1m triplet, the number of waiting tile kinds decreases.
  p.hand = tiles('1112345678999m1m');
  p.riichi = true;
  p.riichiTurn = 1;
  p.drawnTile = 114;
  assert.equal(engine.riichiAnkanKeepsWaits(p, 11), false);
  assert.deepEqual(engine.concealedQuadTiles(p), []);
  engine.expectDraw(0, true, [A.Normal, A.AnGang]);
  assertRejectedUnchanged(engine, 'submitDraw', { action: A.AnGang, card: 111 }, R.Fail_CardNotMatchAction);
  p.hand = tiles('1111m234p567p789s2s');
  p.drawnTile = 321;
  assert.deepEqual(engine.concealedQuadTiles(p), []);
});

test('a non-kokushi winning tile cannot rob an ankan even with a robbing-kan yaku, but can rob an added kan', () => {
  const { engine } = engineFixture();
  const p = engine.players[1];
  p.hand = tiles('123m123p123s555z7z');
  engine.updateWaits(p);
  assert.equal(engine.canRobKan(p, 472, 'kakan'), true);
  assert.equal(engine.canRobKan(p, 472, 'ankan'), false);
});

test('triple ron takes priority over pon and mid-hand draws, and all winners are submitted in order starting from the seat after the discarder', async () => {
  const { engine } = engineFixture();
  engine.autoHuman = true;
  engine.players[0].isHuman = false;
  engine.aiClaim = (_seat, _from, _card, actions) => ({ action: actions.includes(A.Hu) ? A.Hu : A.Peng });
  engine.checkSiFengLianDa = () => { throw new Error('ron takes priority; four-wind must not be checked first'); };
  let result;
  engine.winRons = async (...args) => { result = args; };
  await engine.resolveClaims(2, 111, [[A.Hu, A.Guo], [A.Hu, A.Peng, A.Guo], [], [A.Hu, A.Guo]]);
  assert.deepEqual(result, [[3, 0, 1], 2, 111]);
});

test('four-riichi takes priority over exhaustive-draw nagashi mangan and does not settle tenpai payments', async () => {
  const { engine, frames } = engineFixture();
  engine.remain = 0;
  for (const p of engine.players) {
    p.riichi = true;
    p.discards = [411 + p.seat];
  }
  engine.players[3].riichiPending = true;
  engine.riichiSticks = 4;
  engine.players.forEach((p) => { p.score -= 1000; });
  await engine.resolveClaims(3, 414, engine.emptyClaims());
  const stop = frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload;
  assert.equal(stop.liuJuType, LiuJuType.SiJiaLiZhi);
  assert.deepEqual(stop.liuJuManGuanSeats, []);
  assert.deepEqual(engine.scores, [24_000, 24_000, 24_000, 24_000]);
  assert.equal(engine.riichiSticks, 4);
  assert.equal(engine.dealerSeat, 0);
  assert.equal(engine.honba, 1);
});

test('four-wind declaration only holds in 4-player on the first go-around with the same wind tile; it does not hold in 3-player or after a claim', async () => {
  const { engine, frames } = engineFixture();
  for (const p of engine.players) p.discards = [411 + p.seat];
  engine.firstGoAround = true;
  assert.equal(engine.checkSiFengLianDa(), true);
  await engine.resolveClaims(3, 414, engine.emptyClaims());
  assert.equal(frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload.liuJuType, LiuJuType.SiFengLianDa);
  engine.firstGoAround = false;
  assert.equal(engine.checkSiFengLianDa(), false);
  const sanma = engineFixture({ players: 3 }).engine;
  sanma.firstGoAround = true;
  sanma.players.forEach((p) => { p.discards = [411 + p.seat]; });
  assert.equal(sanma.checkSiFengLianDa(), false);
});

test('nine-kinds nine-terminals counts distinct terminal/honor kinds on the first go-around only; mid-hand draw has no penalty and the dealer repeats', async () => {
  const { engine, frames } = engineFixture();
  const p = engine.players[0];
  p.hand = tiles('19m19p19s1234567z1m');
  engine.firstGoAround = true;
  assert.equal(engine.canJiuZhongJiuPai(p), true);
  assert.equal(await engine.processTurnAction(0, A.JiuZhongJiuLiuJu, null, true), R.Succ);
  assert.equal(frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload.liuJuType, LiuJuType.JiuZhongJiuPai);
  assert.deepEqual(engine.scores, [25_000, 25_000, 25_000, 25_000]);
  assert.equal(engine.dealerSeat, 0);
  engine.firstGoAround = false;
  assert.equal(engine.canJiuZhongJiuPai(p), false);
  engine.firstGoAround = true;
  p.hand = tiles('111999m111999p11z');
  assert.equal(engine.canJiuZhongJiuPai(p), false);
});

test('in 3-player, nukidora is not counted as a discard or a meld set, does not flip kan dora, but cancels ippatsu and the first go-around', async () => {
  const { engine } = engineFixture({ players: 3 });
  const p = engine.players[0];
  p.hand = tiles('123p123s789s555z4z7z');
  p.ippatsu = true;
  p.drawnTile = 471;
  engine.firstGoAround = true;
  engine.replacements = [211, 212];
  engine.wall = [391, 392];
  engine.remain = 2;
  engine.doraIndicators = [111];
  engine.awaitTurn = async () => {};
  await engine.doBaBei(0, 441);
  assert.deepEqual(p.melds, [{ type: 'babei', tiles: [441] }]);
  assert.equal(p.menzen, true);
  assert.equal(p.ippatsu, false);
  assert.equal(engine.firstGoAround, false);
  assert.equal(p.discardKinds.has(44), false);
  assert.deepEqual(p.discards, []);
  assert.equal(engine.kanCount, 0);
  assert.deepEqual(engine.doraIndicators, [111]);
  assert.equal(p.drawnTile, 212);
  assert.equal(p.rinshan, true);
  assert.equal(engine.remain, 1);
});

test('open kan dora is deferred like added kan; the earlier deferred dora flips with the next kan', async () => {
  const { engine } = engineFixture();
  const p = engine.players[0];
  p.hand = tiles('111m123p123s55z');
  engine.players[3].discards = [114];
  engine.deadWall = [471, 472, 473, 474, 211, 311, 221, 321, 231, 331, 241, 341, 251, 351];
  engine.doraIndicators = [211];
  engine.uraIndicators = [311];
  engine.replacements = [471, 472];
  engine.wall = [391, 392, 393];
  engine.remain = 3;
  engine.awaitTurn = async () => {};
  assert.equal(await engine.executeClaim(0, A.MingGang, 114, 3, [111, 112, 113]), R.Succ);
  assert.deepEqual(engine.doraIndicators, [211]);
  assert.equal(engine._deferredKanDora, 1);
  engine.kanRobActions = () => engine.emptyClaims();
  engine.resolveKanRob = async () => true;
  await engine.doKan(0, 471, 'kakan');
  assert.deepEqual(engine.doraIndicators, [211, 221]);
  assert.deepEqual(engine.uraIndicators, [311, 321]);
  assert.equal(engine._deferredKanDora, 0);
});

test('real triple ron is scored seat by seat; the nearest winner alone collects honba and riichi sticks, and the dealer repeats if among the winners', async () => {
  const { engine, frames } = engineFixture();
  engine.autoHuman = true;
  engine.honba = 1;
  engine.riichiSticks = 3;
  for (const [index, seat] of [3, 0, 1].entries()) {
    const p = engine.players[seat];
    p.hand = [...tiles('123m456p789s').map((id) => id + index),
      ...tiles(`${seat === 0 ? '111' : seat === 1 ? '222' : '333'}z`), 471 + index];
    p.riichi = true;
    p.score -= 1000;
    engine.updateWaits(p);
  }
  engine.players[2].discards = [474];
  engine.lastDiscard = { seat: 2, card: 474 };
  const can = engine.players.map((p) => p.seat === 2 ? [] : engine.claimActions(p.seat, 2, 474));
  for (const seat of [0, 1, 3]) assert.ok(can[seat].includes(A.Hu));
  await engine.resolveClaims(2, 474, can);
  const stop = frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload;
  assert.deepEqual(stop.huSeats, [3, 0, 1]);
  assert.deepEqual(engine.scores, [33_600, 27_200, 10_300, 28_900]);
  assert.equal(engine.dealerSeat, 0);
  assert.equal(engine.honba, 2);
  assert.equal(engine.riichiSticks, 0);
});

test('multi-player nagashi mangan payments do not collect tenpai penalties, honba or riichi sticks', async () => {
  const { engine } = engineFixture();
  engine.honba = 2;
  engine.riichiSticks = 1;
  engine.players[0].score -= 1000;
  await engine.endHand({ type: 'draw', liuJuType: LiuJuType.HuangPai,
    tenpai: [false, false, false, false], nagashiWinners: [1, 2] });
  assert.deepEqual(engine.scores, [16_000, 31_000, 31_000, 21_000]);
  assert.equal(engine.riichiSticks, 1);
  assert.equal(engine.dealerSeat, 1);
  assert.equal(engine.honba, 3);
});
