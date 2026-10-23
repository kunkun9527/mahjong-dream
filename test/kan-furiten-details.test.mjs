import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayAction as A, Result as R, LiuJuType, RiichiMsg } from '../mockjs/proto_enum.mjs';
import { engineFixture, tiles } from './helpers/riichi-fixtures.mjs';
import { assertRejectedUnchanged } from './helpers/invariants.mjs';

function giveHand(engine, seat, text) {
  const reserved = new Set(engine.players.filter((p) => p.seat !== seat)
    .flatMap((p) => [...p.hand, ...p.melds.flatMap((meld) => meld.tiles)])
    .concat(engine.replacements));
  engine.players[seat].hand = tiles(text).map((tile) => {
    while (reserved.has(tile)) tile++;
    assert.ok(tile % 10 <= 4, 'test concealed hand and melds must not hold a fifth copy of the same tile');
    reserved.add(tile);
    return tile;
  });
}

function fourthKan(players, kind, samePlayer = false) {
  const fixture = engineFixture({ players, maxHands: 1 });
  const { engine } = fixture;
  const p = engine.players[0];
  const previous = [2, 3, 4].map((n) => ({ type: 'kan', tiles: tiles(`${n}${n}${n}${n}p`), from: 2 }));
  engine.players[samePlayer ? 0 : 1].melds = previous;
  p.menzen = false;
  p.hand = tiles(samePlayer ? '7z' : '123s789s555z7z');
  if (kind === 'ankan' || kind === 'minkan') p.hand.push(...tiles(kind === 'ankan' ? '9999p' : '999p'));
  else {
    p.melds.push({ type: 'pon', tiles: tiles('999p'), from: 2 });
    p.hand.push(294);
  }
  engine.kanCount = 3;
  engine.deadWall = [...Array(players === 3 ? 8 : 4).fill(0), ...tiles('45678p45678s')];
  engine.doraIndicators = [241, 261, 281, 351];
  engine.uraIndicators = [251, 271, 341, 361];
  engine.replacements = [472];
  engine.wall = [411, 421, 431, 441];
  engine.remain = 4;
  engine.awaitTurn = async () => {};
  engine.players[2].discards = kind === 'minkan' ? [294] : [];
  const declare = () => kind === 'minkan'
    ? engine.executeClaim(0, A.MingGang, 294, 2, [291, 292, 293])
    : engine.doKan(0, kind === 'ankan' ? 291 : 294, kind);
  return { ...fixture, p, declare };
}

for (const players of [3, 4]) {
  for (const [kind, label] of [['ankan', 'closed kan'], ['kakan', 'added kan'], ['minkan', 'open kan']]) {
    test(`${players}-player fourth ${label}: still draws from the rinshan; if no one rons the discard, the four-kan abort applies and omote/ura dora flip on time`, async () => {
      const { engine, frames, p, declare } = fourthKan(players, kind);
      await declare();
      assert.equal(engine.handEnded, false);
      assert.equal(p.drawnTile, 472);
      assert.equal(p.rinshan, true);
      assert.equal(engine.kanCount, 4);
      assert.equal(engine.doraIndicators.length, kind === 'ankan' ? 5 : 4);
      assert.equal(engine.uraIndicators.length, kind === 'ankan' ? 5 : 4);
      assert.equal(engine._deferredKanDora, kind === 'ankan' ? 0 : 1);
      const emit = engine.emit;
      engine.emit = (event, payload) => {
        if (event === RiichiMsg.ENtfPlayCard && payload.action === A.Normal) {
          assert.equal(engine.doraIndicators.length, 5, 'dora must be flipped before the discard claim window opens');
          assert.equal(engine.uraIndicators.length, 5);
          assert.equal(engine.handEnded, false);
        }
        emit(event, payload);
      };
      assert.equal(await engine.processTurnAction(0, A.Normal, 472, true), R.Succ);
      const stop = frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload;
      assert.equal(stop.liuJuType, LiuJuType.SiGang);
      assert.deepEqual(stop.huSeats, []);
      assert.deepEqual(stop.liuJuManGuanSeats, []);
      assert.deepEqual(engine.scores, Array(players).fill(players === 3 ? 35_000 : 25_000));
      assert.equal(engine.honba, 1);
      assert.equal(engine.dealerSeat, 0);
    });

    test(`${players}-player fourth ${label}: rinshan tsumo takes priority over the four-kan abort, and tsumo after an open or added kan does not flip the last kan dora`, async () => {
      const { engine, frames, p, declare } = fourthKan(players, kind);
      await declare();
      assert.equal(engine.canTsumo(p), true);
      assert.equal(await engine.processTurnAction(0, A.Hu, null, true), R.Succ);
      const stop = frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload;
      assert.deepEqual(stop.huSeats, [0]);
      assert.equal(engine.doraIndicators.length, kind === 'ankan' ? 5 : 4);
      assert.equal(engine.uraIndicators.length, kind === 'ankan' ? 5 : 4);
    });

    test(`${players}-player after the fourth ${label}: a real ron on the discard takes priority over the four-kan abort`, async () => {
      const { engine, frames, declare } = fourthKan(players, kind);
      const winner = engine.players[2];
      giveHand(engine, 2, '567p456s678s666z7z');
      engine.updateWaits(winner);
      await declare();
      assert.equal(engine.canRon(winner, 472), true);
      assert.equal(await engine.processTurnAction(0, A.Normal, 472, true), R.Succ);
      assert.deepEqual(frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload.huSeats, [2]);
      assert.equal(engine.doraIndicators.length, 5);
    });
  }

  test(`${players}-player: after the fourth kan, if no one rons the discard, the four-kan abort happens first even when someone can pon`, async () => {
    const { engine, frames, declare } = fourthKan(players, 'ankan');
    await declare();
    const claimant = engine.players[2];
    giveHand(engine, 2, '77z567p456s689s45s');
    engine.updateWaits(claimant);
    const actions = engine.claimActions(2, 0, 472);
    assert.ok(actions.includes(A.Peng));
    assert.equal(actions.includes(A.Hu), false);
    engine.aiClaim = () => ({ action: A.Peng, otherCards: claimant.hand.filter((tile) => Math.floor(tile / 10) === 47) });
    engine.executeClaim = async () => { assert.fail('the fourth-kan discard cannot be ponned'); };
    assert.equal(await engine.processTurnAction(0, A.Normal, 472, true), R.Succ);
    assert.equal(frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload.liuJuType, LiuJuType.SiGang);
  });

  for (const kind of ['ankan', 'kakan']) {
    test(`${players}-player fourth ${kind === 'ankan' ? 'closed kan robbed by kokushi' : 'added kan robbed'}: the kan is not completed and the fourth-kan dora is not flipped`, async () => {
      const { engine, frames, p, declare } = fourthKan(players, kind);
      const winner = engine.players[2];
      giveHand(engine, 2, kind === 'ankan' ? '19m11p19s1234567z' : '456s678s666z78p11z');
      engine.updateWaits(winner);
      const before = structuredClone(p.melds);
      assert.equal(engine.canRobKan(winner, kind === 'ankan' ? 291 : 294, kind), true);
      await declare();
      assert.deepEqual(frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload.huSeats, [2]);
      assert.equal(engine.kanCount, 3);
      assert.deepEqual(p.melds, before);
      assert.equal(engine.replacements.length, 1);
      assert.equal(engine.doraIndicators.length, 4);
      assert.equal(engine.uraIndicators.length, 4);
    });
  }

  test(`${players}-player: the same player's four kans do not end the hand; discarding and rinshan tsumo are still allowed; no fifth closed, added or open kan is offered and rejected submissions leave state unchanged`, async () => {
    const { engine, frames, p, declare } = fourthKan(players, 'ankan', true);
    // Four waits after a kan on a single-tile green dragon wait: the rinshan draw did not pair; after discarding, still waiting on Chun.
    p.hand = [...tiles('9999p'), 461];
    await declare();
    assert.equal(engine.handEnded, false);
    assert.equal(engine.canTsumo(p), false, 'two different honor tiles have not formed a pair yet');
    engine.turnDraw = async () => {};
    assert.equal(await engine.processTurnAction(0, A.Normal, 461, true), R.Succ);
    assert.equal(engine.handEnded, false);
    assert.equal(frames.some((f) => f.event === RiichiMsg.ENtfGameStop), false);
    p.drawnTile = 473;
    p.hand.push(473);
    assert.equal(engine.canTsumo(p), true);
    await engine.winTsumo(0);
    assert.deepEqual(frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload.huSeats, [0]);

    const other = engineFixture({ players }).engine;
    other.kanCount = 4;
    other.players[0].hand = tiles('9999p123s456s55z7z9s');
    other.players[0].drawnTile = 391;
    other.players[0].melds = [{ type: 'pon', tiles: tiles('888p'), from: 1 }];
    const actions = other.turnActions(0, true);
    assert.equal(actions.includes(A.AnGang), false);
    assert.equal(actions.includes(A.PengGang), false);
    other.expectDraw(0, true, actions);
    for (const action of [A.AnGang, A.PengGang]) {
      assertRejectedUnchanged(other, 'submitDraw', { action, card: 291 }, R.Fail_ActionNotInCanPlayActions);
    }
    const claims = other.claimActions(0, 1, 294);
    assert.equal(claims.includes(A.MingGang), false);
    other.expectClaim(0, 1, 294, claims);
    assertRejectedUnchanged(other, 'submitClaim', { action: A.MingGang, otherCards: [291, 292, 293] }, R.Fail_ActionNotInCanQiangActions);
  });
}

function waiting(players, { noYaku = false, riichi = false } = {}) {
  const fixture = engineFixture({ players });
  const { engine } = fixture;
  const p = engine.players[0];
  p.hand = tiles(noYaku ? '123s88s55z' : '123p123s789s555z7z');
  if (noYaku) {
    p.melds = [{ type: 'pon', tiles: tiles('111p'), from: 1 }, { type: 'pon', tiles: tiles('999p'), from: 1 }];
    p.menzen = false;
  }
  p.riichi = riichi;
  engine.updateWaits(p);
  engine.turnDraw = async () => {};
  engine.awaitTurn = async () => {};
  return { ...fixture, p };
}

for (const players of [3, 4]) {
  test(`${players}-player: passing a no-yaku ron still forms same-turn furiten, which blocks the other, yaku-bearing ron until the next draw`, async () => {
    const { engine, p } = waiting(players, { noYaku: true });
    assert.deepEqual(p.waits, [38, 45]);
    assert.equal(engine.canRon(p, 383), false);
    assert.equal(engine.canRon(p, 453), true);
    const done = engine.resolveClaims(1, 383, engine.players.map((q) => q.seat === 1 ? [] : engine.claimActions(q.seat, 1, 383)));
    assert.equal(engine.submitClaim({ action: A.Guo }), R.Succ);
    await done;
    assert.equal(p.tempFuriten, true);
    assert.equal(p.riichiFuriten, false);
    assert.equal(engine.canRon(p, 453), false);
  });

  test(`${players}-player: passing with no yaku and no claim action still records furiten; non-waiting tiles are not recorded by mistake`, async () => {
    const { engine } = engineFixture({ players });
    const p = engine.players[0];
    p.hand = tiles('456p789s2z');
    p.melds = [{ type: 'pon', tiles: tiles('111p'), from: 1 }, { type: 'pon', tiles: tiles('999p'), from: 1 }];
    p.menzen = false;
    engine.updateWaits(p);
    engine.turnDraw = async () => {};
    assert.deepEqual(engine.claimActions(0, 1, 422), []);
    await engine.resolveClaims(1, 431, engine.emptyClaims());
    assert.equal(p.tempFuriten, false);
    await engine.resolveClaims(1, 422, engine.emptyClaims());
    assert.equal(p.tempFuriten, true);
  });

  for (const mode of ['manual pass', 'timeout', 'autoplay pass', 'no-claim auto-pass']) {
    for (const riichi of [false, true]) {
      test(`${players}-player ${riichi ? 'riichi' : 'non-riichi'} yaku-bearing pass (${mode}): only same-turn furiten is cleared at the real draw`, async (t) => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
        const { engine, p } = waiting(players, { riichi });
        const can = engine.players.map((q) => q.seat === 1 ? [] : engine.claimActions(q.seat, 1, 472));
        assert.ok(can[0].includes(A.Hu));
        if (mode === 'no-claim auto-pass') engine.setInternalState({ 2: true });
        const done = engine.resolveClaims(1, 472, can);
        if (mode === 'manual pass') assert.equal(engine.submitClaim({ action: A.Guo }), R.Succ);
        else if (mode === 'timeout') t.mock.timers.tick(28_000);  // base 5 + spare 20 + server redundancy 3
        else if (mode === 'autoplay pass') engine.setHumanAutoplay(true);
        await done;
        assert.equal(p.tempFuriten, !riichi);
        assert.equal(p.riichiFuriten, riichi);
        assert.equal(engine.canRon(p, 473), false);
        // Restores the real draw method, and checks that the temporary furiten is cleared when entering awaitTurn (before any discard).
        delete engine.turnDraw;
        engine.wall = [461, 462];
        engine.remain = 2;
        await engine.turnDraw(0);
        assert.equal(p.tempFuriten, false);
        assert.equal(p.riichiFuriten, riichi);
        p.hand.pop();
        assert.equal(engine.canRon(p, 473), !riichi);
      });
    }
  }

  test(`${players}-player: can ron but pons before drawing; discarding does not clear same-turn furiten, only the rinshan replacement draw does`, async () => {
    const { engine, p } = waiting(players);
    p.melds = [1, 2].map((n) => ({ type: 'pon', tiles: tiles(`${n}${n}${n}p`), from: 1 }));
    p.menzen = false;
    p.hand = tiles('55z77z123s');
    engine.updateWaits(p);
    assert.equal(engine.canRon(p, 453), true);
    engine.players[1].discards = [453];
    engine.lastDiscard = { seat: 1, card: 453 };
    const can = engine.players.map((q) => q.seat === 1 ? [] : engine.claimActions(q.seat, 1, 453));
    const done = engine.resolveClaims(1, 453, can);
    assert.equal(engine.submitClaim({ action: A.Peng, otherCards: [451, 452] }), R.Succ);
    await done;
    assert.equal(p.tempFuriten, true);
    assert.equal(await engine.processTurnAction(0, A.Normal, 311, false), R.Succ);
    assert.equal(p.tempFuriten, true, 'a discard after a claim is not a real draw and must not end same-turn furiten');
    engine.replacements = [312];
    engine.wall = [411, 421];
    engine.remain = 2;
    await engine.drawReplacement(0);
    assert.equal(p.tempFuriten, false);
  });

  test(`${players}-player: when several players can ron and one passes, the other winners are not affected by that player's furiten`, async () => {
    const { engine, p } = waiting(players);
    const winner = engine.players[2];
    giveHand(engine, 2, '456p456s678s666z7z');
    engine.updateWaits(winner);
    let winners;
    engine.winRons = async (seats) => { winners = seats; };
    const can = engine.players.map((q) => q.seat === 1 ? [] : engine.claimActions(q.seat, 1, 473));
    assert.ok(can[0].includes(A.Hu));
    assert.ok(can[2].includes(A.Hu));
    const done = engine.resolveClaims(1, 473, can);
    assert.equal(engine.submitClaim({ action: A.Guo }), R.Succ);
    await done;
    assert.deepEqual(winners, [2]);
    assert.equal(p.tempFuriten, true);
    assert.equal(winner.tempFuriten, false);
  });

  test(`${players}-player: kokushi can rob an ankan but chooses to pass; same-turn furiten is still recorded`, async () => {
    const { engine, p } = waiting(players);
    p.hand = tiles('19m11p19s1234567z');
    engine.updateWaits(p);
    const can = engine.kanRobActions(1, 291, 'ankan');
    assert.ok(can[0].includes(A.Hu));
    const done = engine.resolveKanRob(1, 291, can);
    assert.equal(engine.submitClaim({ action: A.Guo }), R.Succ);
    assert.equal(await done, false);
    assert.equal(p.tempFuriten, true);
    assert.equal(engine.canRon(p, 292), false);
  });

  test(`${players}-player: can ron but open-kans first, which records furiten; same-turn furiten ends only after the actual rinshan draw`, async () => {
    const { engine, p } = waiting(players);
    p.hand = tiles('33345p77z');
    p.melds = [5, 6].map((n) => ({ type: 'pon', tiles: tiles(`${n}${n}${n}z`), from: 1 }));
    p.menzen = false;
    engine.updateWaits(p);
    assert.equal(engine.canRon(p, 234), true);
    engine.players[1].discards = [234];
    engine.replacements = [261];
    engine.wall = [411, 421];
    engine.remain = 2;
    const original = engine.drawReplacement;
    engine.drawReplacement = async function (seat) {
      assert.equal(p.tempFuriten, true, 'submitting a claim cannot be treated as a draw and clear furiten early');
      return original.call(this, seat);
    };
    const can = engine.players.map((q) => q.seat === 1 ? [] : engine.claimActions(q.seat, 1, 234));
    const done = engine.resolveClaims(1, 234, can);
    assert.equal(engine.submitClaim({ action: A.MingGang, otherCards: [231, 232, 233] }), R.Succ);
    await done;
    assert.equal(p.tempFuriten, false);
    assert.equal(p.drawnTile, 261);
  });

  for (const riichi of [false, true]) {
    test(`${players}-player: passing on a robbed added kan records ${riichi ? 'permanent' : 'same-turn'} furiten and forbids ron on the next tile`, async () => {
      const { engine, p } = waiting(players, { riichi });
      engine.expectClaim(0, 1, 472, engine.kanRobActions(1, 472, 'kakan')[0]);
      const done = engine.resolveKanRob(1, 472, engine.kanRobActions(1, 472, 'kakan'));
      assert.equal(engine.submitClaim({ action: A.Guo }), R.Succ);
      assert.equal(await done, false);
      assert.equal(p.tempFuriten, !riichi);
      assert.equal(p.riichiFuriten, riichi);
      assert.equal(engine.canRon(p, 473), false);
    });
  }
}

for (const riichi of [false, true]) {
  test(`3-player: passing on a nukidora robbery records ${riichi ? 'permanent' : 'same-turn'} furiten; one of several robbers passing does not stop the other`, async () => {
    const { engine, p } = waiting(3, { riichi });
    p.hand = tiles('123p123s789s555z4z');
    const winner = engine.players[2];
    giveHand(engine, 2, '456p456s678s666z4z');
    engine.updateWaits(p);
    engine.updateWaits(winner);
    engine.players[1].hand = [443];
    let winners;
    engine.winRons = async (seats) => { winners = seats; };
    const done = engine.doBaBei(1, 443);
    await Promise.resolve();
    assert.equal(engine.submitClaim({ action: A.Guo }), R.Succ);
    await done;
    assert.deepEqual(winners, [2]);
    assert.equal(p.tempFuriten, !riichi);
    assert.equal(p.riichiFuriten, riichi);
  });
}

test('3-player: a no-yaku nukidora robbery that completes the shape still records same-turn furiten, but an ankan that cannot be robbed does not record furiten', async () => {
  const { engine, p } = waiting(3, { noYaku: true });
  p.hand = tiles('123s4z');
  p.melds.push({ type: 'pon', tiles: tiles('222p'), from: 1 });
  engine.updateWaits(p);
  engine.players[1].hand = [442];
  engine.replacements = [411];
  engine.wall = [421, 431];
  engine.remain = 2;
  assert.equal(engine.canRon(p, 442), false);
  await engine.doBaBei(1, 442);
  assert.equal(p.tempFuriten, true);
  p.tempFuriten = false;
  assert.deepEqual(engine.kanRobActions(1, 443, 'ankan')[0], []);
  await engine.resolveKanRob(1, 443, engine.kanRobActions(1, 443, 'ankan'));
  assert.equal(p.tempFuriten, false);
});
