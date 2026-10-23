import test from 'node:test';
import assert from 'node:assert/strict';
import { RiichiSession, GameEngine, encodeMsg, decodeMsg, MSG_NAME } from '../mockjs/browser_entry.mjs';
import { RiichiMsg, PlayAction, Result } from '../mockjs/proto_enum.mjs';

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function setup(t, players, action = PlayAction.Peng, bank = 20) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  // Isolates only the whole start-of-game loop; actual discards, action generation, waiting, validation and call execution are kept.
  t.mock.method(GameEngine.prototype, 'start', async () => {});
  const frames = [];
  const saved = { 0: 1, 1: 1, 2: 1, 3: 0, 4: 0, 5: 1 };
  const session = new RiichiSession({
    players, speed: 0, internalState: saved,
    onFrame: (type, bytes) => frames.push({ type, payload: decodeMsg(MSG_NAME[type], bytes) }),
  });
  const engine = session.ensureEngine();
  const card = action === PlayAction.Chi ? 241 : 454;
  const used = action === PlayAction.Chi ? [221, 231]
    : action === PlayAction.MingGang ? [451, 452, 453] : [451, 452];
  const filler = [211, 261, 281, 311, 331, 351, 371, 391, 411, 421, 431];
  engine.players = Array.from({ length: players }, (_, seat) => ({
    seat, isHuman: seat === 0, score: players === 3 ? 35_000 : 25_000,
    timeBank: bank, hand: seat === 0 ? [...used, ...filler].slice(0, 13) : [],
    melds: [], discards: [], discardKinds: new Set(), waits: [],
    riichi: false, riichiTurn: -1, menzen: true, ippatsu: false,
    tempFuriten: false, riichiFuriten: false, drawnTile: null, rinshan: false,
  }));
  engine.wall = [191, 192, 193, 194];
  engine.replacements = [471];
  engine.remain = engine.wall.length;
  engine.kanCount = 0;
  engine._deferredKanDora = 0;
  engine.doraIndicators = [];
  engine.uraIndicators = [];
  engine.akaSet = new Set();
  engine.firstGoAround = false;
  const nextDraws = [];
  const claimTurns = [];
  engine.turnDraw = async (seat) => { nextDraws.push(seat); };
  engine.awaitTurn = async (seat, drew) => { claimTurns.push({ seat, drew }); };
  const discard = async (from = players - 1) => {
    engine.players[from].discards.push(card);
    engine.players[from].discardKinds.add(Math.floor(card / 10));
    engine.lastDiscard = { seat: from, card };
    await engine.discard(from, card, PlayAction.Normal);
  };
  const submit = (payload) => session.handleClient(RiichiMsg.EReqQiangCard, encodeMsg('ReqQiangCard', payload));
  const setting = (values) => session.handleClient(RiichiMsg.EReqSetInternalState,
    encodeMsg('ReqSetInternalState', { InternalState: values }));
  t.after(() => session.stop());
  return { session, engine, frames, card, used, discard, submit, setting, saved, nextDraws, claimTurns };
}

test('default logs only key events, replayed history stays silent, debug mode keeps details', (t) => {
  t.mock.method(GameEngine.prototype, 'start', async () => {});
  const lines = [];
  const session = new RiichiSession({ players: 4, log: (line) => lines.push(line), onFrame: () => {} });
  t.after(() => session.stop());
  const engine = session.ensureEngine();
  lines.length = 0;
  engine.note('ai', 'analysis-fixture');
  engine.note('claim', 'empty-claim-fixture');
  engine.note('draw', 'draw-detail-fixture', true);
  engine.note('clock', 'arm-fixture', true);
  session.send(RiichiMsg.ENtfQiangCardEnd, { seats: [], action: PlayAction.Guo });
  assert.equal(lines.length, 0, 'no candidate windows or duplicate protocol notices are written to the default log');
  engine.replaying = true;
  engine.note('discard', 'historical-discard-fixture');
  engine.note('hand', 'historical-hand-fixture');
  session.send(RiichiMsg.ENtfGameStart, {});
  assert.equal(lines.length, 0, 'restoring an old match does not re-log historical events');
  engine.replaying = false;
  engine.note('discard', 'live-discard-fixture');
  engine.note('clock', 'resolve-fixture');
  engine.note('win', 'win-fixture');
  assert.equal(lines.length, 3);
  assert.match(lines.join('\n'), /live-discard-fixture/);
  assert.match(lines.join('\n'), /resolve-fixture/);
  assert.match(lines.join('\n'), /win-fixture/);
  const debug = new RiichiSession({ debug: true, log: (line) => lines.push(line) });
  t.after(() => debug.stop());
  const diagnostic = debug.ensureEngine();
  diagnostic.replaying = true;
  diagnostic.note('ai', 'debug-analysis-fixture');
  diagnostic.note('clock', 'debug-arm-fixture', true);
  debug.send(RiichiMsg.ENtfQiangCardEnd, { seats: [], action: PlayAction.Guo });
  assert.match(lines.join('\n'), /debug-analysis-fixture/);
  assert.match(lines.join('\n'), /debug-arm-fixture/);
  assert.match(lines.join('\n'), /NtfQiangCardEnd/);
});

test('engine logs go through the session log callback (so they are not silently dropped)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  t.mock.method(GameEngine.prototype, 'start', async () => {});
  const lines = [];
  const session = new RiichiSession({ players: 4, speed: 0, log: (line) => lines.push(line), onFrame: () => {} });
  const engine = session.ensureEngine();
  engine.note('hand', 'E1-0 test');
  assert.ok(lines.some((line) => line.includes('[riichi] New round')), 'session-level logs must reach the callback');
  assert.ok(lines.some((line) => line.includes('[hand] E1-0 test')), 'engine-level logs must use the same callback');
  session.stop();
});

for (const [players, action, label] of [
  [3, PlayAction.Peng, '3-player pon'], [3, PlayAction.MingGang, '3-player open kan'],
  [4, PlayAction.Chi, '4-player chi'], [4, PlayAction.Peng, '4-player pon'], [4, PlayAction.MingGang, '4-player open kan'],
]) {
  test(`${label}: a legacy saved no-claim setting must not auto-pass for the human right after claim buttons are sent`, async (t) => {
    const f = setup(t, players, action);
    const done = f.discard();
    await flush();
    const notice = f.frames.find((frame) => frame.type === RiichiMsg.ENtfPlayCard).payload;
    assert.ok(notice.userInfos[0].canQiangActions.includes(action));
    assert.equal(notice.userInfos[0].leftTimer, 20, 'leftTimer only carries the spare bank; the client clock is defaultMinTimeout(5) + leftTimer(20)');
    assert.equal(f.nextDraws.length, 0, 'no choice yet; must not advance to the next seat');
    assert.ok(f.engine._pending, 'the claim wait window must be kept');
    t.mock.timers.tick(24_000);
    await flush();
    assert.equal(f.nextDraws.length, 0);
    assert.equal(f.engine.players[0].melds.length, 0);
    assert.equal(f.frames.some((frame) => frame.type === RiichiMsg.ENtfQiangCard), false);
    f.submit({ action, otherCards: f.used });
    await done;
    assert.equal(f.frames.find((frame) => frame.type === RiichiMsg.ERspQiangCard).payload.result, Result.Succ);
    assert.equal(f.engine.players[0].timeBank, 1);
    assert.equal(f.engine.players[0].melds.length, 1);
    assert.deepEqual(f.engine.players[0].melds[0].tiles.slice().sort(), [...f.used, f.card].sort());
    assert.equal(f.frames.filter((frame) => frame.type === RiichiMsg.ENtfQiangCard).length, 1);
    assert.equal(f.frames.filter((frame) => frame.type === RiichiMsg.ENtfQiangCardEnd).length, 1);
    assert.deepEqual(f.claimTurns, [{ seat: 0, drew: action === PlayAction.MingGang }]);
    assert.equal(f.nextDraws.length, 0);
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(f.nextDraws.length, 0, 'after a successful submit, no stale claim-timeout task may advance the hand');
    assert.deepEqual(f.session.opts.internalState, f.saved, 'history settings must not be deleted or inverted');
  });
}

test('shared spare time is only deducted for the part beyond 5 seconds; after it runs out, the next claim still gets 5 seconds', async (t) => {
  const f = setup(t, 3);
  let done = f.discard();
  await flush();
  t.mock.timers.tick(8_000);
  f.submit({ action: PlayAction.Guo });
  await done;
  assert.equal(f.engine.players[0].timeBank, 17);
  done = f.discard();
  await flush();
  assert.equal(f.frames.filter((frame) => frame.type === RiichiMsg.ENtfPlayCard).at(-1).payload.userInfos[0].leftTimer, 17);
  t.mock.timers.tick(24_999);
  await flush();
  assert.equal(f.nextDraws.length, 1);
  t.mock.timers.tick(1);
  await done;
  assert.equal(f.engine.players[0].timeBank, 0);
  done = f.discard();
  await flush();
  t.mock.timers.tick(7_999);
  await flush();
  assert.equal(f.nextDraws.length, 2);
  t.mock.timers.tick(1);
  await done;
  assert.equal(f.nextDraws.length, 3);
});

test('sanma never offers chi and rejects a forged chi request without consuming the existing pon window', async (t) => {
  const f = setup(t, 3);
  const done = f.discard();
  await flush();
  assert.equal(f.engine.claimActions(0, 2, f.card).includes(PlayAction.Chi), false);
  f.submit({ action: PlayAction.Chi, otherCards: f.used });
  assert.equal(f.frames.find((frame) => frame.type === RiichiMsg.ERspQiangCard).payload.result, Result.Fail_ActionNotInCanQiangActions);
  assert.ok(f.engine._pending);
  f.submit({ action: PlayAction.Peng, otherCards: f.used });
  await done;
  f.engine.players[0].hand = [221, 231, 211, 261, 281, 311, 331, 351, 371, 391, 411, 421, 431];
  f.engine.players[0].melds = [];
  f.engine.players[0].waits = [];
  assert.deepEqual(f.engine.claimActions(0, 2, 241), []);
});

test('in 4-player, only the seat after the discarder may chi; other seats cannot claim chi', (t) => {
  const f = setup(t, 4, PlayAction.Chi);
  assert.ok(f.engine.claimActions(0, 3, f.card).includes(PlayAction.Chi));
  assert.equal(f.engine.claimActions(0, 1, f.card).includes(PlayAction.Chi), false);
  assert.equal(f.engine.claimActions(0, 2, f.card).includes(PlayAction.Chi), false);
});

test('no-claim takes effect only when the client explicitly enables it for this hand; after it is disabled, waiting resumes without resetting the spare bank', async (t) => {
  const f = setup(t, 3);
  f.setting({ 2: 1 });
  await f.discard();
  assert.equal(f.nextDraws.length, 1);
  f.setting({ 2: 0 });
  const done = f.discard();
  await flush();
  t.mock.timers.tick(6_000);
  assert.ok(f.engine._pending);
  f.submit({ action: PlayAction.Guo });
  await done;
  assert.equal(f.engine.players[0].timeBank, 19);
});

test('rebinding the page clears old auto-action authorizations, but keeps saved settings and does not reset the spare bank', async (t) => {
  const f = setup(t, 3);
  await import('../mock/proto.js');
  await import('../mock/data.js');
  await import('../mock/userdata.js');
  await import('../mock/server.js');
  const outer = globalThis.__mj.server.createSession();
  outer.riichi = f.session;
  const socket = { readyState: 1, _deliver() {} };
  outer.resume(socket);
  f.setting({ 2: 1, 3: 1 });
  outer.resume(socket);
  assert.equal(f.engine.internalState[2], true, 'the same connection does not clear authorization again');
  f.engine.players[0].timeBank = 7;
  outer.suspend();
  outer.resume({ readyState: 1, _deliver() {} });
  assert.equal(f.engine.internalState[2], false);
  assert.equal(f.engine.internalState[3], false);
  assert.equal(f.session.opts.internalState[2], 1);
  const done = f.discard();
  await flush();
  t.mock.timers.tick(14_999);
  await flush();
  assert.equal(f.nextDraws.length, 0);
  t.mock.timers.tick(1);
  await done;
  assert.equal(f.engine.players[0].timeBank, 0);
});

test('when no-claim is cancelled, an auto-pass that is already queued but not yet executed must not stay in effect', async (t) => {
  const f = setup(t, 3);
  f.setting({ 2: 1 });
  f.engine.expectClaim(0, 2, f.card, [PlayAction.Peng, PlayAction.Guo]);
  const pending = f.engine.waitHuman('claim');
  f.setting({ 2: 0 });
  await flush();
  assert.ok(f.engine._pending, 'after cancelling auto-pass the original window is restored; the stale microtask must not run');
  t.mock.timers.tick(27_999);
  await flush();
  assert.ok(f.engine._pending);
  t.mock.timers.tick(1);
  assert.equal((await pending).action, PlayAction.Guo);
  assert.equal(f.engine.players[0].timeBank, 0);
});

test('a client submitting only some toggles cannot activate other auto-actions in the save', async (t) => {
  const f = setup(t, 3);
  f.setting({ 0: 1, 5: 1 });
  assert.equal(f.engine.internalState[1], false);
  assert.equal(f.engine.internalState[2], false);
  assert.equal(f.engine.internalState[5], true);
  const done = f.discard();
  await flush();
  assert.ok(f.engine._pending);
  f.submit({ action: PlayAction.Guo });
  await done;
});

test('discards and claims share the spare bank; only the next hand restores it to 20 seconds', async (t) => {
  const f = setup(t, 3);
  f.engine.handIndex = 1; // Test the shared bank independently of the match's one-time entrance allowance.
  const p = f.engine.players[0];
  p.hand.push(471);
  p.drawnTile = 471;
  f.engine.expectDraw(0, true, [PlayAction.Normal], []);
  const draw = f.engine.waitHuman('draw');
  t.mock.timers.tick(9_000);
  assert.equal(f.engine.submitDraw({ action: PlayAction.Normal, card: 471 }), Result.Succ);
  await draw;
  assert.equal(p.timeBank, 16);
  p.hand.pop();
  p.drawnTile = null;
  const done = f.discard();
  await flush();
  t.mock.timers.tick(7_000);
  f.submit({ action: PlayAction.Guo });
  await done;
  assert.equal(p.timeBank, 14);
  const nextHand = f.engine.runHand();
  f.engine.submitPrepare();
  await nextHand;
  assert.equal(f.engine.players[0].timeBank, 20);
  const start = f.frames.find((frame) => frame.type === RiichiMsg.ENtfGameStart).payload;
  // The announcement keeps the player-visible base of 5 seconds. Server redundancy is added only to server-side timing and is not exposed here (otherwise the client would wait one extra redundancy at the end of the base period).
  assert.equal(start.defaultMinTimeout, 5);
  assert.equal(start.ServerRedundantTimeOut, 0);
  assert.equal(start.leftTimer, 20);
});

test('settings submitted before preparation still apply after the engine is lazily created, without pulling in other toggles from the save', (t) => {
  t.mock.method(GameEngine.prototype, 'start', async () => {});
  const session = new RiichiSession({ internalState: { 1: 1, 2: 1, 3: 1 } });
  t.after(() => session.stop());
  session.handleClient(RiichiMsg.EReqSetInternalState,
    encodeMsg('ReqSetInternalState', { InternalState: { 2: 1 } }));
  assert.equal(session.engine, null);
  const engine = session.ensureEngine();
  assert.equal(engine.internalState[2], true);
  assert.equal(engine.internalState[1], false);
  assert.equal(engine.internalState[3], false);
});

for (const [players, action, label] of [
  [3, PlayAction.Peng, '3-player pon'], [3, PlayAction.MingGang, '3-player open kan'],
  [4, PlayAction.Chi, '4-player chi'], [4, PlayAction.Peng, '4-player pon'], [4, PlayAction.MingGang, '4-player open kan'],
]) {
  test(`${label}: after the spare bank is exhausted, still waits the full 5-second base plus 3-second grace before advancing to the next seat`, async (t) => {
    const f = setup(t, players, action, 0);
    const done = f.discard();
    await flush();
    t.mock.timers.tick(7_999);
    await flush();
    assert.equal(f.nextDraws.length, 0);
    assert.ok(f.engine._pending);
    t.mock.timers.tick(1);
    await done;
    assert.equal(f.nextDraws.length, 1);
    assert.equal(f.engine.players[0].melds.length, 0);
    assert.equal(f.engine.players[0].timeBank, 0);
  });
}

test('when no one claims, NtfQiangCardEnd is still sent to close the window so the client does not get stuck in the claim phase', async (t) => {
  const f = setup(t, 4);
  const done = f.discard();
  await flush();
  // The AI seats have empty hands, so no one can claim; the window must close once the human explicitly passes.
  f.submit({ action: PlayAction.Guo });
  await done;
  const idx = f.frames.findIndex((frame) => frame.type === RiichiMsg.ENtfQiangCardEnd);
  assert.ok(idx > 0, 'NtfQiangCardEnd must be sent even when no one claims');
  const end = f.frames[idx].payload;
  assert.deepEqual(end.seats, []);
  assert.equal(end.action, PlayAction.Guo);
  assert.deepEqual(end.otherCards, []);
  assert.ok(f.frames.findIndex((frame) => frame.type === RiichiMsg.ENtfPlayCard) < idx);
  // The client only hides the claim buttons on receiving Guo/Hu for its own seat, so the pass must be announced.
  const pass = f.frames.findIndex((frame) => frame.type === RiichiMsg.ENtfQiangCard);
  assert.ok(pass > 0 && pass < idx, 'the pass must be sent as NtfQiangCard before the window closes');
  assert.equal(f.frames[pass].payload.seat, 0);
  assert.equal(f.frames[pass].payload.action, PlayAction.Guo);
  assert.deepEqual(f.frames[pass].payload.otherCards, []);
  assert.deepEqual(f.nextDraws, [0], 'the next seat draws only after the window closes');
  assert.equal(f.frames.filter((frame) => frame.type === RiichiMsg.ENtfQiangCardEnd).length, 1);
});

test('after the claim window times out and auto-passes, NtfQiangCardEnd is sent the same way', async (t) => {
  const f = setup(t, 3);
  const done = f.discard();
  await flush();
  t.mock.timers.tick(28_000);
  await done;
  const ends = f.frames.filter((frame) => frame.type === RiichiMsg.ENtfQiangCardEnd);
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].payload.seats, []);
  assert.equal(ends[0].payload.action, PlayAction.Guo);
  assert.deepEqual(f.nextDraws, [0]);
});

test('ron also closes the claim window: the Hu claim notice and NtfQiangCardEnd are sent first, NtfGameStop last', async (t) => {
  const f = setup(t, 4);
  const eng = f.engine;
  eng.players[1].hand = [111, 112, 113, 121, 122, 123, 131, 132, 133, 451, 452, 453, 211];
  const ends = [];
  t.mock.method(eng, 'endHand', async () => { ends.push(f.frames.map((frame) => frame.type)); });
  f.frames.length = 0;
  await eng.winRons([1], 3, 212);
  assert.equal(ends.length, 1, 'ron must enter settlement');
  assert.deepEqual(f.frames.map((frame) => frame.type),
    [RiichiMsg.ENtfQiangCard, RiichiMsg.ENtfQiangCardEnd]);
  assert.equal(f.frames[0].payload.seat, 1);
  assert.equal(f.frames[0].payload.action, PlayAction.Hu);
  assert.deepEqual(f.frames[1].payload.seats, [1]);
  assert.equal(f.frames[1].payload.action, PlayAction.Hu);
});
