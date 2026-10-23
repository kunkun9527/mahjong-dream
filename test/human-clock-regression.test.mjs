import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GameEngine } from '../mockjs/engine.mjs';
import { encodeMsg } from '../mockjs/pb.mjs';
import { buildRiichiReloadScene } from '../mockjs/riichi_reload.mjs';
import { PlayAction, RiichiMsg, Result } from '../mockjs/proto_enum.mjs';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function drawWindow(t, opts = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const engine = new GameEngine({ players: 3, speed: 0, ...opts });
  engine.players = [0, 1, 2].map((seat) => ({ seat, isHuman: seat === 0, timeBank: 20,
    hand: seat === 0 ? [111] : [], drawnTile: seat === 0 ? 111 : null,
    discards: [], melds: [], score: 35000, waits: [], riichi: false }));
  t.after(() => { engine.finished = true; engine.cancelPending(); });
  engine.expectDraw(0, true, [PlayAction.Normal]);
  return engine;
}

for (const honba of [0, 1]) {
  test('dealer ' + (honba ? 'renchan' : 'first hand') + ': no clock deduction during the deal; the full 8+20 is granted only after the client actually starts the countdown', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const engine = new GameEngine({ players: 4, speed: 0, seed: 777, deferHumanClock: true });
    engine.honba = honba;
    engine.awaitTurn = async () => {};
    t.after(() => { engine.finished = true; engine.submitPrepare(); engine.cancelPending(); });
    const hand = engine.runHand();
    await flush(); engine.submitPrepare(); await hand;
    const id = engine.humanClockState().id;
    const turn = engine.waitHuman('draw');
    t.mock.timers.tick(30_000);
    assert.deepEqual(engine.humanClockState(), { id, baseMs: 8000, extraMs: 20000, running: false });
    assert.equal(engine.markHumanReady(id + 1), false, 'old or future windows cannot start the clock');
    engine.setHumanPresent(false);
    assert.equal(engine.markHumanReady(id), false, 'a real disconnect cannot start the clock');
    engine.setHumanPresent(true);
    assert.equal(engine.humanClockState().running, false, 'reconnecting does not replace the actionable confirmation');
    assert.equal(engine.markHumanReady(id), true);
    assert.deepEqual(engine.humanClockState(), { id, baseMs: 8000, extraMs: 20000, running: true });
    t.mock.timers.tick(3000);
    assert.equal(engine.markHumanReady(id), false, 'a repeated confirmation cannot reset the timer');
    assert.equal(engine.humanClockState().baseMs, 5000);
    t.mock.timers.tick(5000);
    assert.equal(engine.humanClockState().extraMs, 20000);
    t.mock.timers.tick(20_000 + 3000);
    await turn;
    assert.equal(engine.players[0].timeBank, 0);
    engine.expectDraw(0, true, [PlayAction.Normal]);
    assert.equal(engine.humanClockState().baseMs, 5000);
    assert.equal(engine.markHumanReady(id), false, 'a late confirmation for the previous window cannot start the next turn');
    assert.equal(engine.humanClockState().running, false);
    assert.equal(engine.markHumanReady(engine.humanClockState().id), true);
  });
}

test('host projection publishes window open, exact freeze, resume and cleanup; excludes network grace', async (t) => {
  const states = [];
  const engine = drawWindow(t, { onHumanClock: (state) => states.push(state) });
  assert.deepEqual(states.at(-1), { id: 1, baseMs: 5000, extraMs: 20000, running: true });
  const turn = engine.waitHuman('draw');
  t.mock.timers.tick(7001);
  engine.setHumanPresent(false);
  assert.deepEqual(states.at(-1), { id: 1, baseMs: 0, extraMs: 17999, running: false });
  t.mock.timers.tick(600000);
  assert.equal(engine.humanClockState().extraMs, 17999);
  engine.setHumanPresent(true);
  assert.equal(states.at(-1).running, true);
  assert.equal(states.at(-1).extraMs, 17999);
  engine.submitDraw({ action: PlayAction.Normal, card: 111 });
  await turn;
  assert.equal(states.at(-1), null);
  assert.equal(engine.humanClockState(), null);
});

test('normal decision: 5-second base plus remaining spare bank; a 10-second action deducts 5 seconds of spare bank; replay does not restore time', async (t) => {
  const engine = drawWindow(t);
  assert.equal(engine.humanTime().leftTimer, 20);
  const first = engine.waitHuman('draw');
  t.mock.timers.tick(10_000);
  assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: 111 }), Result.Succ);
  await first;
  assert.equal(engine.players[0].timeBank, 15);
  // After nukidora or ankan, the next wait only resets the base segment; the spare bank remains the hand's shared allowance.
  engine.expectDraw(0, true, [PlayAction.Normal]);
  assert.equal(engine.humanTime().leftTimer, 15);
  const record = engine.matchRecord();
  const restored = new GameEngine({ players: 3, speed: 0, replayLog: record });
  restored.players = engine.players;
  restored.expectDraw(0, true, [PlayAction.Normal]);
  await restored.waitHuman('draw');
  restored.expectDraw(0, true, [PlayAction.Normal]);
  assert.equal(restored.humanTime().leftTimer, 15);
});

for (const players of [3, 4]) {
  test(`${players}-player duplicate prepare does not cross hands: the dealer's next hand keeps the full 8+20 seconds after a delayed prepare`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const frames = [];
    const engine = new GameEngine({ players, speed: 0, seed: 1,
      emit: (id, data) => frames.push([id, data]) });
    // Only isolate turn execution; exercise the actual per-hand prepare and clock opening path.
    engine.awaitTurn = async () => {};
    t.after(() => { engine.finished = true; engine.submitPrepare(); engine.cancelPending(); });
    const first = engine.runHand();
    await flush();
    engine.submitPrepare();
    await first;
    engine.submitPrepare(); // Duplicate after the first hand has already started.
    engine.cancelPending();
    frames.length = 0;
    const next = engine.runHand();
    await flush();
    assert.equal(frames.some(([id]) => id === RiichiMsg.ENtfGameStart), false);
    for (const delay of [12_000, 13_000, 60_000]) {
      t.mock.timers.tick(delay);
      await flush();
      assert.equal(frames.some(([id]) => id === RiichiMsg.ENtfGameStart), false);
      assert.equal(engine.humanClockState(), null, 'not preparing cannot deduct base or spare time early');
      assert.equal(engine.players[0].timeBank, 20);
    }
    engine.submitPrepare();
    await next;
    assert.deepEqual(engine.humanClockState(), { id: 2, baseMs: 8000, extraMs: 20000, running: true });
    assert.equal(engine.matchRecord().filter(([kind]) => kind === 'p').length, 2);
  });

  test(`${players}-player: neither exceeding 15 seconds without preparing nor a disconnect and reconnect can force the hand to start`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const frames = [];
    const engine = new GameEngine({ players, speed: 0, seed: 1,
      emit: (id, data) => frames.push([id, data]) });
    engine.awaitTurn = async () => {};
    t.after(() => { engine.finished = true; engine.submitPrepare(); engine.cancelPending(); });
    if (players === 4) engine.submitPrepare(); // Before this hand: not a credit for a future hand.
    const hand = engine.runHand();
    await flush();
    t.mock.timers.tick(30_000);
    await flush();
    engine.setHumanPresent(false);
    t.mock.timers.tick(600_000);
    engine.setHumanPresent(true);
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(frames.some(([id]) => id === RiichiMsg.ENtfGameStart), false);
    assert.equal(engine.humanClockState(), null);
    engine.submitPrepare();
    await hand;
    assert.equal(engine.humanTime().defaultMinTimeout, 8);
    assert.equal(engine.humanTime().leftTimer, 20);
  });
}

for (const players of [3, 4]) {
  test(`${players}-player real browser bundle: prepare does not cross hands; dealer hands 8 seconds, non-dealer 5 seconds`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const context = vm.createContext({ console, Date, setTimeout, clearTimeout, TextEncoder, TextDecoder });
    vm.runInContext(readFileSync(new URL('../mock/riichi.js', import.meta.url), 'utf8'), context);
    const engine = new context.__mj.riichi.GameEngine({ players, speed: 0, seed: 1 });
    engine.awaitTurn = async () => {};
    t.after(() => { engine.finished = true; engine.submitPrepare(); engine.cancelPending(); });
    for (const honba of [0, 1]) {
      engine.honba = honba;
      const hand = engine.runHand();
      await flush();
      t.mock.timers.tick(60_000);
      assert.equal(engine.humanClockState(), null, 'the actual bundle cannot force the hand to start without preparing either');
      engine.submitPrepare();
      await hand;
      assert.equal(engine.humanClockState().baseMs, 8000);
      assert.equal(engine.humanClockState().extraMs, 20000);
      engine.submitPrepare(); // Must not authorize the following hand.
      engine.cancelPending();
    }
    engine.dealerSeat = 1;
    const hand = engine.runHand();
    engine.submitPrepare();
    await hand;
    engine.expectDraw(0, true, [PlayAction.Normal]);
    assert.equal(engine.humanClockState().baseMs, 5000);
    engine.finished = true;
    engine.cancelPending();
  });
}

test('legal requests triggered synchronously by the prepare notice are not lost, and cannot pre-store an extra prepare', async (t) => {
  const frames = [];
  const engine = new GameEngine({ players: 3, speed: 0, seed: 1,
    emit: (id) => {
      frames.push(id);
      if (id === RiichiMsg.ENtfToPrepare) { engine.submitPrepare(); engine.submitPrepare(); }
    } });
  engine.awaitTurn = async () => {};
  t.after(() => { engine.finished = true; engine.submitPrepare(); engine.cancelPending(); });
  await engine.runHand();
  assert.ok(frames.includes(RiichiMsg.ENtfGameStart));
  assert.deepEqual(engine.matchRecord(), [['p']]);
});

test('toggling autoplay or stopping the session during prepare releases the wait, without relying on a forced-start timer', async (t) => {
  const engine = new GameEngine({ players: 3, speed: 0, seed: 1 });
  t.after(() => engine.cancelPending());
  const prepare = engine.waitPrepare();
  engine.setHumanAutoplay(true);
  await prepare;
  assert.equal(engine._prepareWaiter, null);
  assert.deepEqual(engine.matchRecord(), [['p']]);
  engine.setHumanAutoplay(false);
  const stopped = engine.waitPrepare();
  engine.finished = true;
  engine.submitPrepare();
  await stopped;
  assert.equal(engine._prepareWaiter, null);
  assert.deepEqual(engine.matchRecord(), [['p']], 'stopping must not record an extra prepare');
  const restoring = new GameEngine({ players: 3, speed: 0, replayLog: [] });
  const interrupted = restoring.waitPrepare();
  restoring.finished = true;
  restoring.submitPrepare();
  await flush();
  assert.equal(restoring._prepareWaiter, null, 'stopping while replay yields control must not create a new wait afterwards');
  await interrupted;
  assert.deepEqual(restoring.matchRecord(), []);
});

test('dealer first hand 8+20 seconds, the extra 3 seconds do not deduct spare bank; subsequent decisions and non-dealers are still 5 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const frames = [];
  const engine = new GameEngine({ players: 3, speed: 0, seed: 1, emit: (id, data) => frames.push([id, data]) });
  engine.awaitTurn = async () => {};
  t.after(() => { engine.finished = true; engine.cancelPending(); });
  void engine.runHand();
  engine.submitPrepare();
  await flush();
  const start = frames.find(([id]) => id === RiichiMsg.ENtfGameStart)[1];
  assert.equal(start.defaultMinTimeout, 5);
  assert.equal(start.leftTimer, 20);
  assert.equal(engine.humanTime().leftTimer, start.leftTimer);
  assert.equal(engine.humanTime().defaultMinTimeout, 8);
  const opening = engine.waitHuman('draw');
  t.mock.timers.tick(10_000);
  engine.setHumanPresent(false);
  assert.equal(engine.humanTime().bankLeft, 18, 'dealer first hand 10 seconds should consume only 2 seconds of spare bank');
  t.mock.timers.tick(60_000);
  assert.equal(engine.humanTime().bankLeft, 18, 'a disconnect cannot re-grant the dealer first-hand time');
  engine.setHumanPresent(true);
  assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: engine.players[0].drawnTile }), Result.Succ);
  await opening;
  assert.equal(engine.players[0].timeBank, 18, 'action submission settles the shared spare bank against the first-hand 8-second base');
  engine.expectDraw(0, true, [PlayAction.Normal]);
  assert.equal(engine.humanTime().defaultMinTimeout, 5, 'later dealer draws no longer add 3 seconds');
  engine.cancelPending();
  engine.dealerSeat = 1;
  const next = engine.runHand();
  engine.submitPrepare();
  await flush();
  // Non-dealer has no human window until their own decision, not at GameStart.
  assert.equal(engine.humanClockState(), null);
  await next;
  engine.expectDraw(0, true, [PlayAction.Normal]);
  assert.equal(engine.humanTime().defaultMinTimeout, 5, 'non-dealer first decision does not add 3 seconds');
  assert.equal(engine.humanTime().leftTimer, 20);
});

for (const elapsed of [2_000, 10_000, 15_000]) {
  test(`after ${elapsed}ms elapsed, repeated freezes: the snapshot does not deduct disconnect time, and resume does not restore base or spare time`, async (t) => {
    const engine = drawWindow(t);
    engine.handIndex = 1;
    // Open a new normal wait.
    engine.cancelPending();
    engine.expectDraw(0, true, [PlayAction.Normal]);
    const turn = engine.waitHuman('draw');
    t.mock.timers.tick(elapsed);
    engine.setHumanPresent(false);
    const frozen = engine.humanTime();
    const start = encodeMsg('NtfGameStart', { zhuangSeat: 0, remainDuiCardNum: 40, defaultMinTimeout: 5,
      userInfos: engine.players.map((p) => ({ seat: p.seat, handCards: p.hand, score: p.score, initScore: p.score })) });
    engine.isFuriten = () => false;
    engine.furitenTypes = () => [];
    engine.buildTingInfos = () => [];
    engine.riichiFutureAnkanKinds = () => [];
    t.mock.timers.tick(60_000);
    assert.deepEqual(engine.humanTime(), frozen);
    const own = buildRiichiReloadScene([[RiichiMsg.ENtfGameStart, start]], engine).offline2OnlineUserInfos[0];
    assert.equal(own.leftTimer, frozen.leftTimer);
    assert.equal(own.DefaultMinTimeout, frozen.defaultMinTimeout);
    engine.setHumanPresent(true);
    engine.setHumanPresent(true); // A heartbeat must not grant time again.
    t.mock.timers.tick(1_000);
    engine.setHumanPresent(false);
    t.mock.timers.tick(60_000);
    engine.setHumanPresent(true);
    assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: 111 }), Result.Succ);
    await turn;
    assert.equal(engine.players[0].timeBank, 20 - Math.max(0, (elapsed + 1_000) / 1000 - 5));
  });
}

test('time between the notice and waitHuman belongs to the same window; an early request only deducts up to submission', async (t) => {
  const engine = drawWindow(t);
  engine.handIndex = 1;
  engine.cancelPending();
  engine.expectDraw(0, true, [PlayAction.Normal]);
  t.mock.timers.tick(7_000);
  engine.submitDraw({ action: PlayAction.Normal, card: 111 });
  t.mock.timers.tick(2_000);
  await engine.waitHuman('draw');
  assert.equal(engine.players[0].timeBank, 18);
});

test('timeout uplink from a disconnected client cannot advance the frozen window; actions are accepted only after resync on reconnect', async (t) => {
  const engine = drawWindow(t);
  const turn = engine.waitHuman('draw');
  t.mock.timers.tick(2_000);
  engine.setHumanPresent(false);
  const frozen = engine.humanTime();
  t.mock.timers.tick(60_000);
  assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: 111, isTimeout: true }), Result.Fail_InvalidSequence);
  assert.deepEqual(engine.humanTime(), frozen);
  assert.ok(engine._pending);
  engine.setHumanPresent(true);
  assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: 111 }), Result.Succ);
  await turn;
  assert.equal(engine.players[0].timeBank, 20);
});

test('after a pause, timeout waits only for the remaining allowance plus network grace; stale tasks cannot affect the next window', { timeout: 1000 }, async (t) => {
  const engine = drawWindow(t);
  engine.handIndex = 1;
  engine.cancelPending();
  engine.expectDraw(0, true, [PlayAction.Normal]);
  const turn = engine.waitHuman('draw');
  t.mock.timers.tick(7_000);
  engine.setHumanPresent(false);
  t.mock.timers.tick(600_000);
  engine.setHumanPresent(true);
  t.mock.timers.tick(20_999);
  assert.ok(engine._pending);
  t.mock.timers.tick(1);
  await turn;
  assert.equal(engine.players[0].timeBank, 0);
  engine.expectDraw(0, true, [PlayAction.Normal]);
  void engine.waitHuman('draw');
  t.mock.timers.tick(7_999);
  assert.ok(engine._pending);
});
