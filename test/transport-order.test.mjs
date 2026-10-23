import test from 'node:test';
import assert from 'node:assert/strict';

await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');
const { proto: P, server: mock } = globalThis.__mj;
mock.quiet(true);

function connection(session, received) {
  return {
    readyState: 1,
    _deliver(bytes) { received.push(P.dict(bytes)); },
  };
}

function ping(session, socket, seq) {
  const request = P.W().v(2, 20019).v(11, seq).bytes();
  for (const frame of mock.dispatch(session, request)) socket._deliver(frame);
}

test('when async match notifications interleave with immediate heartbeats, downstream sequence numbers increase in actual send order', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = mock.createSession();
  const received = [];
  session.socket = connection(session, received);
  const payload = mock.encodeKRiichi(1005, new Uint8Array());
  session.push(20018, payload, 1, null, null);
  ping(session, session.socket, 27);
  assert.equal(received.length, 1, 'match pushes must still be async, to avoid synchronous re-entry on the virtual connection');
  t.mock.timers.tick(1);
  assert.deepEqual(received.map((frame) => frame[2]), [20019, 20018]);
  assert.deepEqual(received.map((frame) => frame[27]), [1, 2]);
  assert.equal(received[0][11], 27, 'heartbeat echoes the original request sequence number');
  assert.equal(received[1][11], undefined, 'notifications must not carry an RPC sequence number');
  assert.deepEqual(received[1][3], payload);
});

test('multiple notifications and action replies keep queue order, and heartbeats do not take their downstream sequence numbers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = mock.createSession();
  const received = [];
  session.socket = connection(session, received);
  for (const [event, seq] of [[4, 50], [1005, null], [1004, null]]) {
    session.push(20018, mock.encodeKRiichi(event, new Uint8Array()), 1, null, seq);
  }
  ping(session, session.socket, 51);
  t.mock.timers.tick(1);
  assert.deepEqual(received.map((frame) => frame[27]), [1, 2, 3, 4]);
  assert.deepEqual(received.slice(1).map((frame) => P.dict(frame[3])[1]), [4, 1005, 1004]);
  assert.deepEqual(received.map((frame) => frame[11]), [51, 50, undefined, undefined]);
});

test('old undelivered notifications after a disconnect consume no sequence number and do not leak into the new connection', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = mock.createSession();
  const oldReceived = [], received = [];
  session.socket = connection(session, oldReceived);
  session.push(20018, mock.encodeKRiichi(1005, new Uint8Array()));
  session.suspend();
  session.resume(connection(session, received));
  t.mock.timers.tick(1);
  ping(session, session.socket, 1);
  assert.deepEqual(oldReceived, []);
  assert.deepEqual(received.map((frame) => frame[27]), [1]);
});
