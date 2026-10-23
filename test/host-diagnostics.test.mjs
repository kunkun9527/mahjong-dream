import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../web-host.js', import.meta.url), 'utf8');

function page(t, storage = new Map(), mode = 'node', search = '') {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const listeners = new Map(), requests = [], downloads = [];
  const host = { load: () => false, attach() {}, recoverMatch: async () => {}, snapshot: () => ({}) };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date, Promise, JSON, Error, Blob, URLSearchParams, setTimeout, clearTimeout,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    localStorage: { getItem: () => null },
    location: { search }, navigator: {}, alert() {},
    document: {
      createElement: () => ({ click() { downloads.push(this.download); } }),
      head: { appendChild: (script) => script.onload() }
    },
    __mjHostMode: mode,
    __mj: { server: { quiet() {}, FakeWebSocket: function () {} },
      host: { normalizeProfile: (saved) => saved, createProfileHost: () => host } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, text: async () => context.serverDiagnosticText || '[clock] server-fixture\n' };
    },
    addEventListener: (name, callback) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
  });
  context.window = context;
  context.__mj.server.FakeWebSocket.prototype.send = () => {};
  vm.runInContext(source, context, { filename: 'web-host.js' });
  return { context, requests, downloads, storage,
    emit: (name, event) => listeners.get(name)?.forEach((callback) => callback(event)) };
}

test('前端异常进入本地日志批次；导出包含服务端及页面日志，不展开任意对象', async (t) => {
  const { context, emit, requests, downloads, storage } = page(t);
  await context.__mjHost.ready;
  emit('error', { message: 'clock-fixture', filename: 'game.js', lineno: 17, error: new Error('clock-fixture') });
  emit('unhandledrejection', { reason: new Error('rejection-fixture') });
  context.console.log('[clock-bridge] safe-fixture', { fullSave: 'must-not-serialize' });
  t.mock.timers.tick(500);
  await Promise.resolve();
  const posted = JSON.parse(requests.find((request) => request.options?.method === 'POST').options.body);
  assert.equal(posted.lines.length, 3);
  assert.match(posted.lines.join('\n'), /frontend-error.*clock-fixture/);
  assert.match(posted.lines.join('\n'), /unhandledrejection.*rejection-fixture/);
  assert.doesNotMatch(posted.lines.join('\n'), /must-not-serialize/);
  assert.equal(JSON.parse(storage.get('mahjong-dream/diagnostics')).length, 3);
  const text = await context.__mjHost.downloadLogs();
  assert.match(text, /server-fixture/);
  assert.match(text, /clock-fixture/);
  assert.match(downloads[0], /^mahjong-diagnostics-\d+\.log$/);
});

test('默认不写 Unity/SDK 普通输出，关键链路及未知警告错误仍保留', async (t) => {
  const { context, emit, requests } = page(t);
  await context.__mjHost.ready;
  for (let i = 0; i < 100; i++) {
    context.console.log('Unloading unused assets ' + i);
    context.console.log('[PhysX] Initialized dispatcher');
    context.console.warn('warning: 2 FS.syncfs operations in flight at once, probably just doing extra work');
  }
  context.console.log('[clock-bridge] ready-fixture');
  context.console.warn('unknown-warning-fixture');
  context.console.error('unknown-error-fixture');
  emit('pagehide', {});
  const posted = JSON.parse(requests.find((request) => request.options?.method === 'POST').options.body);
  assert.equal(posted.lines.length, 3);
  assert.match(posted.lines.join('\n'), /ready-fixture/);
  assert.match(posted.lines.join('\n'), /unknown-warning-fixture/);
  assert.match(posted.lines.join('\n'), /unknown-error-fixture/);
  assert.doesNotMatch(context.__mjHost.diagnosticText(), /Unloading|PhysX|FS.syncfs/);
});

test('粒子缺网格警告每种网格保留首次，不重复淹没恢复日志；未知警告和错误不去重', async (t) => {
  const { context } = page(t);
  await context.__mjHost.ready;
  const warning = (mesh, n) => 'No mesh data available for mesh ' + mesh + ' on particle system Particle System (' + n + '). Make sure Read/Write Enabled is set in the importer to work on the particle system renderer';
  for (let i = 0; i < 100; i++) context.console.warn(warning('Cylinder002', i));
  context.console.warn(warning('differentMesh', 1));
  for (let i = 0; i < 3; i++) { context.console.warn('unknown warning'); context.console.error(warning('Cylinder002', 0)); }
  const text = context.__mjHost.diagnosticText();
  assert.equal(text.split('[warn]').length - 1, 5);
  assert.equal(text.split('[error]').length - 1, 3);
  assert.match(text, /Cylinder002/);
  assert.match(text, /differentMesh/);
});

test('Node导出不重复附加已落盘的页面记录，尚未上传的异常仍可导出', async (t) => {
  const { context, requests } = page(t);
  await context.__mjHost.ready;
  context.console.log('[clock-bridge] uploaded-fixture');
  t.mock.timers.tick(500);
  const posted = JSON.parse(requests.find((request) => request.options?.method === 'POST').options.body);
  context.serverDiagnosticText = '[frontend] ' + JSON.stringify(posted.lines[0]);
  context.console.error('not-yet-uploaded-fixture');
  const text = await context.__mjHost.downloadLogs();
  assert.equal(text.split('uploaded-fixture').length - 1, 2, '各出现一次：已上传及未上传两条');
  assert.equal(text.split('[clock-bridge]').length - 1, 1, '已落盘的页面行不再复制一遍');
  assert.match(text, /not-yet-uploaded-fixture/);
});

test('mjDebug=1 保留引擎普通输出及性能提示供按需排查', async (t) => {
  const { context } = page(t, new Map(), 'browser', '?mjDebug=1');
  await context.__mjHost.ready;
  context.console.log('Unloading debug-fixture');
  context.console.warn('warning: 2 FS.syncfs operations in flight at once, probably just doing extra work');
  assert.match(context.__mjHost.diagnosticText(), /Unloading debug-fixture/);
  assert.match(context.__mjHost.diagnosticText(), /FS.syncfs/);
});

test('静态宿主恢复本标签页日志，环形缓冲有界且只在本地导出', async (t) => {
  const storage = new Map([['mahjong-dream/diagnostics', JSON.stringify(['previous-page-fixture'])]]);
  const { context, requests, downloads, emit } = page(t, storage, 'browser');
  await context.__mjHost.ready;
  assert.match(context.__mjHost.diagnosticText(), /previous-page-fixture/);
  for (let i = 0; i < 5100; i++) context.console.log('[clock-bridge] line-' + i);
  emit('pagehide', {});
  assert.equal(context.__mjHost.diagnosticText().split('\n').length, 5000);
  assert.equal(JSON.parse(storage.get('mahjong-dream/diagnostics')).length, 1000);
  assert.equal(requests.length, 0);
  const text = await context.__mjHost.downloadLogs();
  assert.match(text, /host=browser/);
  assert.match(text, /line-5099/);
  assert.equal(downloads.length, 1);
});
