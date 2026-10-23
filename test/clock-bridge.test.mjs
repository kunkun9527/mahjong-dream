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
  const manifest = { v: 2, sourceHash, wasmHash: hash(bytes), codeFile: 'mj-h5.clock-' + hash(bytes).slice(0, 16) + '.wasm.unityweb' };
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
    hide() { context.document.hidden = true; listeners.get('visibilitychange')(); },
    instantiate,
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('Node毫秒投影只扣活动时间；冻结、重连和新窗口不重赠基础段或备用', () => {
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
  advance(60000);
  assert.equal(bridge.current().extraMs, 16000);
  bridge.freeze();
  advance(60000);
  assert.equal(bridge.current().extraMs, 16000);
  bridge.accept(null);
  assert.equal(bridge.current(), null);
  bridge.accept({ id: 2, baseMs: 3000, extraMs: 0, running: false });
  advance(60000);
  assert.equal(bridge.current().baseMs, 3000);
});

test('静态宿主直接读取当前引擎；WASM三次读取使用同一毫秒样本，不把宽限计入倒计时', async () => {
  const app = page('browser');
  app.engine({ id: 7, baseMs: 2999, extraMs: 18001, running: false });
  const result = await app.load();
  assert.equal(result.ok, true);
  assert.equal(app.context.WebAssembly.instantiate, app.instantiate, '不覆写全局WebAssembly');
  const clock = result.imports.mj.clock;
  assert.equal(clock(0), 1);
  app.engine({ id: 8, baseMs: 5000, extraMs: 0, running: true });
  assert.equal(clock(1), 3);
  assert.equal(clock(2), 21, '总剩余向上取整一次，不能分段取整再相加');
  assert.equal(clock(0), 1);
  assert.equal(clock(1), 5);
  assert.equal(clock(2), 5);
  app.engine(null);
  assert.equal(clock(0), 0);
  assert.equal(app.bridge.status().ready, true);
});

test('拒绝未知构建、损坏派生文件和无效时钟投影，不静默降级原客户端', async () => {
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

test('交付派生文件匹配清单和固定原件哈希；仅增加时钟和同步导入，不带原型测试导出', async () => {
  const root = new URL('../Build_intl/', import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL('mj-h5.clock.json', root), 'utf8'));
  const original = await fs.readFile(new URL('mj-h5.wasm.unityweb', root));
  const compressed = await fs.readFile(new URL(manifest.codeFile, root));
  const derived = brotliDecompressSync(compressed);
  assert.equal(hash(original), sourceHash);
  assert.equal(manifest.sourceHash, sourceHash);
  assert.equal(hash(compressed), manifest.compressedHash);
  assert.equal(hash(derived), manifest.wasmHash);
  const module = new WebAssembly.Module(derived);
  const originalModule = new WebAssembly.Module(brotliDecompressSync(original));
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: 'mj', name: 'clock', kind: 'function' }, { module: 'mj', name: 'sync', kind: 'function' },
    ...WebAssembly.Module.imports(originalModule),
  ]);
  assert.deepEqual(WebAssembly.Module.exports(module), WebAssembly.Module.exports(originalModule));
});

test('重放投递结束不代表Unity已消费：最后一帧、渲染队列和绘制机会全部完成才确认', async () => {
  const app = page();
  const { imports } = await app.load();
  const sent = [], ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) };
  app.bridge.connect(ws);
  app.bridge.synchronize({ phase: 'start', id: 'batch', reload: false }, ws);
  app.bridge.synchronize({ phase: 'end', id: 'batch', counter: 42 }, ws);
  imports.mj.sync(2, 1);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, '仅服务器投递完成不能解冻');
  imports.mj.sync(1, 41);
  imports.mj.sync(2, 1);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, '必须消费指定的末帧，不是任意较早一帧');
  imports.mj.sync(1, 42);
  imports.mj.sync(2, 0);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, '原客户端仍在处理渲染时继续冻结');
  imports.mj.sync(2, 1);
  app.paint();
  assert.equal(sent.length, 0);
  app.paint();
  assert.deepEqual(sent, [{ mjSyncAck: { id: 'batch', counter: 42 } }]);
  imports.mj.sync(2, 1);
  app.paint(); app.paint();
  assert.equal(sent.length, 1, '同一批次只确认一次');
});

test('快照必须等待原Unity退出Reload状态；后台和旧连接不能提交恢复确认', async () => {
  const app = page();
  const { imports } = await app.load();
  const sent = [], ws = { readyState: 1, send: (value) => sent.push(value) };
  app.bridge.connect(ws);
  app.bridge.synchronize({ phase: 'start', id: 'snapshot', reload: true }, ws);
  app.bridge.synchronize({ phase: 'end', id: 'snapshot', counter: 7 }, ws);
  imports.mj.sync(1, 7);
  imports.mj.sync(2, 1);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, '没有Reload完成信号时不得凭空闲队列确认');
  imports.mj.sync(5, 0);
  imports.mj.sync(3, 77);
  imports.mj.sync(6, 0);
  imports.mj.sync(4, 78);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, '无关状态机退出不能确认本次恢复');
  imports.mj.sync(4, 77);
  app.hide(); app.paint(); app.paint();
  assert.equal(sent.length, 0, '隐藏时即使恢复任务完成也不确认');
  app.context.document.hidden = false;
  imports.mj.sync(2, 1);
  app.bridge.disconnect(ws);
  app.paint(); app.paint();
  assert.equal(sent.length, 0, '旧连接的绘制回调不能解冻新连接');
  const next = { readyState: 1, send: (value) => sent.push(value) };
  app.bridge.connect(next);
  app.bridge.synchronize({ phase: 'start', id: 'stale', reload: false }, ws);
  assert.equal(app.bridge.status().recovery, null);
});
