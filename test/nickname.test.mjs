// Rename: the original client's callback requires a 100008 reply { 1:result code, 2:original request }, otherwise the rename window does not close and the nickname does not refresh
// (found in browser acceptance); a rename consumes 1 rename card; greetings cannot be modified offline, and the nickname must not be changed by mistake.
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
const RENAME_CARD = 60007;

function rpc(session, mid, seq, payload) {
  return mock.dispatch(session, P.W().v(2, mid).v(11, seq).s(3, payload).bytes()).map((bytes) => P.dict(bytes));
}

function modifyRequest(type, text) {
  return P.W().v(1, type).s(2, P.W().s(1, P.utf8(text)).bytes()).bytes();
}

function changedDtypes(frame) {
  if (!(frame[24] instanceof Uint8Array)) return [];
  const change = P.get(frame[24], 1);
  return P.parse(change).filter(([field]) => field === 2).map(([, , bytes]) => P.dict(bytes)[1]);
}

test('the rename reply echoes the original request, refreshes DT1 and consumes one rename card', (t) => {
  const session = mock.createSession();
  t.after(() => session.destroy());
  mock.userdata.changeInventory([{ dtype: 6, id: RENAME_CARD, count: 1 }]);
  const cards = mock.userdata.inventoryCount(6, RENAME_CARD);
  let saved = null;
  session.onNicknameChange = (name) => { saved = name; };

  const request = modifyRequest(1, '  测试雀士 ');
  const [frame] = rpc(session, 100007, 5, request);
  assert.equal(frame[2], 100008);
  const body = P.dict(frame[3]);
  assert.equal(body[1] || 0, 0);
  assert.deepEqual(Buffer.from(body[2]), Buffer.from(request), 'echo the original request so the client can dispatch by field type');
  assert.deepEqual(changedDtypes(frame).sort((a, b) => a - b), [1, 6]);
  assert.equal(mock.userdata.inventoryCount(6, RENAME_CARD), cards - 1);
  assert.equal(saved, '测试雀士');
});

test('a blank nickname is rejected without deducting a card; a greeting is unavailable offline and does not change the nickname', (t) => {
  const session = mock.createSession();
  const pushed = [];
  session.resume({ readyState: 1, _deliver(bytes) { pushed.push(P.dict(bytes)); } });
  t.after(() => session.destroy());
  mock.userdata.changeInventory([{ dtype: 6, id: RENAME_CARD, count: 1 }]);
  const cards = mock.userdata.inventoryCount(6, RENAME_CARD);
  let renamed = false;
  session.onNicknameChange = () => { renamed = true; };

  const [blank] = rpc(session, 100007, 6, modifyRequest(1, '   '));
  assert.equal(P.dict(blank[3])[1], 2);
  assert.equal(blank[24], undefined);

  const [greeting] = rpc(session, 100007, 7, modifyRequest(2, '你好'));
  assert.equal(greeting[2], 100008);
  assert.equal(P.dict(greeting[3])[1], 10);
  assert.equal(renamed, false);
  assert.equal(mock.userdata.inventoryCount(6, RENAME_CARD), cards);
});
