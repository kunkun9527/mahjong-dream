import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
const clockManifest = JSON.parse(readFileSync(new URL('../Build_intl/mj-h5.clock.json', import.meta.url), 'utf8'));
const source = html.slice(html.indexOf('      function preparePlayerPrefs()'), html.indexOf('      function receiveOrientationFromUnity'));
// Unity InitializeIfNeeded/Sync store a 1 MiB capacity at offset 12, not an entry count.
const header = () => Uint8Array.from(Buffer.from('556e6974795072660000010000001000', 'hex'));
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
  assert.ok(at >= 16, `${key} should exist`);
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
  await ctx.preparePlayerPrefs();
}

test('the international preferences patch changes only the language and terms integers, keeps other bytes, and does not modify the input', () => {
  let before = setInt(header(), 'Volume', 37);
  before = setInt(setInt(before, 'LanguageID', 6), 'user_terms', 0);
  const copy = before.slice();
  const after = setInt(setInt(before, 'LanguageID', 4), 'user_terms', 1);
  assert.equal(intOf(after, 'LanguageID'), 4);
  assert.equal(intOf(after, 'user_terms'), 1);
  assert.equal(intOf(after, 'Volume'), 37);
  assert.equal(new DataView(after.buffer).getUint32(12, true), 1_048_576);
  assert.equal(after.length, before.length);
  assert.deepEqual(before, copy);
  assert.strictEqual(setInt(after, 'user_terms', 1), after);
});

test('the first international launch creates the correct IDBFS directory and preferences, accepts the terms by default, and a second launch does not write again', async () => {
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
  assert.equal(new DataView(file.contents.buffer).getUint32(12, true), 1_048_576);
  const second = fakeIDB([...fake.records]);
  await boot(second);
  assert.deepEqual(second.writes, []);
});

test('existing international preferences gain the terms and keep the directory, volume, unknown files, and other site paths', async () => {
  const otherPath = '/idbfs/other/PlayerPrefs';
  const old = setInt(setInt(header(), 'Volume', 91), 'LanguageID', 6);
  const parent = { timestamp: new Date(0), mode: 16877 };
  const unrelated = { mode: 33206, contents: setInt(header(), 'LanguageID', 6) };
  const fake = fakeIDB([[directory, parent], [prefsPath, { mode: 33188, contents: old }], [otherPath, unrelated]]);
  await boot(fake);
  const file = fake.records.get(prefsPath);
  assert.equal(intOf(file.contents, 'Volume'), 91);
  assert.equal(intOf(file.contents, 'LanguageID'), 6);
  assert.equal(intOf(file.contents, 'user_terms'), 1);
  assert.equal(file.mode, 33188);
  assert.deepEqual(fake.records.get(directory), parent);
  assert.deepEqual(fake.records.get(otherPath), unrelated);
  assert.deepEqual(fake.writes, [prefsPath]);
});

test('repeated international launches keep all built-in language choices instead of overwriting them with the English default', async () => {
  for (const language of [1, 2, 3, 4, 5, 6]) {
    const contents = setInt(setInt(header(), 'LanguageID', language), 'user_terms', 1);
    const fake = fakeIDB([[prefsPath, { contents, mode: 33206 }]]);
    await boot(fake);
    assert.equal(intOf(fake.records.get(prefsPath).contents, 'LanguageID'), language);
    assert.deepEqual(fake.writes, []);
  }
});

test('fixes the two-byte quota mis-written by the previous version, and the fix must not be skipped even when the terms are already accepted', async () => {
  const old = setInt(setInt(header(), 'LanguageID', 4), 'user_terms', 1);
  new DataView(old.buffer).setUint32(12, 2, true);
  const before = old.slice();
  const fake = fakeIDB([[directory, { mode: 16895 }], [prefsPath, { mode: 33206, contents: old }]]);
  await boot(fake);
  const repaired = fake.records.get(prefsPath).contents;
  assert.equal(new DataView(repaired.buffer).getUint32(12, true), 1_048_576);
  assert.equal(intOf(repaired, 'LanguageID'), 4);
  assert.equal(intOf(repaired, 'user_terms'), 1);
  assert.deepEqual(repaired.subarray(16), before.subarray(16));
  assert.deepEqual(old, before);
  assert.deepEqual(fake.writes, [prefsPath]);
});

test('the full launch chain loads the international build even without a query string, commits preferences before starting Unity, and keeps the query string and hash', async () => {
  const bootstrap = html.slice(html.indexOf('      var container ='), html.indexOf('      function receiveOrientationFromUnity'));
  for (const suffix of ['', '#anchor', '?uid=7&mjPlayers=3#anchor', '?sign=custom', '?mjLang=zh']) {
    const fake = fakeIDB([], { upgrade: true });
    const ctx = createContext(fake.indexedDB);
    ctx.location = new URL('http://127.0.0.1:8767/game.html' + suffix);
    let unityConfig, loader, clockReady = false;
    Object.assign(ctx, {
      URL, URLSearchParams, Uint8Array, performance: { now: () => 1 },
      navigator: { userAgent: 'Desktop' }, console: { log() {}, time() {}, timeLog() {} },
      setInterval: () => 1, clearInterval() {},
      fetch: () => Promise.resolve({ ok: true }),
      __mjHost: { ready: Promise.resolve() },
      __mjClock: { async configure(config) {
        assert.equal(fake.closed, true, 'the clock config must also not be committed before the preferences');
        await Promise.resolve();
        config.codeUrl = 'Build_intl/' + clockManifest.codeFile;
        config.instantiateWasm = () => {};
        clockReady = true;
      } },
      history: { replaceState(_state, _title, url) { ctx.location = new URL(url, ctx.location); } },
      document: {
        hidden: false, addEventListener() {},
        querySelector: () => ({ style: {} }), createElement: () => ({}),
        body: { appendChild(script) {
          assert.equal(fake.closed, true, 'Unity must wait for the preference transaction');
          loader = script.src;
          script.onload();
        } },
      },
      createUnityInstance(_canvas, config) {
        assert.equal(clockReady, true, 'Unity must wait for the derived client and clock-bridge config to finish');
        assert.equal(typeof config.instantiateWasm, 'function');
        const contents = fake.records.get(prefsPath).contents;
        assert.equal(intOf(contents, 'user_terms'), 1);
        assert.equal(new DataView(contents.buffer).getUint32(12, true), 1_048_576);
        unityConfig = config;
        return Promise.resolve({});
      },
    });
    vm.runInContext(bootstrap, ctx);
    await new Promise(setImmediate);
    assert.equal(loader, 'Build_intl/mj-h5.loader.js');
    assert.equal(unityConfig.codeUrl, 'Build_intl/' + clockManifest.codeFile);
    assert.equal(unityConfig.productName, 'Mahjong Dream');
    assert.equal(ctx.location.searchParams.get('uid'), suffix.includes('uid=7') ? '7' : '1');
    assert.equal(ctx.location.searchParams.get('sign'), suffix.includes('sign=custom') ? 'custom' : '19a5aaae0d826f5ac640a4dbfafb1612');
    if (suffix.includes('anchor')) assert.equal(ctx.location.hash, '#anchor');
    if (suffix.includes('mjPlayers')) assert.equal(ctx.location.searchParams.get('mjPlayers'), '3');
  }
});

test('corrupt preferences are not rewritten, and launch preparation still finishes when IndexedDB is unavailable or the transaction aborts', async () => {
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
