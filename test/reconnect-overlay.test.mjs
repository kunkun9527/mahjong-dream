// The reconnect banner in offline-patch.js: it must appear on a drop, stay up while the hand is restored,
// and go away once the server's replay burst is over. Verified against a fake DOM and a fake WebSocket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../offline-patch.js', import.meta.url), 'utf8');

function element(tag) {
  return { tagName: tag.toUpperCase(), style: {}, children: [], id: '', textContent: '', appendChild(child) { this.children.push(child); }, setAttribute() {} };
}

function load() {
  const sockets = [];
  const timers = new Map();
  let seq = 0;
  let now = 0;
  class FakeWS {
    constructor(url) { this.url = url; this.listeners = {}; this.readyState = 1; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener() {}
    send() {}
    close() {}
    emit(type, ev = { type }) { for (const fn of this.listeners[type] || []) fn(ev); }
  }
  const document = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    createElement: element,
    querySelector: () => null,
  };
  const win = { WebSocket: FakeWS, document };
  const context = vm.createContext({
    window: win,
    document,
    location: { href: 'http://127.0.0.1:8765/game.html', protocol: 'http:', host: '127.0.0.1:8765', search: '' },
    navigator: {},
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = ++seq; timers.set(id, { fn, at: now + 500, every: 500 }); return id; },
    clearInterval(id) { timers.delete(id); },
    XMLHttpRequest: class { open() {} setRequestHeader() {} },
    Element: class { setAttribute() {} },
    HTMLScriptElement: class {},
    Symbol, URL, URLSearchParams, Promise, Object, Array, String, Math, Date: class extends Date { static now() { return now; } },
  });
  context.window.window = context.window;
  vm.runInContext(source, context);
  const socket = new win.WebSocket('ws://riichi_proxy/game');
  const overlay = () => context.window.__mjmock.overlay;
  return {
    socket,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        now = next[1].at;
        if (next[1].every) next[1].at = now + next[1].every; else timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
    banner() {
      const root = context.window.__mjmock.reconnect.root();
      return root ? { visible: root.style.display !== 'none', text: root.children[0].children[1].textContent, seconds: root.children[0].children[2].textContent } : null;
    },
    overlay,
  };
}

test('掉线后显示重连提示，重连后显示恢复提示，重放结束自动收起', () => {
  const app = load();
  assert.equal(app.banner(), null, '首帧未掉线时不应出现提示');
  app.socket.emit('open');
  assert.equal(app.banner(), null, '首次连接不提示');

  app.socket.emit('close', { type: 'close', code: 1006, wasClean: false });
  assert.deepEqual([app.banner().visible, app.banner().text], [true, '连接中断，正在重连…']);

  app.advance(1200);
  assert.equal(app.banner().seconds, '已等待 1 秒', '提示里显示已等待时长');

  app.socket.emit('open');
  assert.deepEqual([app.banner().visible, app.banner().text], [true, '已重新连接，正在恢复牌局…']);

  // Server replay: frames back to back, then silence.
  app.socket.emit('message', { type: 'message', data: new ArrayBuffer(8) });
  app.advance(6);
  app.socket.emit('message', { type: 'message', data: new ArrayBuffer(8) });
  app.advance(6);
  app.socket.emit('message', { type: 'message', data: new ArrayBuffer(8) });
  app.advance(300);
  assert.equal(app.banner().visible, true, '重放期间保持提示');
  app.advance(1000);
  assert.equal(app.banner().visible, false, '重放结束后收起');
});

test('重连后没有重放帧（牌局已结束）时，稍后自动收起', () => {
  const app = load();
  app.socket.emit('open');
  app.socket.emit('close', { type: 'close' });
  app.socket.emit('open');
  app.advance(4100);
  assert.equal(app.banner().visible, false);
});

test('一直连不回来时提示保留并显示等待时长', () => {
  const app = load();
  app.socket.emit('open');
  app.socket.emit('close', { type: 'close' });
  app.advance(5000);
  assert.equal(app.banner().visible, true);
  assert.equal(app.banner().seconds, '已等待 5 秒');
});
