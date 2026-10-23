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
  test(`with ${bank} seconds of claim extension left, wait out the full 5-second base plus the 3-second server grace before auto-pass`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const { engine, done, nextDraws } = claimWindow(bank);
    const duration = (8 + bank) * 1_000;
    t.mock.timers.tick(duration - 1);
    await Promise.resolve();
    assert.ok(engine._expectedClaim);
    assert.ok(engine._pending);
    assert.equal(nextDraws(), 0, 'the next player cannot draw before the claim window expires');
    t.mock.timers.tick(1);
    await done;
    assert.equal(nextDraws(), 1);
    assert.equal(engine.players[0].timeBank, 0);
    assert.equal(engine._expectedClaim, null);
    assert.equal(engine._pending, null);
  });
}

test('real disconnect: the clock pauses, no auto-pass and no bank deduction, and the remaining time resumes after sync', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done, nextDraws } = claimWindow(20);
  await Promise.resolve();
  engine.setHumanPresent(false);
  assert.equal(engine._pending.timer, null, 'the human timer must pause on disconnect');
  t.mock.timers.tick(10 * 60_000);
  assert.ok(engine._pending, 'the wait is kept during the disconnect and must not be treated as a timeout');
  assert.equal(nextDraws(), 0);
  assert.equal(engine.players[0].timeBank, 20, 'no bank time is deducted during the disconnect');
  engine.setHumanPresent(true);
  assert.ok(engine._pending.timer, 'the remaining countdown continues after sync recovery');
  assert.equal(engine.submitClaim({ action: PlayAction.Peng, otherCards: [451, 452] }), Result.Succ);
  await done;
});

test('after the extension time is exhausted, a pon can still be submitted in the last millisecond of the base time', async (t) => {
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

test('a pon submitted before or after the client countdown ends is still accepted, and the server grace does not deduct extra bank time', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done } = claimWindow(0);
  let claim;
  engine.executeClaim = async (...args) => { claim = args; return Result.Succ; };
  // The client shows a 5-second base time: a request tapped at the last glance arrives a little late, so the server must still be waiting.
  t.mock.timers.tick(5_400);
  assert.equal(engine.submitClaim({ action: PlayAction.Peng, otherCards: [451, 452] }), Result.Succ);
  await done;
  assert.deepEqual(claim, [0, PlayAction.Peng, 453, 1, [451, 452]]);
  assert.equal(engine.players[0].timeBank, 0, 'the grace is round-trip tolerance, not thinking time');
});

test('when the second validation of the claim fails: do not stall the table, close it as an empty window and move to the next player', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done, nextDraws } = claimWindow(0);
  const frames = [];
  engine.emit = (ev, payload) => { frames.push({ ev, payload }); };
  // Stands in for a payload that passed submitClaim but fails executeClaim's own re-check.
  engine.executeClaim = async () => Result.Fail_InvalidSequence;
  assert.equal(engine.submitClaim({ action: PlayAction.Peng, otherCards: [451, 452] }), Result.Succ);
  await done;
  assert.equal(nextDraws(), 1, 'if the claim does not land, the hand must pass to the next player');
  assert.equal(frames.filter((frame) => frame.ev === RiichiMsg.ENtfQiangCardEnd).at(-1).payload.seats.length, 0);
  assert.deepEqual(frames.filter((frame) => frame.ev === RiichiMsg.ENtfQiangCard).at(-1).payload.seat, 0);
});

test('a manual pass within the base claim time does not deduct extension time and leaves no stale timeout task', async (t) => {
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

test('a draw mid-hand discards the leftover human window, so the bank is not deducted in the next hand', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine } = claimWindow(20);
  t.mock.timers.tick(3_000);
  engine.finishHand = async () => {};
  engine.recordHumanHandStats = () => {};
  engine.buildStopUserInfos = () => [];
  engine.doraIndicators = [];
  engine.players = engine.players.map((p) => ({ melds: [], waits: [], riichi: false, score: 25_000, drawnTile: null, ...p }));
  await engine.endHand({ type: 'draw', liuJuType: LiuJuType.JiuZhongJiuPai, tenpai: [false, false, false], noPenalty: true });
  assert.equal(engine._pending, null, 'no window timer that could fire may remain after the draw');
  assert.equal(engine._expectedClaim, null);
  t.mock.timers.tick(60_000);
  assert.equal(engine.players[0].timeBank, 20, 'unused bank time should not be deducted by a leftover timer');
});

test('claim uses extension time: only the part beyond the 5-second base for this claim is deducted', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done } = claimWindow(20);
  t.mock.timers.tick(8_000);
  assert.equal(engine.submitClaim({ action: PlayAction.Guo }), Result.Succ);
  await done;
  assert.equal(engine.players[0].timeBank, 17);
});

test('after a server-side timeout skip, a late Pass only returns success: no further progress, no time deducted, not recorded; a late pon still fails', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done, nextDraws } = claimWindow(0);
  t.mock.timers.tick(7_999);
  await Promise.resolve();
  assert.ok(engine._expectedClaim, 'after the client countdown ends, still wait out the full server grace');
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

test('a Pass the player submits produces no receipt, and duplicate packets are still rejected', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const { engine, done } = claimWindow(0);
  t.mock.timers.tick(1_000);
  assert.equal(engine.submitClaim({ action: PlayAction.Guo }), Result.Succ);
  await done;
  assert.equal(engine.submitClaim({ action: PlayAction.Guo }), Result.Fail_InvalidSequence);
});

test('after a server-side timeout tsumogiri, a late tsumogiri of the same tile only returns success; discarding a different tile still fails', async (t) => {
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

test('a claim request that arrives after the window has closed: returns failure, re-sends the pass and end notifications, and the client does not get stuck in the claim state', async () => {
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
