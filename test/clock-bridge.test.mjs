import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';

const source = await fs.readFile(new URL('../clock-bridge.js', import.meta.url), 'utf8');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHash = '730effb3ff74fb93975c29e48249f29c43d32b9c65d55805a03f765de260cab9';
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
function page(mode = 'node') {
  let now = 0, engineState = null, imports;
  const listeners = new Map(), paints = [];
  const manifest = { v: 3, sourceHash, wasmHash: hash(bytes), codeFile: 'mj-h5.clock-' + hash(bytes).slice(0, 16) + '.wasm.unityweb' };
  const instantiate = async (_bytes, received) => { imports = received; return { instance: { exports: {} }, module: {} }; };
  const context = vm.createContext({
    console: { log() {}, error() {} }, performance: { now: () => now }, crypto: webcrypto,
    requestAnimationFrame: (callback) => paints.push(callback),
    WebAssembly: { instantiate }, Uint8Array, Number,
    __mjHostMode: mode, __mjHost: { humanClock: () => engineState },
    document: { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn) },
    fetch: async () => ({ ok: true, json: async () => manifest }),
  });
  context.window = context;
  vm.runInContext(source, context, { filename: 'clock-bridge.js' });
  return { bridge: context.__mjClock, context, manifest,
    advance: (ms) => { now += ms; }, engine: (state) => { engineState = state; },
    paint() { const callbacks = paints.splice(0); for (const callback of callbacks) callback(); },
    async load(binary = bytes) {
      const config = {};
      await context.__mjClock.configure(config);
      const result = await new Promise((resolve) => config.instantiateWasm.call({ wasmBinary: binary,
        abortHandler: (message) => resolve({ error: message }) }, {}, () => resolve({ ok: true })));
      return { ...result, imports, config };
    },
    hide() { context.document.hidden = true; listeners.get('visibilitychange')?.(); },
    instantiate,
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('Node millisecond projection keeps counting in the background; only a real disconnect or sync freezes it', () => {
  const { bridge, advance, hide } = page();
  bridge.accept({ id: 1, baseMs: 5000, extraMs: 20000, running: true });
  advance(7000);
  assert.deepEqual(plain(bridge.current()), { id: 1, baseMs: 0, extraMs: 18000, running: true });
  bridge.accept({ id: 1, baseMs: 0, extraMs: 18000, running: false });
  advance(60000);
  assert.equal(bridge.current().extraMs, 18000);
  bridge.accept({ id: 1, baseMs: 0, extraMs: 18000, running: true });
  advance(2000);
  hide();
  advance(3000);
  assert.equal(bridge.current().extraMs, 13000);
  assert.equal(bridge.current().running, true);
  bridge.freeze();
  advance(60000);
  assert.equal(bridge.current().extraMs, 13000);
  bridge.accept(null);
  assert.equal(bridge.current(), null);
  bridge.accept({ id: 2, baseMs: 3000, extraMs: 0, running: false });
  advance(60000);
  assert.equal(bridge.current().baseMs, 3000);
});

test('the static host reads the current engine directly; three WASM reads use the same millisecond sample, and the grace period is not counted in the countdown', async () => {
  const app = page('browser');
  app.engine({ id: 7, baseMs: 2999, extraMs: 18001, running: false });
  const result = await app.load();
  assert.equal(result.ok, true);
  assert.equal(app.context.WebAssembly.instantiate, app.instantiate, 'does not overwrite the global WebAssembly');
  const clock = result.imports.mj.clock;
  assert.equal(clock(0), 1);
  app.engine({ id: 8, baseMs: 5000, extraMs: 0, running: true });
  assert.equal(clock(1), 3);
  assert.equal(clock(2), 22, 'base and bank are each rounded up, and +N stays unchanged in the base phase');
  assert.equal(clock(0), 1);
  assert.equal(clock(1), 5, 'with no bank, still in the base phase, shown by the native white temporary countdown');
  assert.equal(clock(2), 5);
  app.engine(null);
  assert.equal(clock(0), 0);
  assert.equal(app.bridge.status().ready, true);
});

for (const mode of ['node', 'browser']) {
  test(`${mode} dealer first hand 8+20, later hands 5+remaining; when the bank is exhausted, base and total deadlines are the same and +0 is not shown`, async () => {
    const app = page(mode);
    const { imports } = await app.load();
    const publish = (state) => mode === 'browser' ? app.engine(state) : app.bridge.accept(state);
    for (const [id, baseMs, extraMs, base, total] of [
      [1, 8000, 20000, 8, 28], [2, 5000, 18000, 5, 23],
      [3, 5000, 0, 5, 5], [3, 2999, 0, 3, 3],
      [4, 3500, 800, 4, 5], [4, 3100, 800, 4, 5], [4, 0, 800, 0, 1],
    ]) {
      publish({ id, baseMs, extraMs, running: true });
      assert.equal(imports.mj.clock(0), 1);
      assert.equal(imports.mj.clock(1), base);
      assert.equal(imports.mj.clock(2), total);
      assert.equal(app.bridge.current().baseMs, baseMs, 'the display branch must not change the real base time');
    }
  });
}

for (const mode of ['node', 'browser']) {
  test(mode + ' only confirms actionable after the native countdown is truly enabled and drawn; duplicate, disconnect and stale-window callbacks are invalid', async () => {
    const app = page(mode);
    const { imports } = await app.load();
    const sent = [], ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) };
    app.bridge.connect(ws);
    const publish = state => mode === 'node' ? app.bridge.accept(state) : app.engine(state);
    publish({ id: 1, baseMs: 8000, extraMs: 20000, running: false });
    imports.mj.clock(0); app.paint(); app.paint();
    assert.equal(sent.length, 0, 'merely reading the projection every frame is not a hand-ready signal');
    imports.mj.sync(7, 1234);
    app.paint(); app.paint();
    assert.equal(sent.length, 0, 'the countdown cannot start while the hand presentation queue is incomplete');
    imports.mj.sync(2, 1);
    app.paint(); assert.equal(sent.length, 0);
    app.paint(); assert.deepEqual(sent, [{ mjClockReady: 1 }]);
    imports.mj.sync(7, 1234); app.paint(); app.paint();
    assert.equal(sent.length, 1);
    publish({ id: 2, baseMs: 5000, extraMs: 0, running: false });
    imports.mj.sync(7, 1234);
    publish({ id: 3, baseMs: 5000, extraMs: 0, running: false });
    app.paint(); app.paint();
    assert.equal(sent.length, 1, 'a draw task from an old window must not confirm the new window');
    imports.mj.sync(7, 1234);
    app.bridge.disconnect(ws); app.paint(); app.paint();
    assert.equal(sent.length, 1, 'a draw task from an old connection is invalid');
  });
}

for (const mode of ['node', 'browser']) {
  test(mode + ' new windows in the background do not wait for frozen animation frames; switching to background does not stall windows whose countdown has not started', async () => {
    const app = page(mode); await app.load();
    const sent = [], ws = { readyState: 1, send: value => sent.push(JSON.parse(value)) };
    app.bridge.connect(ws);
    const publish = state => { if (mode === 'browser') app.engine(state); app.bridge.accept(state); };
    publish({ id: 1, baseMs: 8000, extraMs: 20000, running: false });
    assert.equal(sent.length, 0);
    app.hide();
    assert.deepEqual(sent, [{ mjClockReady: 1 }], 'background does not wait for native drawing or rAF');
    publish({ id: 2, baseMs: 5000, extraMs: 17000, running: false });
    assert.deepEqual(sent.at(-1), { mjClockReady: 2 });
    publish({ id: 2, baseMs: 5000, extraMs: 17000, running: false });
    assert.equal(sent.length, 2, 'duplicate projection is confirmed only once');
    app.bridge.disconnect(ws);
    publish({ id: 3, baseMs: 5000, extraMs: 17000, running: false });
    assert.equal(sent.length, 2, 'a real disconnect still freezes');
  });
}

test('when the bank is under 1 second, +1 stays stable every frame in the base phase and does not flicker between +1 and no +', async () => {
  const app = page(); const { imports } = await app.load();
  app.bridge.accept({ id: 1, baseMs: 5000, extraMs: 600, running: true });
  for (let ms = 0; ms < 5000; ms += 50) {
    imports.mj.clock(0);
    const base = imports.mj.clock(1), total = imports.mj.clock(2);
    assert.equal(base, Math.ceil((5000 - ms) / 1000));
    assert.equal(total - base, 1, `with ${5000 - ms}ms of base left, +N must stay at 1`);
    app.advance(50);
  }
  imports.mj.clock(0);
  assert.deepEqual([imports.mj.clock(1), imports.mj.clock(2)], [0, 1], 'only 1 second of bank remains after the base is used up');
});

test('after the bank is exhausted, the 5 seconds are still the base phase: no +0 is shown and the real base time is not deducted', async () => {
  const app = page(); const { imports } = await app.load();
  app.bridge.accept({ id: 1, baseMs: 5000, extraMs: 0, running: true });
  assert.equal(imports.mj.clock(0), 1);
  assert.equal(imports.mj.clock(1), 5);
  assert.equal(imports.mj.clock(2), 5, 'total deadline equals base deadline, so native shows no +0');
  assert.equal(app.bridge.current().baseMs, 5000);
});

test('rejects unknown builds, corrupted derived files and invalid clock projections without silently downgrading the original client', async () => {
  const app = page();
  app.manifest.sourceHash = '0'.repeat(64);
  await assert.rejects(app.bridge.configure({}), /Unsupported Unity clock build/);
  app.manifest.sourceHash = sourceHash;
  const result = await app.load(new Uint8Array([0]));
  assert.match(result.error, /hash mismatch/);
  assert.equal(app.bridge.status().ready, false);
  for (const state of [{}, { id: 1, baseMs: -1, extraMs: 20, running: true },
    { id: 1, baseMs: 5, extraMs: NaN, running: true }]) {
    assert.throws(() => app.bridge.accept(state), /Invalid host clock projection/);
  }
  assert.equal(app.bridge.current(), null);
});

test('derived files match the manifest and pinned original hash; only clock and sync imports are added, and no prototype test exports are included', async () => {
  const root = new URL('../Build_intl/', import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL('mj-h5.clock.json', root), 'utf8'));
  const original = await fs.readFile(new URL('mj-h5.wasm.unityweb', root));
  const compressed = await fs.readFile(new URL(manifest.codeFile, root));
  const derived = brotliDecompressSync(compressed);
  assert.equal(hash(original), sourceHash);
  assert.equal(manifest.sourceHash, sourceHash);
  assert.equal(hash(compressed), manifest.compressedHash);
  assert.equal(hash(derived), manifest.wasmHash);
  // Fixed-build OnTimer: active -> UpdateTimeText -> one-second block, not inside it.
  // f14666 shifts to index 14668 after the two mj imports (call = 10 cc 72).
  assert.ok(derived.includes(Buffer.from([
    0x20, 0x00, 0x2d, 0x00, 0xf8, 0x02, 0x04, 0x40,
    0x20, 0x00, 0x20, 0x00, 0x10, 0xcc, 0x72, 0x0b, 0x02, 0x40,
  ])), 'the native countdown must read the authoritative remainder every frame and not wait for the one-second tick to refresh');
  // UpdateTimeText colour: activeSelf(+N) OR base-phase-without-bank (local 9) -> white palette.
  // GameObject.get_activeSelf f987 shifts to 989 (call = 10 dd 07); $l2 is local 2.
  assert.ok(derived.includes(Buffer.from([0x10, 0xdd, 0x07, 0x20, 0x09, 0x72, 0x21, 0x02])),
    'the base phase after the bank is exhausted must use the white temporary countdown style');
  const module = new WebAssembly.Module(derived);
  const originalModule = new WebAssembly.Module(brotliDecompressSync(original));
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: 'mj', name: 'clock', kind: 'function' }, { module: 'mj', name: 'sync', kind: 'function' },
    ...WebAssembly.Module.imports(originalModule),
  ]);
  assert.deepEqual(WebAssembly.Module.exports(module), WebAssembly.Module.exports(originalModule));
});

test('end of replay delivery does not mean Unity has consumed it: confirm only after the last frame, render queue and draw opportunity have all completed', async () => {
  const app = page();
  const { imports } = await app.load();
  const sent = [], ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) };
  app.bridge.connect(ws);
  app.bridge.synchronize({ phase: 'start', id: 'batch', reload: false }, ws);
  app.bridge.synchronize({ phase: 'end', id: 'batch', counter: 42 }, ws);
  imports.mj.sync(2, 1);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, 'server delivery completion alone cannot unfreeze');
  imports.mj.sync(1, 41);
  imports.mj.sync(2, 1);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, 'must consume the specified last frame, not any earlier frame');
  imports.mj.sync(1, 42);
  imports.mj.sync(2, 0);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, 'stays frozen while the original client is still processing rendering');
  imports.mj.sync(2, 1);
  app.paint();
  assert.equal(sent.length, 0);
  app.paint();
  assert.deepEqual(sent, [{ mjSyncAck: { id: 'batch', counter: 42 } }]);
  imports.mj.sync(2, 1);
  app.paint(); app.paint();
  assert.equal(sent.length, 1, 'the same batch is confirmed only once');
});

test('recovery must wait for the real hand countdown to be enabled; consumption and idleness alone cannot confirm it while the client is still in the lobby', async () => {
  const app = page(); const { imports } = await app.load();
  const sent = [], ws = { readyState: 1, send: value => sent.push(JSON.parse(value)) };
  app.bridge.connect(ws);
  app.bridge.accept({ id: 1, baseMs: 8000, extraMs: 20000, running: false });
  app.bridge.synchronize({ phase: 'start', id: 'cold', reload: false }, ws);
  app.bridge.synchronize({ phase: 'end', id: 'cold', counter: 42 }, ws);
  imports.mj.sync(1, 42); imports.mj.sync(2, 1);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, 'packet consumption and idleness in the lobby do not mean table recovery is complete');
  imports.mj.sync(7, 1234); app.paint(); app.paint();
  assert.deepEqual(sent, [{ mjSyncAck: { id: 'cold', counter: 42 } }]);
  app.bridge.synchronize({ phase: 'complete', id: 'cold' }, ws);
  app.paint(); app.paint();
  assert.deepEqual(sent.at(-1), { mjClockReady: 1 });
});

test('the snapshot must wait for the original Unity to exit the Reload state; background and stale connections cannot submit recovery confirmation', async () => {
  const app = page();
  const { imports } = await app.load();
  const sent = [], ws = { readyState: 1, send: (value) => sent.push(value) };
  app.bridge.connect(ws);
  app.bridge.synchronize({ phase: 'start', id: 'snapshot', reload: true }, ws);
  app.bridge.synchronize({ phase: 'end', id: 'snapshot', counter: 7 }, ws);
  imports.mj.sync(1, 7);
  imports.mj.sync(2, 1);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, 'without a Reload-complete signal, the idle queue alone must not confirm');
  imports.mj.sync(5, 0);
  imports.mj.sync(3, 77);
  imports.mj.sync(6, 0);
  imports.mj.sync(4, 78);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, 'an unrelated state machine exit cannot confirm this recovery');
  imports.mj.sync(4, 77);
  app.hide(); app.paint(); app.paint();
  assert.equal(sent.length, 0, 'not confirmed while hidden, even if the recovery task completes');
  app.context.document.hidden = false;
  imports.mj.sync(2, 1);
  app.bridge.disconnect(ws);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, 'a draw callback from an old connection cannot unfreeze the new connection');
  const next = { readyState: 1, send: (value) => sent.push(value) };
  app.bridge.connect(next);
  app.bridge.synchronize({ phase: 'start', id: 'stale', reload: false }, ws);
  assert.equal(app.bridge.status().recovery, null);
});
