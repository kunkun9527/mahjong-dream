import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const entry = new URL('../local/launcher.mjs', import.meta.url);
const source = fs.readFileSync(entry, 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', 'entryUrl');

async function launch({ env = {}, args = [] } = {}) {
  const child = new EventEmitter();
  child.kill = () => {};
  let forkOptions, browser;
  const context = vm.createContext({
    entryUrl: entry.href, path, fileURLToPath, URL,
    fs: { access: async () => {} },
    process: { env: { 'ProgramFiles(x86)': 'C:/Applications', ...env }, argv: ['node', entry.pathname, ...args], platform: 'win32', once() {} },
    console: { log() {}, error: assert.fail },
    setTimeout: () => 1, clearTimeout() {},
    fork(_file, options) { forkOptions = options; return child; },
    spawn(command, args, options) {
      browser = { command, args, options };
      const spawned = new EventEmitter();
      spawned.unref = () => {};
      queueMicrotask(() => spawned.emit('spawn'));
      return spawned;
    },
  });
  vm.runInContext(source, context);
  const url = `http://127.0.0.1:${forkOptions.env.MJ_PORT}/`;
  child.emit('message', { type: 'ready', url });
  await new Promise(setImmediate);
  return { forkOptions, browser };
}

test('单入口默认使用固定来源，重启不因随机端口丢失 Unity 语言偏好', async () => {
  const first = await launch(), second = await launch();
  assert.equal(first.forkOptions.env.MJ_PORT, '8765');
  assert.equal(first.browser.args[0], 'http://127.0.0.1:8765/');
  assert.equal(second.browser.args[0], first.browser.args[0]);
  assert.equal(first.browser.options.detached, true);
});

test('启动器保留显式端口及三四麻/局长参数，不再强制写入语言参数', async () => {
  const { forkOptions, browser } = await launch({ env: { MJ_PORT: '8790', MJ_USERDATA_DIR: 'M:/isolated' }, args: ['--players=3', '--length=hanchan', '--lang=en'] });
  const url = new URL(browser.args[0]);
  assert.equal(forkOptions.env.MJ_USERDATA_DIR, 'M:/isolated');
  assert.equal(url.port, '8790');
  assert.equal(url.searchParams.get('mjPlayers'), '3');
  assert.equal(url.searchParams.get('mjLength'), 'hanchan');
  assert.equal(url.searchParams.has('mjLang'), false);
  assert.equal((await launch({ env: { MJ_PORT: '0' } })).forkOptions.env.MJ_PORT, '0');
});

test('发布启动入口仅保留 start-game.bat 与 npm start', () => {
  const root = new URL('../', import.meta.url);
  const bats = fs.readdirSync(root).filter(name => /^start-game.*\.bat$/i.test(name));
  assert.deepEqual(bats, ['start-game.bat']);
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.scripts.start, 'node local/launcher.mjs');
  assert.equal('start:en' in pkg.scripts, false);
});
