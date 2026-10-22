// 改名：原客户端回调要求 100008 应答 { 1:结果码, 2:原请求 }，否则改名窗口不关、昵称不刷新
//（浏览器验收发现）；改名消耗 1 张改名卡；问候语不支持离线修改，也不能误改昵称。
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

test('改名应答回显原请求、刷新 DT1 并消耗一张改名卡', (t) => {
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
  assert.deepEqual(Buffer.from(body[2]), Buffer.from(request), '回显原请求供客户端按字段类型派发');
  assert.deepEqual(changedDtypes(frame).sort((a, b) => a - b), [1, 6]);
  assert.equal(mock.userdata.inventoryCount(6, RENAME_CARD), cards - 1);
  assert.equal(saved, '测试雀士');
});

test('空白昵称被拒绝且不扣卡；问候语离线不可用且不改昵称', (t) => {
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
