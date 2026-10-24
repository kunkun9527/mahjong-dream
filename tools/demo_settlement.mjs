// One-click settlement-title demo: serves the repo read-only on a spare port, injects tools/settlement-demo-page.js
// into game.html, opens Edge/Chrome with a throw-away profile and clicks into a 4P ranked match. Every win is then
// settled as the chosen han level so its settlement animation plays. Nothing is saved to the real game profile.
//   node tools/demo_settlement.mjs [mangan|haneman|baiman|sanbaiman|yakuman|all] [--headless] [--port=8790]
// Not part of the shipped game; see tools/codemap.md.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = ['mangan', 'haneman', 'baiman', 'sanbaiman', 'yakuman', 'all'];
const args = process.argv.slice(2);
const level = args.find((a) => LEVELS.includes(a)) || 'all';
const headless = args.includes('--headless');
const option = (name, fallback) => Number((args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1]) || fallback;
const PORT = option('port', 8790);
const CDP_PORT = option('cdp-port', PORT + 1);
const VIEW = { width: 1280, height: 720 };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm', '.ico': 'image/x-icon' };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, rel === '/' ? 'game.html' : rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); return res.end(); }
      const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
      // Same rule as local/server.mjs: only the derived clock client is served as native Brotli.
      if (/^mj-h5\.clock-[a-f0-9]{16}\.wasm\.unityweb$/.test(path.basename(file))) {
        headers['Content-Encoding'] = 'br';
        headers['Content-Type'] = 'application/wasm';
      }
      if (rel === '/game.html' || rel === '/') {
        const html = data.toString('utf8');
        const tag = '<script src="tools/settlement-demo-page.js"></script>';
        if (!html.includes('</head>')) throw new Error('game.html has no </head>');
        data = Buffer.from(html.replace('</head>', `${tag}\n</head>`));
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function browserPath() {
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Microsoft Edge or Google Chrome is required');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      // Policy-installed extensions may open their own tabs in a fresh profile: pick the game page by address.
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}/`));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* browser still starting */ }
    await sleep(200);
  }
  throw new Error('could not reach the browser debugging port');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      else if (msg.method) for (const fn of this.listeners) fn(msg);
    });
    this.closed = new Promise((resolve) => this.ws.addEventListener('close', resolve));
  }
  open() { return new Promise((resolve) => this.ws.addEventListener('open', resolve, { once: true })); }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const n = ++this.id;
      this.pending.set(n, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      this.ws.send(JSON.stringify({ id: n, method, params }));
    });
  }
  async click(fx, fy) {
    const x = Math.round(VIEW.width * fx), y = Math.round(VIEW.height * fy);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await sleep(60);
    }
  }
}

async function main() {
  const server = await serve();
  const url = `http://127.0.0.1:${PORT}/game.html?mjPlayers=4&mjSpeed=0.5&demo=${level}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-settlement-demo-'));
  const flags = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    `--window-size=${VIEW.width + 16},${VIEW.height + 40}`, '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-extensions'];
  if (headless) flags.push('--headless=new', '--mute-audio');
  const browser = spawn(browserPath(), [...flags, `--app=${url}`], { stdio: 'ignore' });
  console.log(`[demo] ${level}: ${url}`);
  console.log('[demo] the match starts automatically; close the browser window (or press Ctrl+C) to stop.');

  const cdp = new Cdp(await connect());
  await cdp.open();
  const seen = [];
  cdp.listeners.push((msg) => {
    if (msg.method !== 'Runtime.consoleAPICalled') return;
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (/\[demo\]|\[request\]/.test(text)) seen.push(text);
    if (/\[demo\] settling/.test(text)) console.log(text);
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false });
  const waitFor = async (pattern, timeout) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (seen.some((t) => pattern.test(t))) return true; await sleep(200); }
    return false;
  };

  // Lobby is up once the user-data query has been answered; give the lobby scene a moment to settle.
  if (!await waitFor(/KclientLobbyQueryUserDataRequest/, 120_000)) throw new Error('the lobby did not load');
  await sleep(6_000);
  for (let attempt = 0; attempt < 5 && !seen.some((t) => /RankingMatchRequest/.test(t)); attempt++) {
    await cdp.click(0.672, 0.389); // Riichi
    await sleep(8_000);
    await cdp.click(0.867, 0.924); // Quick Start
    await waitFor(/RankingMatchRequest/, 6_000);
  }
  if (!seen.some((t) => /RankingMatchRequest/.test(t))) throw new Error('could not start a match');
  console.log('[demo] match started; the first win plays the settlement animation.');

  const stop = () => { try { browser.kill(); } catch {} server.close(); fs.rmSync(profile, { recursive: true, force: true }); };
  process.on('SIGINT', () => { stop(); process.exit(0); });
  await cdp.closed;
  stop();
}

main().catch((error) => { console.error(`[demo] ${error.message}`); process.exit(1); });
