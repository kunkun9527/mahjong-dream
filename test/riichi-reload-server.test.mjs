import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__mj = {};
await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');
const { decodeMsg } = await import('../mockjs/pb.mjs');
const { RiichiMsg } = await import('../mockjs/proto_enum.mjs');

const P = globalThis.__mj.proto;
const mock = globalThis.__mj.server;
mock.quiet(true);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function socket() {
  const frames = [];
  return { frames, readyState: 1, _deliver(bytes) { frames.push(P.dict(bytes)); } };
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

  ws.readyState = 3;
  session.suspend();
  const ws2 = socket();
  session.resume(ws2);
  const reply = mock.dispatch(session, P.W().v(2, 20162).v(11, 3).s(3, new Uint8Array()).bytes()).map((bytes) => P.dict(bytes));
  const body = P.dict(reply[0][3]);
  assert.ok(body[4], '仍带牌桌');
  assert.ok(body[100] instanceof Uint8Array, '日麻快照在业务 f100');
  const scene = decodeMsg('Offline2OnlineGameScene', body[100]);
  const own = scene.offline2OnlineUserInfos[0];
  assert.deepEqual([...own.handCards].sort(), [...engine.players[0].hand].sort());
  assert.deepEqual(own.canPlayActions, engine._expectedDraw.actions);
  assert.ok(scene.offline2OnlineUserInfos.slice(1).every((user) => user.handCards.length === 0));
  await until(() => !session.replaying);
  await wait(20);
  const events = riichiEvents(ws2.frames);
  assert.ok(!events.includes(RiichiMsg.ENtfGameStart) && !events.includes(RiichiMsg.ENtfToPrepare),
    `快照后不重放开局帧：${events}`);
});
