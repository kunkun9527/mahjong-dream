import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { encodeMsg, decodeMsg } from '../mockjs/pb.mjs';

test('restored Protobuf source can round-trip encode action messages', () => {
  const bytes = encodeMsg('ReqPlayCard', { card: 115, action: 7, isTimeout: false });
  const decoded = decodeMsg('ReqPlayCard', bytes);
  assert.equal(decoded.card, 115);
  assert.equal(decoded.action, 7);
  assert.equal(decoded.isTimeout, false);
});

test('the generated browser bundle keeps the original global export contract', async () => {
  globalThis.__mj = {};
  await import(`../mock/riichi.js?smoke=${Date.now()}`);
  assert.deepEqual(
    Object.keys(globalThis.__mj.riichi).sort(),
    [
      'GameEngine', 'LiuJuType', 'MSG_NAME', 'ManType', 'PlayAction',
      'RiichiMsg', 'RiichiSession', 'YiType', 'decodeId', 'decodeMsg',
      'encodeMsg', 'tileId', 'tileName',
    ].sort(),
  );
});

test('the browser bundle loads and exports the profile host in an environment without a Node process', () => {
  const source = readFileSync(new URL('../mock/riichi.js', import.meta.url), 'utf8');
  const context = vm.createContext({ console, TextEncoder, TextDecoder, setTimeout, clearTimeout, __mj: {} });
  context.globalThis = context;
  vm.runInContext(source, context);
  assert.equal(typeof context.process, 'undefined');
  assert.equal(typeof context.__mj.host.createProfileHost, 'function');
  assert.equal(typeof context.__mj.riichi.RiichiSession, 'function');
});
