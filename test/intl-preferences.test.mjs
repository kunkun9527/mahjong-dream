import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('      function useEnglishPlayerPrefs()'), html.indexOf('      function receiveOrientationFromUnity'));
const header = () => Uint8Array.from(Buffer.from('556e6974795072660000010000000000', 'hex'));
const hash = (value) => createHash('md5').update(value).digest('hex');
const href = 'http://127.0.0.1:8767/game.html?mjLang=en&uid=1#ignored';
const directory = '/idbfs/' + hash('http://127.0.0.1:8767');
const prefsPath = directory + '/PlayerPrefs';

function createContext(indexedDB = {}) {
  return vm.createContext({ Uint8Array, DataView, Date, Promise, indexedDB, location: { href }, SparkMD5: { hash } });
}
const context = createContext();
vm.runInContext(source, context);
const setInt = context.setPrefsInt;

function intOf(bytes, key) {
  const at = Buffer.from(bytes).indexOf(Buffer.from([key.length, ...Buffer.from(key), 0xfe]));
  assert.ok(at >= 16, `${key} 应存在`);
  return new DataView(bytes.buffer, bytes.byteOffset).getInt32(at + key.length + 2, true);
}

function fakeIDB(initial = [], { upgrade = false, fail = false, abort = false } = {}) {
  const records = new Map(initial.map(([key, value]) => [key, structuredClone(value)]));
  const writes = [];
  let closed = false, opened;
  const db = {
    objectStoreNames: { contains: () => !upgrade },
    createObjectStore(name) { assert.equal(name, 'FILE_DATA'); return store; },
    transaction(name, mode) {
      assert.equal(name, 'FILE_DATA');
      assert.equal(mode, 'readwrite');
      return tx;
    },
    close() { closed = true; },
  };
  let pending = 0;
  const tx = { objectStore: () => store };
  function request(result, action) {
    const req = {};
    pending++;
    queueMicrotask(() => {
      req.result = structuredClone(result);
      action?.();
      req.onsuccess?.();
      if (--pending === 0) queueMicrotask(() => {
        if (pending === 0) (abort ? tx.onabort : tx.oncomplete)?.();
      });
    });
    return req;
  }
  const store = {
    indexNames: { contains: () => !upgrade },
    createIndex(name, key, options) {
      assert.equal(name, 'timestamp');
      assert.equal(key, 'timestamp');
      assert.equal(options.unique, false);
    },
    get(key) { return request(records.get(key)); },
    put(value, key) {
      const copy = structuredClone(value);
      return request(undefined, () => { if (!abort) records.set(key, copy); writes.push(key); });
    },
  };
  const indexedDB = { open(name, version) {
    opened = [name, version];
    const req = { result: db, transaction: tx };
    queueMicrotask(() => {
      if (fail) return req.onerror();
      if (upgrade) req.onupgradeneeded();
      req.onsuccess();
    });
    return req;
  } };
  return { indexedDB, records, writes, get closed() { return closed; }, get opened() { return opened; } };
}

async function boot(fake) {
  const ctx = createContext(fake.indexedDB);
  vm.runInContext(source, ctx);
  await ctx.useEnglishPlayerPrefs();
}

test('国际版偏好补丁仅改语言与条款整数，保留其他字节且不修改输入', () => {
  let before = setInt(header(), 'Volume', 37);
  before = setInt(setInt(before, 'LanguageID', 6), 'user_terms', 0);
  const copy = before.slice();
  const after = setInt(setInt(before, 'LanguageID', 4), 'user_terms', 1);
  assert.equal(intOf(after, 'LanguageID'), 4);
  assert.equal(intOf(after, 'user_terms'), 1);
  assert.equal(intOf(after, 'Volume'), 37);
  assert.equal(new DataView(after.buffer).getUint32(12, true), 3);
  assert.equal(after.length, before.length);
  assert.deepEqual(before, copy);
  assert.strictEqual(setInt(after, 'user_terms', 1), after);
});

test('首次国际版启动创建正确 IDBFS 目录与偏好，条款默认同意，二次启动不重复写入', async () => {
  const fake = fakeIDB([], { upgrade: true });
  await boot(fake);
  assert.deepEqual(fake.opened, ['/idbfs', 21]);
  assert.equal(fake.closed, true);
  assert.equal(fake.records.get(directory).mode, 16895);
  const file = fake.records.get(prefsPath);
  assert.equal(file.mode, 33206);
  assert.ok(file.timestamp instanceof Date);
  assert.equal(intOf(file.contents, 'LanguageID'), 4);
  assert.equal(intOf(file.contents, 'user_terms'), 1);
  assert.equal(new DataView(file.contents.buffer).getUint32(12, true), 2);
  const second = fakeIDB([...fake.records]);
  await boot(second);
  assert.deepEqual(second.writes, []);
});

test('已有国际版偏好补充条款且保留目录、音量、未知文件及其他站点路径', async () => {
  const otherPath = '/idbfs/other/PlayerPrefs';
  const old = setInt(setInt(header(), 'Volume', 91), 'LanguageID', 6);
  const parent = { timestamp: new Date(0), mode: 16877 };
  const unrelated = { mode: 33206, contents: setInt(header(), 'LanguageID', 6) };
  const fake = fakeIDB([[directory, parent], [prefsPath, { mode: 33188, contents: old }], [otherPath, unrelated]]);
  await boot(fake);
  const file = fake.records.get(prefsPath);
  assert.equal(intOf(file.contents, 'Volume'), 91);
  assert.equal(intOf(file.contents, 'LanguageID'), 4);
  assert.equal(intOf(file.contents, 'user_terms'), 1);
  assert.equal(file.mode, 33188);
  assert.deepEqual(fake.records.get(directory), parent);
  assert.deepEqual(fake.records.get(otherPath), unrelated);
  assert.deepEqual(fake.writes, [prefsPath]);
});

test('损坏偏好不被重写，IndexedDB 不可用或事务中止时仍能结束启动准备', async () => {
  const invalid = Uint8Array.from([1, 2, 3]);
  assert.strictEqual(setInt(invalid, 'user_terms', 1), invalid);
  const fake = fakeIDB([[prefsPath, { contents: invalid, mode: 33188 }]]);
  await boot(fake);
  assert.deepEqual(fake.writes, []);
  await boot(fakeIDB([], { fail: true }));
  const aborted = fakeIDB([], { abort: true });
  await boot(aborted);
  assert.equal(aborted.closed, true);
  assert.equal(aborted.records.size, 0);
});
