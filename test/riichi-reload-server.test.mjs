import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__mj = {};
await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');
const { decodeMsg } = await import('../mockjs/pb.mjs');
const { RiichiMsg, PlayAction } = await import('../mockjs/proto_enum.mjs');
const { GameEngine } = await import('../mockjs/engine.mjs');

const P = globalThis.__mj.proto;
const mock = globalThis.__mj.server;
mock.quiet(true);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function socket() {
  const frames = [], controls = [];
  return { frames, controls, readyState: 1,
    _deliver(bytes) { frames.push(P.dict(bytes)); },
    _sync(message) { controls.push(message); },
  };
}

async function until(predicate, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(5);
  }
}

const riichiEvents = (frames) => frames.filter((frame) => frame[2] === 20018).map((frame) => P.dict(frame[3])[1]);

test('riichi same-process reconnect: 20163.f100 carries the current position snapshot, and the client no longer receives the whole-hand replay from before the cut point', async (t) => {
  const old = { ...mock.config };
  Object.assign(mock.config, { seed: 777, matchDelay: 0, engineStartDelay: 0, speed: 0 });
  const session = mock.createSession();
  const clocks = [];
  session.onHumanClock = (clock) => clocks.push(clock);
  t.after(() => {
    session.destroy();
    for (const key of ['seed', 'matchDelay', 'engineStartDelay', 'speed']) mock.config[key] = old[key];
  });
  const ws = socket();
  session.resume(ws);
  session.clientControl({ mjClientId: 'original-page' }, ws);
  const match = P.W().v(1, 4001).v(3, 7).v(4, 1).v(6, 1).bytes();
  mock.dispatch(session, P.W().v(2, 20403).v(11, 1).s(3, P.W().s(1, match).bytes()).bytes());
  await until(() => session.riichi?.engine);
  const prepare = P.W().v(1, RiichiMsg.EReqPrepare).v(3, Date.now()).s(100, new Uint8Array()).bytes();
  mock.dispatch(session, P.W().v(2, 20018).v(11, 2).s(3, prepare).bytes());
  const engine = session.riichi.engine;
  await until(() => engine._pending && engine._expectedDraw);

  assert.equal(clocks.at(-1).running, false, "the tile has not been received yet, so no time is deducted early");
  assert.equal(session.clientControl({ mjClockReady: engine.humanClockState().id }, ws), true);
  assert.equal(clocks.at(-1).running, true, "the clock starts only after the client confirms it can act");
  ws.readyState = 3;
  session.suspend();
  const frozenClock = engine.humanClockState();
  assert.deepEqual(clocks.at(-1), frozenClock);
  assert.equal(frozenClock.running, false);
  const ws2 = socket();
  session.resume(ws2);
  session.clientControl({ mjClientId: 'original-page' }, ws2);
  assert.equal(session.clientControl({ mjClientId: 'stale-page' }, ws), false, 'a stale connection cannot change the recovery context');
  assert.equal(engine.humanPresent, false, "still frozen after reattaching the WebSocket");
  session.updateHumanPresence();
  assert.equal(engine.humanPresent, false, "an existing connection still cannot bypass the sync gate");
  const reply = mock.dispatch(session, P.W().v(2, 20162).v(11, 3).s(3, new Uint8Array()).bytes()).map((bytes) => P.dict(bytes));
  const body = P.dict(reply[0][3]);
  assert.ok(body[4], 'still carries the table');
  assert.ok(body[100] instanceof Uint8Array, 'the riichi snapshot is in business field f100');
  const scene = decodeMsg('Offline2OnlineGameScene', body[100]);
  const own = scene.offline2OnlineUserInfos[0];
  assert.deepEqual([...own.handCards].sort(), [...engine.players[0].hand].sort());
  assert.deepEqual(own.canPlayActions, engine._expectedDraw.actions);
  assert.ok(scene.offline2OnlineUserInfos.slice(1).every((user) => user.handCards.length === 0));
  await until(() => ws2.controls.some((message) => message.phase === 'end'));
  assert.equal(engine.humanPresent, false, 'the server has sent the whole snapshot, but still waits for Unity to finish consuming it');
  assert.equal(session.replaying, true);
  const marker = ws2.controls.find((message) => message.phase === 'end');
  assert.equal(session.ackClientSync({ id: marker.id, counter: marker.counter }, ws), false, 'a stale connection must not confirm');
  assert.equal(session.ackClientSync({ id: 'wrong', counter: marker.counter }, ws2), false);
  assert.equal(session.ackClientSync({ id: marker.id, counter: marker.counter + 1 }, ws2), false);
  assert.equal(engine.humanPresent, false);
  assert.equal(session.ackClientSync({ id: marker.id, counter: marker.counter }, ws2), true);
  assert.equal(session.ackClientSync({ id: marker.id, counter: marker.counter }, ws2), false, 'a confirmation cannot be reused');
  assert.equal(engine.humanPresent, true, "the remaining time resumes only after sync completes");
  assert.equal(clocks.at(-1).running, true);
  assert.equal(clocks.at(-1).id, frozenClock.id);
  assert.ok(clocks.at(-1).baseMs <= frozenClock.baseMs, "the Node side must not restore base time after sync");
  await wait(20);
  const events = riichiEvents(ws2.frames);
  assert.ok(!events.includes(RiichiMsg.ENtfGameStart) && !events.includes(RiichiMsg.ENtfToPrepare),
    `no opening frames are replayed after the snapshot: ${events}`);

  // A fresh page has no Unity table to reload. It must rebuild through the full-hand replay, even at a snapshot-capable cut.
  session.suspend(); ws2.readyState = 3;
  const ws3 = socket(), presenceAtDelivery = [];
  const deliver = ws3._deliver;
  ws3._deliver = (bytes) => { presenceAtDelivery.push(engine.humanPresent); deliver(bytes); };
  session.resume(ws3);
  session.clientControl({ mjClientId: 'new-page' }, ws3);
  const cold = mock.dispatch(session, P.W().v(2, 20162).v(11, 4).s(3, new Uint8Array()).bytes()).map(bytes => P.dict(bytes));
  assert.equal(P.dict(cold[0][3])[100], undefined, 'a new page cannot use the snapshot Reload that only applies to an already loaded table');
  await until(() => riichiEvents(ws3.frames).includes(RiichiMsg.ENtfToPrepare));
  assert.ok(ws3.frames.some(frame => frame[2] === 20408), 'a new page goes through the existing table-entry flow again');
  assert.ok(!riichiEvents(ws3.frames).includes(RiichiMsg.ENtfGameStart), 'historical game-start frames cannot be delivered before the client has entered the table');
  assert.equal(engine.humanPresent, false);
  mock.dispatch(session, P.W().v(2, 20018).v(11, 5).s(3, prepare).bytes());
  await until(() => ws3.controls.some((message) => message.phase === 'end'));
  assert.ok(presenceAtDelivery.length > 0);
  assert.ok(presenceAtDelivery.every((present) => !present), 'does not unfreeze early, before or after the replay final frame is delivered');
  assert.equal(engine.humanPresent, false);
  const replayMarker = ws3.controls.find((message) => message.phase === 'end');
  assert.equal(replayMarker.counter, ws3.frames.at(-1)[27], 'the confirmation is anchored to the final frame f27 actually delivered');
  assert.equal(session.ackClientSync({ id: replayMarker.id, counter: replayMarker.counter }, ws2), false);
  // Engine activity can append frames while Unity consumes the replay. Catch up again, never silently skip them.
  session.handFrames.push(session.handFrames.at(-1));
  assert.equal(session.ackClientSync(replayMarker, ws3), false);
  assert.equal(engine.humanPresent, false);
  await until(() => ws3.controls.filter((message) => message.phase === 'end').length === 2);
  const tail = ws3.controls.filter((message) => message.phase === 'end').at(-1);
  assert.notEqual(tail.id, replayMarker.id);
  assert.equal(session.ackClientSync(replayMarker, ws3), false, 'a confirmation from an old batch cannot release the catch-up batch');
  assert.equal(session.ackClientSync(tail, ws3), true);
  assert.equal(engine.humanPresent, true);
});

test('only a real disconnect and incomplete sync can freeze the clock; a normal connection does not depend on page heartbeats', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = mock.createSession();
  const engine = { humanPresent: true, setHumanPresent(value) { this.humanPresent = value; } };
  session.tableId = 123;
  session.riichi = { engine, matchOver: false, stop() {} };
  t.after(() => session.destroy());
  session.socket = socket();
  session.updateHumanPresence();
  t.mock.timers.tick(60_000);
  assert.equal(engine.humanPresent, true, 'continues without page heartbeats; must not misjudge a disconnect');
  assert.equal(session._needsResync, false);
  session.suspend();
  session.updateHumanPresence();
  assert.equal(engine.humanPresent, false, 'a real disconnect must still freeze');
  let closes = 0;
  session.resume({ ...socket(), close() { closes++; } });
  session.updateHumanPresence();
  assert.equal(engine.humanPresent, false);
  t.mock.timers.tick(10_000);
  assert.equal(closes, 1, 'without 20162, reconnect; the clock may not be restored with a stale screen');
  assert.equal(engine.humanPresent, false);
});

test('with the connection kept alive and no page heartbeats, the 25-second limit still runs out and triggers a timeout instead of entering recovery', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const session = mock.createSession();
  const engine = new GameEngine({ players: 3, speed: 0 });
  engine.players = [0, 1, 2].map((seat) => ({ seat, isHuman: seat === 0, timeBank: 20,
    hand: seat === 0 ? [111] : [], drawnTile: seat === 0 ? 111 : null }));
  session.tableId = 123;
  session.socket = socket();
  session.riichi = { engine, matchOver: false, stop() { engine.finished = true; engine.cancelPending(); } };
  t.after(() => session.destroy());
  engine.expectDraw(0, true, [PlayAction.Normal]);
  const turn = engine.waitHuman('draw');
  t.mock.timers.tick(10_000);
  session.updateHumanPresence();
  assert.deepEqual(engine.humanClockState(), { id: 1, baseMs: 0, extraMs: 15000, running: true });
  assert.equal(session._needsResync, false);
  t.mock.timers.tick(15_000);
  assert.equal(engine.humanClockState().extraMs, 0);
  t.mock.timers.tick(3_000); // Server-only transport grace, never part of the visible countdown.
  const action = await turn;
  assert.deepEqual(action, { action: PlayAction.Normal, card: 111 });
  assert.equal(engine._timedOut.kind, 'draw');
  assert.deepEqual(engine._timedOut.payload, action);
  assert.equal(engine.players[0].timeBank, 0);
  assert.equal(session._clientSync, undefined);
  assert.equal(engine.humanPresent, true);
});

test('a recovery confirmation timeout only reconnects, and does not unfreeze because the wait expired', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = mock.createSession();
  const engine = { humanPresent: false, setHumanPresent(value) { this.humanPresent = value; } };
  let closed = 0;
  const ws = { ...socket(), close() { closed++; } };
  session.socket = ws; session.tableId = 1;
  session.riichi = { engine, matchOver: false, stop() {} };
  session.replaying = true; session._needsResync = true;
  t.after(() => session.destroy());
  session.beginClientSync(false);
  t.mock.timers.tick(30000);
  assert.equal(closed, 1);
  assert.equal(engine.humanPresent, false);
  assert.equal(session.replaying, true);
});

test('control sidebands on the static host are intercepted before the Unity callback and never reach protobuf parsing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ws = new mock.FakeWebSocket('ws://local/ws');
  t.mock.timers.tick(1);
  t.after(() => ws._session.destroy());
  let received = 0, unity = 0;
  ws.addEventListener('message', (event) => {
    received++; assert.equal(JSON.parse(event.data).mjSync.id, 'batch');
    event.stopImmediatePropagation();
  });
  ws.onmessage = () => { unity++; };
  ws._sync({ phase: 'start', id: 'batch' });
  assert.equal(received, 1);
  assert.equal(unity, 0);
});

test('a virtual WebSocket disconnect on the static host also freezes the same human clock', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ws = new mock.FakeWebSocket('ws://local/ws');
  t.mock.timers.tick(1);
  const session = ws._session;
  const engine = { humanPresent: true, setHumanPresent(value) { this.humanPresent = value; } };
  session.tableId = 123;
  session.riichi = { engine, matchOver: false, stop() {} };
  t.after(() => session.destroy());
  session.updateHumanPresence();
  assert.equal(engine.humanPresent, true);
  ws.close();
  assert.equal(engine.humanPresent, false);
  const resumed = new mock.FakeWebSocket('ws://local/ws');
  assert.equal(resumed._session, session);
  t.mock.timers.tick(1);
  session.updateHumanPresence();
  assert.equal(engine.humanPresent, false);
});
