import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__mj = {};
await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');

const P = globalThis.__mj.proto;
const mock = globalThis.__mj.server;
mock.quiet(true);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(5);
  }
}

async function aiLevelsForRoom(t, roomId) {
  const old = { ...mock.config };
  Object.assign(mock.config, { seed: 99, matchDelay: 0, engineStartDelay: 0, speed: 0 });
  const session = mock.createSession();
  t.after(() => {
    session.destroy();
    for (const key of ['seed', 'matchDelay', 'engineStartDelay', 'speed']) mock.config[key] = old[key];
  });
  session.resume({ readyState: 1, _deliver() {} });
  const match = P.W().v(1, 4001).v(3, 7).v(4, roomId).v(6, 1).bytes();
  mock.dispatch(session, P.W().v(2, 20403).v(11, 1).s(3, P.W().s(1, match).bytes()).bytes());
  await until(() => session.riichi?.engine);
  return session.riichi.engine.aiLevels;
}

for (const roomId of [1, 2]) {
  test(`rank rooms Qihang/Zhumeng (roomID=${roomId}) use basic AI`, async (t) => {
    assert.deepEqual(await aiLevelsForRoom(t, roomId), Array(4).fill('basic'));
  });
}

test('unknown room defaults to intermediate AI', async (t) => {
  assert.deepEqual(await aiLevelsForRoom(t, 999), Array(4).fill('intermediate'));
});

test('rank room Yulong (roomID=4) uses advanced AI', async (t) => {
  assert.deepEqual(await aiLevelsForRoom(t, 4), Array(4).fill('advanced'));
});

test('rank room Chengfeng (roomID=3) uses intermediate AI', async (t) => {
  assert.deepEqual(await aiLevelsForRoom(t, 3), Array(4).fill('intermediate'));
});
