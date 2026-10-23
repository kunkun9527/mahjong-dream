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

function load(clock, mode = 'node') {
  const sockets = [], fetches = [], visibilityCalls = [];
  const events = new Map();
  const timers = new Map();
  let seq = 0;
  let now = 0;
  class FakeWS {
    constructor(url) { this.url = url; this.listeners = {}; this.readyState = 1; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener() {}
    send() {}
    close() { this.closed = true; }
    emit(type, ev = { type }) {
      let stopped = false;
      ev.stopImmediatePropagation = () => { stopped = true; };
      for (const fn of this.listeners[type] || []) { fn(ev); if (stopped) break; }
    }
  }
  const document = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    createElement: element,
    querySelector: () => null,
    hidden: false,
    addEventListener(name, fn) { events.set(name, fn); },
  };
  const win = { WebSocket: FakeWS, document, __mjClock: clock, __mjHostMode: mode,
    __mjHost: { setPageVisible(visible) { visibilityCalls.push(visible); return Promise.resolve(visible); } },
    fetch(url) { fetches.push(String(url)); return Promise.resolve({}); },
    addEventListener(name, fn) { events.set(name, fn); } };
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
    socket, fetches, visibilityCalls,
    visibility(hidden) { document.hidden = hidden; events.get('visibilitychange')?.(); },
    focus(focused) { events.get(focused ? 'focus' : 'blur')?.(); },
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

for (const mode of ['node', 'browser']) {
  test(`${mode} host focus loss and backgrounding do not report a pause or close the connection; returning shows no reconnect`, async () => {
    const app = load(undefined, mode);
    app.socket.emit('open');
    app.focus(false);
    app.visibility(true);
    app.advance(60_000);
    await Promise.resolve();
    assert.equal(app.socket.closed, undefined);
    app.visibility(false);
    app.focus(true);
    app.advance(5_000);
    await Promise.resolve();
    assert.equal(app.socket.closed, undefined, 'returning to the foreground must not actively close the game connection');
    assert.deepEqual(app.fetches, [], 'no page-visibility heartbeat or pause request is sent');
    assert.deepEqual(app.visibilityCalls, [], 'the static host likewise cannot pause the table on hide or resume');
    assert.equal(app.banner(), null);
  });
}

test('the host swallows the Node clock side-band, Unity receives only the original binary; disconnect freezes the mirror', () => {
  const samples = [];
  let frozen = 0, unityFrames = 0;
  const controls = [];
  const app = load({ accept: (state) => samples.push(state), connect() {}, disconnect() { frozen++; },
    synchronize: (message, socket) => controls.push({ message, socket }), status: () => ({ recovery: null }) });
  app.socket.addEventListener('message', () => { unityFrames++; });
  app.socket.emit('message', { data: JSON.stringify({ mjClock: { id: 4, baseMs: 0, extraMs: 18000, running: false } }) });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].extraMs, 18000);
  assert.equal(unityFrames, 0);
  app.socket.emit('message', { data: JSON.stringify({ mjSync: { phase: 'end', id: 'batch', counter: 7 } }) });
  assert.equal(controls.length, 1);
  assert.equal(controls[0].socket, app.socket);
  assert.equal(unityFrames, 0, 'the recovery-confirmation side-band likewise must not enter the Unity protocol parser');
  app.socket.emit('message', { data: new ArrayBuffer(8) });
  assert.equal(unityFrames, 1);
  app.socket.emit('close', { code: 1006 });
  assert.equal(frozen, 1);
});

test('after a disconnect show the reconnect banner, after reconnecting show the restore banner, and collapse it when replay ends', () => {
  const app = load();
  assert.equal(app.banner(), null, 'no banner should appear when the first frame is not a disconnect');
  app.socket.emit('open');
  assert.equal(app.banner(), null, 'no banner on the first connection');

  app.socket.emit('close', { type: 'close', code: 1006, wasClean: false });
  assert.deepEqual([app.banner().visible, app.banner().text], [true, 'Connection lost, reconnecting…']);

  app.advance(1200);
  assert.equal(app.banner().seconds, 'Waited 1 seconds', 'the banner shows the elapsed wait time');

  app.socket.emit('open');
  assert.deepEqual([app.banner().visible, app.banner().text], [true, 'Reconnected, restoring match…']);

  // Server replay: frames back to back, then silence.
  app.socket.emit('message', { type: 'message', data: new ArrayBuffer(8) });
  app.advance(6);
  app.socket.emit('message', { type: 'message', data: new ArrayBuffer(8) });
  app.advance(6);
  app.socket.emit('message', { type: 'message', data: new ArrayBuffer(8) });
  app.advance(300);
  assert.equal(app.banner().visible, true, 'the banner stays during replay');
  app.advance(1000);
  assert.equal(app.banner().visible, false, 'collapsed after replay ends');
});

test('after reconnecting with no replay frames (the match has ended), collapse automatically a moment later', () => {
  const app = load();
  app.socket.emit('open');
  app.socket.emit('close', { type: 'close' });
  app.socket.emit('open');
  app.advance(4100);
  assert.equal(app.banner().visible, false);
});

test('if the connection never comes back, the banner stays and shows the elapsed wait time', () => {
  const app = load();
  app.socket.emit('open');
  app.socket.emit('close', { type: 'close' });
  app.advance(5000);
  assert.equal(app.banner().visible, true);
  assert.equal(app.banner().seconds, 'Waited 5 seconds');
  app.advance(16_000);
  assert.equal(app.banner().visible, true, 'after 20 seconds the disconnect banner should still stay');
  assert.match(app.banner().text, /Still not connected/);
  assert.equal(app.banner().seconds, 'Waited 21 seconds');
});
