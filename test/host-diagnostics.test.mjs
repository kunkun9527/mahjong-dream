import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../web-host.js', import.meta.url), 'utf8');

function page(t, storage = new Map(), mode = 'node') {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const listeners = new Map(), requests = [], downloads = [];
  const host = { load: () => false, attach() {}, recoverMatch: async () => {}, snapshot: () => ({}) };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date, Promise, JSON, Error, Blob, URLSearchParams, setTimeout, clearTimeout,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    localStorage: { getItem: () => null },
    location: { search: '' }, navigator: {}, alert() {},
    document: {
      createElement: () => ({ click() { downloads.push(this.download); } }),
      head: { appendChild: (script) => script.onload() }
    },
    __mjHostMode: mode,
    __mj: { server: { quiet() {}, FakeWebSocket: function () {} },
      host: { normalizeProfile: (saved) => saved, createProfileHost: () => host } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, text: async () => '[clock] server-fixture\n' };
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
  context.console.log('safe-fixture', { fullSave: 'must-not-serialize' });
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

test('静态宿主恢复本标签页日志，环形缓冲有界且只在本地导出', async (t) => {
  const storage = new Map([['mahjong-dream/diagnostics', JSON.stringify(['previous-page-fixture'])]]);
  const { context, requests, downloads, emit } = page(t, storage, 'browser');
  await context.__mjHost.ready;
  assert.match(context.__mjHost.diagnosticText(), /previous-page-fixture/);
  for (let i = 0; i < 5100; i++) context.console.log('line-' + i);
  emit('pagehide', {});
  assert.equal(context.__mjHost.diagnosticText().split('\n').length, 5000);
  assert.equal(JSON.parse(storage.get('mahjong-dream/diagnostics')).length, 1000);
  assert.equal(requests.length, 0);
  const text = await context.__mjHost.downloadLogs();
  assert.match(text, /host=browser/);
  assert.match(text, /line-5099/);
  assert.equal(downloads.length, 1);
});
