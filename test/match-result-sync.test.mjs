// After a ranked match ends, local rank / record / coin data changes must be sent to the client in the f24 of the leave-table reply,
// otherwise the rank bar and balance on the room-select page stay at old values (found in browser acceptance: the rank bar did not refresh after consecutive matches).
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__mj = {};
await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');

const P = globalThis.__mj.proto;
const R = globalThis.__mj.riichi;
const mock = globalThis.__mj.server;
mock.quiet(true);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rpc(session, mid, seq, payload) {
  return mock.dispatch(session, P.W().v(2, mid).v(11, seq).s(3, payload).bytes()).map((bytes) => P.dict(bytes));
}

function riichiNames(frames) {
  return frames.filter((f) => f[2] === 20018).map((f) => R.MSG_NAME[P.dict(f[3])[1]]);
}

function changedRows(frame, dtype) {
  const change = P.get(frame[24], 1);
  const modules = P.parse(change).filter(([field]) => field === 2).map(([, , bytes]) => bytes);
  const rows = [];
  for (const bytes of modules) {
    if (P.dict(bytes)[1] !== dtype) continue;
    for (const [field, , row] of P.parse(bytes)) if (field === 3) rows.push(P.dict(row));
  }
  return rows;
}

test('段位战终局：段位与金币变更随 20102 离桌应答 f24 下发', async (t) => {
  const old = { ...mock.config };
  Object.assign(mock.config, { seed: 7, matchDelay: 0, engineStartDelay: 0, speed: 0, autoHuman: true });
  const session = mock.createSession();
  const frames = [];
  session.resume({ readyState: 1, _deliver(bytes) { frames.push(P.dict(bytes)); } });
  let calls = 0;
  session.onFinalResult = () => {
    calls += 1;
    return {
      placement: 1,
      coins: 100,
      rank: { change: 0 },
      changes: [
        mock.userdata.changeInventory([{ dtype: 6, id: 60001, count: 100 }]),
        ...mock.updateRanks({ yonma: { level: 17, point: 1234 }, sanma: { level: 17, point: 2300 } }),
      ],
    };
  };
  t.after(() => {
    session.destroy();
    for (const key of ['seed', 'matchDelay', 'engineStartDelay', 'speed', 'autoHuman']) mock.config[key] = old[key];
  });

  const coinsBefore = mock.userdata.inventoryCount(6, 60001);
  // Four-player ranked East-wind (gameType 4001, roomType 7, roomID 1).
  rpc(session, 20403, 3, P.W().s(1, P.W().v(1, 4001).v(3, 7).v(4, 1).v(6, 1).bytes()).bytes());
  const end = Date.now() + 60_000;
  while (!riichiNames(frames).includes('NtfGameStop') || calls === 0) {
    if (Date.now() > end) throw new Error('等待终局超时');
    await wait(10);
  }
  await wait(50);
  assert.equal(calls, 1);

  const finish = rpc(session, 20102, 9, new Uint8Array(0));
  assert.ok(finish[0][24] instanceof Uint8Array, '离桌应答携带数据变更');
  const rank = changedRows(finish[0], 41).map((row) => P.dict(row[2]));
  const yonma = rank.find((row) => row[1] === 17 && row[2] === 1234);
  assert.ok(yonma, '下发四麻段位 PT');
  const coin = changedRows(finish[0], 6).map((row) => P.dict(row[2])).find((row) => row[1] === 60001);
  assert.equal(coin[2], coinsBefore + 100);
  // Sent only once: later leave-table replies do not carry it again.
  assert.equal(rpc(session, 20025, 10, new Uint8Array(0))[0][24], undefined);
});
