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
    assert.ok(tile % 10 <= 4, '测试暗手与副露不得持有第五张同种牌');
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
  for (const [kind, label] of [['ankan', '暗杠'], ['kakan', '加杠'], ['minkan', '明杠']]) {
    test(`${players}麻第四${label}仍摸岭上，弃牌无人荣和才四杠散了并按时翻表里宝`, async () => {
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
          assert.equal(engine.doraIndicators.length, 5, '弃牌鸣牌窗口开始前必须翻杠宝');
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

    test(`${players}麻第四${label}的岭上自摸优先四杠流局，明加杠自摸不翻最后杠宝`, async () => {
      const { engine, frames, p, declare } = fourthKan(players, kind);
      await declare();
      assert.equal(engine.canTsumo(p), true);
      assert.equal(await engine.processTurnAction(0, A.Hu, null, true), R.Succ);
      const stop = frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload;
      assert.deepEqual(stop.huSeats, [0]);
      assert.equal(engine.doraIndicators.length, kind === 'ankan' ? 5 : 4);
      assert.equal(engine.uraIndicators.length, kind === 'ankan' ? 5 : 4);
    });

    test(`${players}麻第四${label}后弃牌的真实荣和优先四杠流局`, async () => {
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

  test(`${players}麻第四杠后弃牌无人和时即使有人碰也先四杠散了`, async () => {
    const { engine, frames, declare } = fourthKan(players, 'ankan');
    await declare();
    const claimant = engine.players[2];
    giveHand(engine, 2, '77z567p456s689s45s');
    engine.updateWaits(claimant);
    const actions = engine.claimActions(2, 0, 472);
    assert.ok(actions.includes(A.Peng));
    assert.equal(actions.includes(A.Hu), false);
    engine.aiClaim = () => ({ action: A.Peng, otherCards: claimant.hand.filter((tile) => Math.floor(tile / 10) === 47) });
    engine.executeClaim = async () => { assert.fail('第四杠弃牌不能再碰'); };
    assert.equal(await engine.processTurnAction(0, A.Normal, 472, true), R.Succ);
    assert.equal(frames.find((f) => f.event === RiichiMsg.ENtfGameStop).payload.liuJuType, LiuJuType.SiGang);
  });

  for (const kind of ['ankan', 'kakan']) {
    test(`${players}麻第四${kind === 'ankan' ? '暗杠被国士抢' : '加杠被抢'}不成立杠也不翻第四杠宝`, async () => {
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

  test(`${players}麻同一人四杠不流局，可继续弃牌及四杠子自摸，第五暗加明杠均不下发且提交不变`, async () => {
    const { engine, frames, p, declare } = fourthKan(players, 'ankan', true);
    // 四组杠后单骑绿发，岭上摸中未成对，弃发后继续等中。
    p.hand = [...tiles('9999p'), 461];
    await declare();
    assert.equal(engine.handEnded, false);
    assert.equal(engine.canTsumo(p), false, '两张不同字牌尚未成对');
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
  test(`${players}麻无役低目未荣和也形成同巡振听，摸牌前禁止另一有役高目`, async () => {
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

  test(`${players}麻无役见逃没有任何可鸣动作也须记录振听，非等待牌不误记`, async () => {
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

  for (const mode of ['手动过', '超时', '托管自动过', '不鸣自动过']) {
    for (const riichi of [false, true]) {
      test(`${players}麻${riichi ? '立直' : '未立直'}有役见逃${mode}，到真实摸牌时仅清同巡振听`, async (t) => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
        const { engine, p } = waiting(players, { riichi });
        const can = engine.players.map((q) => q.seat === 1 ? [] : engine.claimActions(q.seat, 1, 472));
        assert.ok(can[0].includes(A.Hu));
        if (mode === '不鸣自动过') engine.setInternalState({ 2: true });
        const done = engine.resolveClaims(1, 472, can);
        if (mode === '手动过') assert.equal(engine.submitClaim({ action: A.Guo }), R.Succ);
        else if (mode === '超时') t.mock.timers.tick(25_000);
        else if (mode === '托管自动过') engine.setHumanAutoplay(true);
        await done;
        assert.equal(p.tempFuriten, !riichi);
        assert.equal(p.riichiFuriten, riichi);
        assert.equal(engine.canRon(p, 473), false);
        // 恢复真实摸牌方法，检查进入 awaitTurn（尚未弃牌）时已经解除临时振听。
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

  test(`${players}麻能荣和却碰后未摸牌，弃牌不清同巡振听；岭上补牌才清除`, async () => {
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
    assert.equal(p.tempFuriten, true, '鸣牌弃牌没有真实摸牌，不得结束同巡振听');
    engine.replacements = [312];
    engine.wall = [411, 421];
    engine.remain = 2;
    await engine.drawReplacement(0);
    assert.equal(p.tempFuriten, false);
  });

  test(`${players}麻多人同时可荣和时一人过，其他赢家不受其振听影响`, async () => {
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

  test(`${players}麻国士可抢暗杠但选择过，也记录同巡振听`, async () => {
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

  test(`${players}麻能荣和却明杠先记见逃，实际摸岭上后结束同巡振听`, async () => {
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
      assert.equal(p.tempFuriten, true, '提交鸣牌不能当作摸牌提前清除');
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
    test(`${players}麻抢加杠见逃${riichi ? '记永久' : '记同巡'}振听并禁止下一张荣和`, async () => {
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
  test(`三麻抢北见逃${riichi ? '永久' : '同巡'}振听，多家抢北其中一家过不阻止另一家`, async () => {
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

test('三麻无役抢北牌形完成也记同巡振听，但不能抢的普通暗杠不记见逃', async () => {
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
