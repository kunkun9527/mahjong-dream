import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../mockjs/engine.mjs';
import { PlayAction, Result, RiichiMsg, LiuJuType } from '../mockjs/proto_enum.mjs';

function claimWindow(timeBank) {
  const engine = new GameEngine({ players: 3, speed: 0 });
  engine.players = [0, 1, 2].map((seat) => ({
    seat, isHuman: seat === 0, timeBank, hand: seat === 0 ? [451, 452, 411] : [],
  }));
  const can = [[PlayAction.Peng, PlayAction.Guo], [], []];
  engine.expectClaim(0, 1, 453, can[0]);
  engine.aiClaim = () => null;
  engine.confirmRiichiDeclaration = () => {};
  engine.checkSiFengLianDa = () => false;
  let nextDraws = 0;
  engine.turnDraw = async () => { nextDraws++; };
  const done = engine.resolveClaims(1, 453, can);
  return { engine, done, nextDraws: () => nextDraws };
}

for (const bank of [0, 20]) {
  test(`鸣牌延长时间剩余 ${bank} 秒时，完整等完基础 5 秒加 3 秒服务端宽限再自动过`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const { engine, done, nextDraws } = claimWindow(bank);
    const duration = (8 + bank) * 1_000;
    t.mock.timers.tick(duration - 1);
    await Promise.resolve();
    assert.ok(engine._expectedClaim);
    assert.ok(engine._pending);
    assert.equal(nextDraws(), 0, '鸣牌窗口到期前不允许下一家摸牌');
    t.mock.timers.tick(1);
    await done;
    assert.equal(nextDraws(), 1);
    assert.equal(engine.players[0].timeBank, 0);
    assert.equal(engine._expectedClaim, null);
    assert.equal(engine._pending, null);
  });
}

test('延长时间耗尽后，基础时间最后一毫秒仍能提交碰牌', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done, nextDraws } = claimWindow(0);
  let claim;
  engine.executeClaim = async (...args) => { claim = args; return Result.Succ; };
  t.mock.timers.tick(4_999);
  assert.equal(engine.submitClaim({ action: PlayAction.Peng, otherCards: [451, 452] }), Result.Succ);
  await done;
  assert.deepEqual(claim, [0, PlayAction.Peng, 453, 1, [451, 452]]);
  t.mock.timers.tick(30_000);
  assert.equal(nextDraws(), 0);
  assert.equal(engine.players[0].timeBank, 0);
});

test('客户端自己倒计时结束前后提交的碰仍被受理，服务端宽限不额外扣备用时间', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done } = claimWindow(0);
  let claim;
  engine.executeClaim = async (...args) => { claim = args; return Result.Succ; };
  // 客户端显示的基础时间是 5 秒：最后一眼点下去的请求会晚到一点，服务端必须还在等。
  t.mock.timers.tick(5_400);
  assert.equal(engine.submitClaim({ action: PlayAction.Peng, otherCards: [451, 452] }), Result.Succ);
  await done;
  assert.deepEqual(claim, [0, PlayAction.Peng, 453, 1, [451, 452]]);
  assert.equal(engine.players[0].timeBank, 0, '宽限是往返容差，不算玩家的思考时间');
});

test('鸣牌者二次校验没通过时：不卡住牌桌，按空窗口收尾并轮到下一家', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done, nextDraws } = claimWindow(0);
  const frames = [];
  engine.emit = (ev, payload) => { frames.push({ ev, payload }); };
  // Stands in for a payload that passed submitClaim but fails executeClaim's own re-check.
  engine.executeClaim = async () => Result.Fail_InvalidSequence;
  assert.equal(engine.submitClaim({ action: PlayAction.Peng, otherCards: [451, 452] }), Result.Succ);
  await done;
  assert.equal(nextDraws(), 1, '鸣牌没落地时必须把牌局交给下一家');
  assert.equal(frames.filter((frame) => frame.ev === RiichiMsg.ENtfQiangCardEnd).at(-1).payload.seats.length, 0);
  assert.deepEqual(frames.filter((frame) => frame.ev === RiichiMsg.ENtfQiangCard).at(-1).payload.seat, 0);
});

test('鸣牌基础时间内手动过不扣延长时间，且不会残留超时任务', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done, nextDraws } = claimWindow(20);
  t.mock.timers.tick(4_000);
  assert.equal(engine.submitClaim({ action: PlayAction.Guo }), Result.Succ);
  await done;
  assert.equal(engine.players[0].timeBank, 20);
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(nextDraws(), 1);
});

test('途中流局丢弃残留的真人窗口，备用时间不会被下一局扣掉', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine } = claimWindow(20);
  t.mock.timers.tick(3_000);
  engine.finishHand = async () => {};
  engine.recordHumanHandStats = () => {};
  engine.buildStopUserInfos = () => [];
  engine.doraIndicators = [];
  engine.players = engine.players.map((p) => ({ melds: [], waits: [], riichi: false, score: 25_000, drawnTile: null, ...p }));
  await engine.endHand({ type: 'draw', liuJuType: LiuJuType.JiuZhongJiuPai, tenpai: [false, false, false], noPenalty: true });
  assert.equal(engine._pending, null, '流局后不能留下会触发的窗口计时');
  assert.equal(engine._expectedClaim, null);
  t.mock.timers.tick(60_000);
  assert.equal(engine.players[0].timeBank, 20, '玩家没用完的备用时间不应该被残留计时扣走');
});

test('鸣牌使用延长时间只扣本次超出基础 5 秒的部分', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done } = claimWindow(20);
  t.mock.timers.tick(8_000);
  assert.equal(engine.submitClaim({ action: PlayAction.Guo }), Result.Succ);
  await done;
  assert.equal(engine.players[0].timeBank, 17);
});

test('服务端超时跳过后，迟到的 Pass 只回成功：不再推进、不扣时、不记录；迟到的碰仍失败', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done, nextDraws } = claimWindow(0);
  t.mock.timers.tick(7_999);
  await Promise.resolve();
  assert.ok(engine._expectedClaim, '客户端倒计时结束后时还要等满服务端宽限');
  t.mock.timers.tick(1);
  await done;
  assert.equal(nextDraws(), 1);
  const logged = engine.humanLog.length;
  // The client's countdown is still running: its Pass (clicked or its own timeout) arrives after the server moved on.
  assert.equal(engine.submitClaim({ action: PlayAction.Guo, otherCards: [], isTimeout: true }), Result.Succ);
  assert.equal(engine.submitClaim({ action: PlayAction.Guo, otherCards: [] }), Result.Succ);
  assert.equal(engine.submitClaim({ action: PlayAction.Peng, otherCards: [451, 452] }), Result.Fail_InvalidSequence);
  assert.equal(nextDraws(), 1);
  assert.equal(engine.humanLog.length, logged);
  assert.equal(engine.players[0].timeBank, 0);
  assert.equal(engine._bufferedClaim, null);
  // The receipt ends when the next claim window opens; a Pass then belongs to that window.
  engine.expectClaim(0, 2, 454, [PlayAction.Peng, PlayAction.Guo]);
  assert.equal(engine._timedOut, null);
});

test('玩家自己提交的 Pass 不产生回执，重复包仍被拒', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done } = claimWindow(0);
  t.mock.timers.tick(1_000);
  assert.equal(engine.submitClaim({ action: PlayAction.Guo }), Result.Succ);
  await done;
  assert.equal(engine.submitClaim({ action: PlayAction.Guo }), Result.Fail_InvalidSequence);
});

test('服务端超时摸切后，迟到的同一张摸切只回成功，打别的牌仍失败', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const drawn = 191;
  const engine = new GameEngine({ players: 3, speed: 0 });
  engine.players = [0, 1, 2].map((seat) => ({
    seat, isHuman: seat === 0, timeBank: 0, hand: seat === 0 ? [451, 452, 411, drawn] : [],
    drawnTile: seat === 0 ? drawn : null, melds: [], riichi: false,
  }));
  engine.expectDraw(0, true, [PlayAction.Normal]);
  const turn = engine.waitHuman('draw');
  // First decision of a match: base 5 + the 3s allowance + 8 more for the deal/join animation.
  t.mock.timers.tick(16_000);
  assert.deepEqual(await turn, { action: PlayAction.Normal, card: drawn });
  const logged = engine.humanLog.length;
  assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: drawn, isTimeout: true }), Result.Succ);
  assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: 451 }), Result.Fail_InvalidSequence);
  assert.equal(engine.humanLog.length, logged);
  assert.equal(engine._bufferedDraw, null);
});

test('窗口已关闭时才到达的鸣牌请求：回失败，并补发过牌与结束通知，客户端不会卡在鸣牌态', async () => {
  const engine = new GameEngine({ players: 3, speed: 0 });
  engine.players = [0, 1, 2].map((seat) => ({ seat, isHuman: seat === 0, timeBank: 0, hand: [451, 452, 411] }));
  const frames = [];
  engine.emit = (ev, payload) => { frames.push({ ev, payload }); };
  assert.notEqual(engine.submitClaim({ action: PlayAction.Peng, otherCards: [451, 452] }), Result.Succ);
  assert.deepEqual(frames.map((frame) => frame.ev), [RiichiMsg.ENtfQiangCard, RiichiMsg.ENtfQiangCardEnd]);
  assert.equal(frames[0].payload.seat, 0);
  assert.equal(frames[0].payload.action, PlayAction.Guo);
  assert.equal(frames[1].payload.seats.length, 0);
});
