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
    if (Date.now() > end) throw new Error('等待超时');
    await wait(5);
  }
}

const riichiEvents = (frames) => frames.filter((frame) => frame[2] === 20018).map((frame) => P.dict(frame[3])[1]);

test('立直同进程重连：20163.f100 携带当前局面快照，客户端不再收到切点前的整手重放', async (t) => {
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
  const match = P.W().v(1, 4001).v(3, 7).v(4, 1).v(6, 1).bytes();
  mock.dispatch(session, P.W().v(2, 20403).v(11, 1).s(3, P.W().s(1, match).bytes()).bytes());
  await until(() => session.riichi?.engine);
  const prepare = P.W().v(1, RiichiMsg.EReqPrepare).v(3, Date.now()).s(100, new Uint8Array()).bytes();
  mock.dispatch(session, P.W().v(2, 20018).v(11, 2).s(3, prepare).bytes());
  const engine = session.riichi.engine;
  await until(() => engine._pending && engine._expectedDraw);

  assert.equal(clocks.at(-1).running, true, "宿主收到同一个引擎的活动窗口投影");
  ws.readyState = 3;
  session.suspend();
  const frozenClock = engine.humanClockState();
  assert.deepEqual(clocks.at(-1), frozenClock);
  assert.equal(frozenClock.running, false);
  const ws2 = socket();
  session.resume(ws2);
  assert.equal(engine.humanPresent, false, "接上 WebSocket 仍须冻结");
  session.updateHumanPresence();
  assert.equal(engine.humanPresent, false, "连接存在也不能越过同步门禁");
  const reply = mock.dispatch(session, P.W().v(2, 20162).v(11, 3).s(3, new Uint8Array()).bytes()).map((bytes) => P.dict(bytes));
  const body = P.dict(reply[0][3]);
  assert.ok(body[4], '仍带牌桌');
  assert.ok(body[100] instanceof Uint8Array, '日麻快照在业务 f100');
  const scene = decodeMsg('Offline2OnlineGameScene', body[100]);
  const own = scene.offline2OnlineUserInfos[0];
  assert.deepEqual([...own.handCards].sort(), [...engine.players[0].hand].sort());
  assert.deepEqual(own.canPlayActions, engine._expectedDraw.actions);
  assert.ok(scene.offline2OnlineUserInfos.slice(1).every((user) => user.handCards.length === 0));
  await until(() => ws2.controls.some((message) => message.phase === 'end'));
  assert.equal(engine.humanPresent, false, '服务端已发完快照仍需等待Unity消费完成');
  assert.equal(session.replaying, true);
  const marker = ws2.controls.find((message) => message.phase === 'end');
  assert.equal(session.ackClientSync({ id: marker.id, counter: marker.counter }, ws), false, '旧连接不得确认');
  assert.equal(session.ackClientSync({ id: 'wrong', counter: marker.counter }, ws2), false);
  assert.equal(session.ackClientSync({ id: marker.id, counter: marker.counter + 1 }, ws2), false);
  assert.equal(engine.humanPresent, false);
  assert.equal(session.ackClientSync({ id: marker.id, counter: marker.counter }, ws2), true);
  assert.equal(session.ackClientSync({ id: marker.id, counter: marker.counter }, ws2), false, '确认不可重用');
  assert.equal(engine.humanPresent, true, "同步完成才续走余量");
  assert.equal(clocks.at(-1).running, true);
  assert.equal(clocks.at(-1).id, frozenClock.id);
  assert.ok(clocks.at(-1).baseMs <= frozenClock.baseMs, "Node侧带同步后不得补回基础时间");
  await wait(20);
  const events = riichiEvents(ws2.frames);
  assert.ok(!events.includes(RiichiMsg.ENtfGameStart) && !events.includes(RiichiMsg.ENtfToPrepare),
    `快照后不重放开局帧：${events}`);

  // The unsupported-snapshot path must obey the same gate, including the async final push.
  session.suspend(); ws2.readyState = 3;
  session.riichi.reloadScene = () => null;
  const ws3 = socket(), presenceAtDelivery = [];
  const deliver = ws3._deliver;
  ws3._deliver = (bytes) => { presenceAtDelivery.push(engine.humanPresent); deliver(bytes); };
  session.resume(ws3);
  mock.dispatch(session, P.W().v(2, 20162).v(11, 4).s(3, new Uint8Array()).bytes());
  await until(() => ws3.controls.some((message) => message.phase === 'end'));
  assert.ok(presenceAtDelivery.length > 0);
  assert.ok(presenceAtDelivery.every((present) => !present), '重放末帧投递前后都不提前解冻');
  assert.equal(engine.humanPresent, false);
  const replayMarker = ws3.controls.find((message) => message.phase === 'end');
  assert.equal(replayMarker.counter, ws3.frames.at(-1)[27], '确认锚定真正投递的末帧f27');
  assert.equal(session.ackClientSync({ id: replayMarker.id, counter: replayMarker.counter }, ws2), false);
  // Engine activity can append frames while Unity consumes the replay. Catch up again, never silently skip them.
  session.handFrames.push(session.handFrames.at(-1));
  assert.equal(session.ackClientSync(replayMarker, ws3), false);
  assert.equal(engine.humanPresent, false);
  await until(() => ws3.controls.filter((message) => message.phase === 'end').length === 2);
  const tail = ws3.controls.filter((message) => message.phase === 'end').at(-1);
  assert.notEqual(tail.id, replayMarker.id);
  assert.equal(session.ackClientSync(replayMarker, ws3), false, '旧批次确认不能释放追帧批次');
  assert.equal(session.ackClientSync(tail, ws3), true);
  assert.equal(engine.humanPresent, true);
});

test('只有真实断线和未完成同步能冻结计时，正常连接不依赖页面心跳', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = mock.createSession();
  const engine = { humanPresent: true, setHumanPresent(value) { this.humanPresent = value; } };
  session.tableId = 123;
  session.riichi = { engine, matchOver: false, stop() {} };
  t.after(() => session.destroy());
  session.socket = socket();
  session.updateHumanPresence();
  t.mock.timers.tick(60_000);
  assert.equal(engine.humanPresent, true, '没有页面心跳也继续，不能误判断线');
  assert.equal(session._needsResync, false);
  session.suspend();
  session.updateHumanPresence();
  assert.equal(engine.humanPresent, false, '真实断线仍须冻结');
  let closes = 0;
  session.resume({ ...socket(), close() { closes++; } });
  session.updateHumanPresence();
  assert.equal(engine.humanPresent, false);
  t.mock.timers.tick(10_000);
  assert.equal(closes, 1, '无20162时重新连接，不允许带着陈旧画面恢复计时');
  assert.equal(engine.humanPresent, false);
});

test('连接保持时无页面心跳也按25秒耗尽时限并触发超时，不进入恢复', async (t) => {
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

test('恢复确认超时仅重连，不因等待时间到期而解冻', (t) => {
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

test('静态宿主控制侧带可在Unity回调前截获，不会进入protobuf解析', (t) => {
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

test('静态宿主的虚拟WebSocket断开也冻结同一个真人时钟', (t) => {
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
