import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';

import { loadProfile, saveProfile } from './profile.mjs';
import { createProfileHost, AWAY_LIMIT_MS } from '../mockjs/profile_host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The launcher passes the log path in MJ_LOG_FILE and this process writes it, instead of the launcher teeing our stdout:
// clicking into the Windows console pauses console output, and a stalled tee used to cut a match's log off mid-hand.
if (process.env.MJ_LOG_FILE) {
  const logPath = path.resolve(process.env.MJ_LOG_FILE);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.on('error', (error) => console.error('[local] 日志写入失败：' + error.message));
  // Engine lines carry their own stamp; [local] lines do not, and timing questions need a clock reading.
  const stamp = () => {
    const now = new Date();
    return `[${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}] `;
  };
  for (const name of ['log', 'warn', 'error']) {
    const original = console[name].bind(console);
    console[name] = (...args) => {
      const line = format(...args);
      logStream.write((line.startsWith('[local]') ? stamp() + line : line) + '\n');
      original(...args);
    };
  }
}
const requiredResources = ['index.html', 'game.html', 'Build_intl/mj-h5.loader.js',
  'Build_intl/mj-h5.data.unityweb', 'Build_intl/mj-h5.framework.js.unityweb', 'Build_intl/mj-h5.wasm.unityweb'];
for (const resource of requiredResources) {
  try { await fsp.access(path.join(root, resource)); }
  catch { throw new Error(`[local] 缺少游戏资源：${resource}。请重新解压完整游戏目录。`); }
}
const userdataDirectory = process.env.MJ_USERDATA_DIR ? path.resolve(process.env.MJ_USERDATA_DIR) : path.join(root, 'userdata');
const profile = await loadProfile(userdataDirectory);

globalThis.location = { search: '' };
await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');

const mock = globalThis.__mj.server;
mock.quiet(process.env.MJ_DEBUG !== '1');

let saveTimer = null;
let saveChain = Promise.resolve();
/** Write the current profile now; queued after earlier writes so the newest snapshot lands last. */
function saveNow() {
  clearTimeout(saveTimer);
  const current = profileHost.snapshot();
  const write = saveChain.then(() => saveProfile(userdataDirectory, current));
  saveChain = write.catch(() => {});
  return write;
}
function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow().catch((error) => console.error('[local] 存档失败:', error));
  }, 50);
}

// Match callbacks batch their writes; the save editor (urgent) waits until the file is written.
const profileHost = createProfileHost(mock, profile, {
  persist: (urgent) => (urgent ? saveNow() : persistSoon()),
  log: (line) => console.log(line),
});
// The grant and the completion marker must be persisted together before serving; a failed write must not pretend the upgrade succeeded.
if (profileHost.load()) await saveProfile(userdataDirectory, profileHost.snapshot());
const session = profileHost.attach(mock.createSession());

// The table freezes on the player's decision while the page is away; after AWAY_LIMIT_MS the neutral AI takes the seat
// and finishes the match at once, and it counts as played.
let awayTimer = null;
function armAwayTimer(ms) {
  clearTimeout(awayTimer);
  awayTimer = setTimeout(() => {
    awayTimer = null;
    const engine = session.riichi?.engine;
    if (activeSocket || !engine || session.riichi.matchOver) return;
    engine.speed = 0;
    engine.setHumanAutoplay(true);
    console.log('[local] 玩家离开超过 %d 分钟，AI 已代打并完成本场比赛', AWAY_LIMIT_MS / 60_000);
  }, Math.max(0, ms));
}
// A match left unfinished by the previous run: finish it if the player has been away too long, otherwise rebuild it frozen.
const recovered = await profileHost.recoverMatch({ session });
if (recovered?.restored) {
  armAwayTimer(recovered.remainingMs);
  console.log('[local] 已恢复上次未完成的对局，等待玩家重连');
}

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.bundle', 'application/octet-stream'],
  ['.unityweb', 'application/octet-stream'],
]);

function localPath(url) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(url, 'http://127.0.0.1').pathname); }
  catch { return null; }
  if (pathname === '/') pathname = '/index.html';
  const candidate = path.resolve(root, `.${pathname}`);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

async function sendStatic(request, response) {
  const file = localPath(request.url);
  if (!file) {
    response.writeHead(400).end('Bad request');
    return;
  }
  let stat;
  try { stat = await fsp.stat(file); }
  catch {
    response.writeHead(404).end('Not found');
    return;
  }
  if (!stat.isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }

  const extension = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME.get(extension) || 'application/octet-stream',
    'Cache-Control': extension === '.html' || extension === '.js' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };

  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const suffixLength = !range[1] && range[2] ? Number(range[2]) : null;
    const start = suffixLength != null ? Math.max(0, stat.size - suffixLength) : Number(range[1] || 0);
    const end = suffixLength != null ? stat.size - 1 : range[2] ? Number(range[2]) : stat.size - 1;
    if ((!range[1] && !range[2]) || suffixLength === 0 || start > end || start >= stat.size || end >= stat.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(file, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(file).pipe(response);
}

// Static hosting serves host-mode.js as-is ('browser'); this service answers it so the page uses /ws and /api/profile instead.
const HOST_MODE_SCRIPT = "window.__mjHostMode = 'node';\n";
const MAX_API_BODY = 16 * 1024 * 1024;

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_API_BODY) throw new RangeError('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Save editor API. JSON content type plus a same-origin check keeps other web pages from changing the local save. */
async function handleProfileApi(request, response) {
  const send = (status, body) => response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  }).end(JSON.stringify(body));
  const origin = request.headers.origin;
  if (request.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
  if (!/^application\/json\s*(?:;|$)/i.test(request.headers['content-type'] || '') || (origin && origin !== `http://${request.headers.host}`)) {
    return send(403, { ok: false, error: 'Forbidden' });
  }
  let body;
  try { body = await readJson(request); }
  catch (error) { return send(400, { ok: false, error: error.message }); }
  try { send(200, { ok: true, result: await profileHost.handle(body) }); }
  catch (error) { send(400, { ok: false, error: error.message }); }
}

// A hidden tab is not a disconnected player: pause the human clock instead of freezing the table or letting the AI take over.
let pageVisible = true;
let visibilityTimer = null;
const VISIBILITY_GRACE_MS = 4_000;
function notePageVisibility(visible) {
  clearTimeout(visibilityTimer);
  visibilityTimer = null;
  const engine = session.riichi?.engine;
  const live = engine && !session.riichi.matchOver;
  if (visible) {
    if (!pageVisible) console.log('[local] 页面回到前台，你这一巡的倒计时继续');
    pageVisible = true;
    // Heartbeats stop when the tab is hidden or its timers are throttled; silence means "in the background".
    visibilityTimer = setTimeout(() => notePageVisibility(false), VISIBILITY_GRACE_MS);
    if (live) engine.setHumanPresent(true);
    return;
  }
  if (pageVisible) console.log('[local] 页面切到后台，牌桌暂停等你回来（不按离开处理，也不会 AI 代打）');
  pageVisible = false;
  if (live) engine.setHumanPresent(false);
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/api/page-visibility') {
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    notePageVisibility(new URL(request.url, 'http://127.0.0.1').searchParams.get('visible') !== '0');
    response.writeHead(204, { 'Cache-Control': 'no-store' }).end();
    return;
  }
  if (pathname === '/api/profile') {
    void handleProfileApi(request, response).catch((error) => {
      console.error('[local] 存档接口错误:', error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  if (pathname === '/host-mode.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : HOST_MODE_SCRIPT);
    return;
  }
  void sendStatic(request, response).catch((error) => {
    console.error('[local] 静态文件错误:', error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
let activeSocket = null;

function applyGameOptions(requestUrl) {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  const config = mock.config;
  config.playersExplicit = url.searchParams.has('mjPlayers');
  if (config.playersExplicit) {
    config.players = Number(url.searchParams.get('mjPlayers')) === 3 ? 3 : 4;
  }
  config.matchLengthExplicit = url.searchParams.has('mjLength');
  if (config.matchLengthExplicit) {
    config.matchLength = url.searchParams.get('mjLength') === 'hanchan' ? 'hanchan' : 'east';
  }
  if (url.searchParams.has('mjSeed')) config.seed = Number(url.searchParams.get('mjSeed'));
  if (url.searchParams.has('mjSpeed')) config.speed = Number(url.searchParams.get('mjSpeed'));
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (activeSocket?.readyState === WebSocket.OPEN) {
    socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  applyGameOptions(request.url);
  websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit('connection', websocket, request));
});

websocketServer.on('connection', (websocket) => {
  activeSocket = websocket;
  const connectedAt = Date.now();
  const recentRequests = [];
  let serverClose = null;
  const adapter = {
    readyState: 1,
    _deliver(bytes) {
      if (websocket.readyState === WebSocket.OPEN) websocket.send(bytes, { binary: true });
    },
    close(code, reason) {
      serverClose = { code, reason: String(reason || '') };
      websocket.close(code, reason);
    },
  };
  session.resume(adapter);
  clearTimeout(awayTimer);
  awayTimer = null;
  pageVisible = true;
  clearTimeout(visibilityTimer);
  visibilityTimer = null;
  // The frozen turn resumes its clock once the client has re-synced the table (mock/server.js playerBack).
  profileHost.touch();
  console.log('[local] 游戏页面已连接');

  websocket.on('message', (data, isBinary) => {
    if (!isBinary) return;
    // Keep only the message ID; do not record nicknames, saves, hands, or full payloads.
    try {
      recentRequests.push(Number(globalThis.__mj.proto.dict(new Uint8Array(data))[2]) || 0);
      if (recentRequests.length > 12) recentRequests.shift();
    } catch { /* Diagnostic parse failures must not change the original dispatch behavior */ }
    profileHost.touch();
    const frames = mock.dispatch(session, new Uint8Array(data));
    for (const frame of frames) adapter._deliver(frame);
    persistSoon();
  });
  websocket.on('close', (code, reason) => {
    console.log('[local] WebSocket 关闭：' + JSON.stringify({
      time: new Date().toISOString(), code, reason: reason.toString(),
      source: serverClose ? 'server' : 'peer-or-transport', serverClose,
      connectedMs: Date.now() - connectedAt, recentRequests,
      inMatch: session.liveMatch(),
    }));
    if (activeSocket === websocket) activeSocket = null;
    adapter.readyState = 3;
    if (!session.riichi && (session.matchTimer || session.engineStartTimer)) {
      if (session.matchTimer) clearTimeout(session.matchTimer);
      if (session.engineStartTimer) clearTimeout(session.engineStartTimer);
      session.matchTimer = null;
      session.engineStartTimer = null;
      session.matchToken += 1;
      session.tableId = 0;
      session.seat = -1;
      session.table = null;
    }
    session.suspend();
    profileHost.touch();
    clearTimeout(visibilityTimer);
    visibilityTimer = null;
    pageVisible = false;
    if (session.riichi?.engine && !session.riichi.matchOver) {
      session.riichi.engine.setHumanPresent(false);
      armAwayTimer(AWAY_LIMIT_MS);
      console.log('[local] 页面断开，牌桌停在你的回合；%d 分钟内未重连则由 AI 代打完成本场', AWAY_LIMIT_MS / 60_000);
    } else {
      console.log('[local] 游戏页面已断开');
    }
    persistSoon();
  });
  websocket.on('error', (error) => console.warn('[local] WebSocket:', error.message));
});

const host = '127.0.0.1';
const port = Number(process.env.MJ_PORT || 8765);
server.once('error', (error) => {
  const detail = error.code === 'EADDRINUSE'
    ? `端口 ${port} 已被占用，请关闭旧的游戏服务或设置其他 MJ_PORT。`
    : `本地服务启动失败：${error.message}`;
  console.error(`[local] ${detail}`);
  if (process.send) process.send({ type: 'startup-error', detail });
  process.exitCode = 1;
});
server.listen(port, host, () => {
  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}/`;
  console.log(`[local] 激情麻将已启动：${url}（pid ${process.pid}；日志里没有这行说明你看的是别的进程）`);
  if (process.send) process.send({ type: 'ready', url });
});

async function shutdown() {
  await saveNow().catch((error) => console.error('[local] 存档失败:', error));
  server.close();
  websocketServer.close();
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
