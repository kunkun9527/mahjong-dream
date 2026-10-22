import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayAction as A, Result as R, LiuJuType, RiichiMsg } from '../mockjs/proto_enum.mjs';
import { assertRejectedUnchanged } from './helpers/invariants.mjs';
import { engineFixture, tiles } from './helpers/riichi-fixtures.mjs';

const closedTenpai = '123m123p123s555z7z';

for (const [name, payload, actions, cantPlays, result] of [
  ['非整数动作', { action: 0.5, card: 471 }, [A.Normal], [], R.Fail_InvalidParam],
  ['未提供动作', { action: A.Hu }, [A.Normal], [], R.Fail_ActionNotInCanPlayActions],
  ['伪造牌实体', { action: A.Normal, card: 470 }, [A.Normal], [], R.Fail_CardNotInHand],
  ['食替禁牌', { action: A.Normal, card: 471 }, [A.Normal], [470], R.Fail_CardInCantPlays],
  ['立直未听牌的弃牌', { action: A.Riichi, card: 451 }, [A.Normal, A.Riichi], [], R.Fail_RiichiPlayCardWrong],
  ['没有四张的暗杠', { action: A.AnGang, card: 471 }, [A.Normal, A.AnGang], [], R.Fail_CardNotMatchAction],
  ['没有碰牌的加杠', { action: A.PengGang, card: 471 }, [A.Normal, A.PengGang], [], R.Fail_CardNotMatchAction],
  ['非北牌拔北', { action: A.BaBei, card: 451 }, [A.Normal, A.BaBei], [], R.Fail_CardNotMatchAction],
]) {
  test(`摸打错误码：${name}经提交入口返回指定错误且全状态不变`, () => {
    const { engine } = engineFixture();
    engine.players[0].hand = tiles(closedTenpai + '6z');
    engine.expectDraw(0, true, actions, cantPlays);
    assertRejectedUnchanged(engine, 'submitDraw', payload, result);
  });
}

for (const [name, payload, result] of [
  ['非整数动作', { action: 2.5 }, R.Fail_InvalidParam],
  ['未提供动作', { action: A.Hu }, R.Fail_ActionNotInCanQiangActions],
  ['缺少实体', { action: A.Peng, otherCards: [111] }, R.Fail_InvalidOtherCards],
  ['重复实体', { action: A.Peng, otherCards: [111, 111] }, R.Fail_InvalidOtherCards],
  ['外国实体', { action: A.Peng, otherCards: [111, 114] }, R.Fail_InvalidOtherCards],
  ['错误牌种', { action: A.Peng, otherCards: [111, 121] }, R.Fail_InvalidOtherCards],
  ['明杠少交一张', { action: A.MingGang, otherCards: [111, 112] }, R.Fail_InvalidOtherCards],
  ['非连续吃牌', { action: A.Chi, otherCards: [121, 141] }, R.Fail_InvalidOtherCards],
]) {
  test(`鸣牌错误码：${name}经提交入口拒绝且全状态不变`, () => {
    const { engine } = engineFixture();
    engine.players[0].hand = tiles('11234m123p123s11z');
    engine.players[3].discards = [113];
    engine.expectClaim(0, 3, 113, [A.Peng, A.Chi, A.MingGang, A.Guo]);
    assertRejectedUnchanged(engine, 'submitClaim', payload, result);
  });
}

test('弃牌振听封锁全部等待而非仅舍过的牌，但不封锁自摸', () => {
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

test('立直后见逃的永久振听在后续摸牌后保留并继续禁止荣和', async () => {
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

test('立直宣言要求门清千点与剩余摸牌机会，振听和空听不妨碍宣言', () => {
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

test('立直宣言实际扣千点，未放铳确认后供托与一发状态保持', async () => {
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

test('立直暗杠拒绝改变等待牌种及不是新摸牌的送杠', () => {
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

test('非国士的完成牌即使有抢杠役也不得抢暗杠，但可抢加杠', () => {
  const { engine } = engineFixture();
  const p = engine.players[1];
  p.hand = tiles('123m123p123s555z7z');
  engine.updateWaits(p);
  assert.equal(engine.canRobKan(p, 472, 'kakan'), true);
  assert.equal(engine.canRobKan(p, 472, 'ankan'), false);
});

test('三响优先于碰与途中流局，按放铳者下家顺序提交全部赢家', async () => {
  const { engine } = engineFixture();
  engine.autoHuman = true;
  engine.players[0].isHuman = false;
  engine.aiClaim = (_seat, _from, _card, actions) => ({ action: actions.includes(A.Hu) ? A.Hu : A.Peng });
  engine.checkSiFengLianDa = () => { throw new Error('荣和优先，不得先判四风连打'); };
  let result;
  engine.winRons = async (...args) => { result = args; };
  await engine.resolveClaims(2, 111, [[A.Hu, A.Guo], [A.Hu, A.Peng, A.Guo], [], [A.Hu, A.Guo]]);
  assert.deepEqual(result, [[3, 0, 1], 2, 111]);
});

test('四家立直优先于荒牌和流局满贯且不清算听牌罚符', async () => {
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

test('四风连打仅四麻同种风牌首巡成立，三麻与被鸣后均不成立', async () => {
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

test('九种九牌只计算首巡不同幺九种类，途中流局无罚符且连庄', async () => {
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

test('三麻拔北不算弃牌或副露面子，不翻杠宝但消除一发与首巡判定', async () => {
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

test('明杠的杠宝与加杠一样后翻，弃牌前连续杠先翻上一张', async () => {
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

test('真实三响逐家计分，最近赢家独收本场供托且含庄时连庄', async () => {
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

test('多人流局满贯互相支付满贯而不收罚符、本场和供托', async () => {
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
