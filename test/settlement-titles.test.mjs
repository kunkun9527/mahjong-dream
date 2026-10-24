// Derived settlement bundles (ADR 0010, ADR 0011): the English han-level textures and the NPC06/NPC09 silent yaku-reveal
// cue are corrected in hash-named copies of their bundles; the page swaps in a derived versions.json so the asset
// manifest points the client at them.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root));
const md5 = (data) => crypto.createHash('md5').update(data).digest('hex');
const record = JSON.parse(read('tools/settlement-titles/manifest.json'));

test('original Unity files are untouched; the derived files match the build record', () => {
  for (const name of [record.source.bundle, ...Object.keys(record.source.voiceBundles), ...Object.values(record.source.voiceBundles)]) {
    assert.equal(md5(read(`StreamingAssets/Bundles/WebGL/${name}`)), name.slice(-39, -7), name);
  }
  assert.equal(md5(read(`StreamingAssets/Bundles/${record.source.arts}`)), record.source.arts.slice(5, 37));
  assert.equal(md5(read('StreamingAssets/Bundles/versions.json')), record.source.versionsMd5);
  for (const [path, { md5: digest, size }] of Object.entries(record.outputs)) {
    const data = read(path);
    assert.equal(md5(data), digest, path);
    assert.equal(data.length, size, path);
  }
});

test('derived bundles keep the client header format and their names are the file hash', () => {
  const paths = Object.keys(record.outputs).filter((p) => p.endsWith('.bundle'));
  const names = paths.map((path) => path.match(/\/([a-z0-9_]+)_[0-9a-f]{32}\.bundle$/)[1]).sort();
  assert.deepEqual(names, ['mjab_jp_ui_ingame', 'npc06_aud_cn', 'npc06_aud_jp', 'npc09_aud_cn', 'npc09_aud_jp']);
  for (const path of paths) {
    const data = read(path);
    assert.equal(path.slice(-39, -7), md5(data), path);
    assert.equal(data.subarray(0, 1).toString(), ' ');
    assert.equal(data.subarray(1, 33).toString(), md5(data.subarray(33)), 'header is md5 of the UnityFS body');
    assert.equal(data.subarray(33, 41).toString('latin1'), 'UnityFS\0');
  }
});

test('versions.mj.json differs from the original only in the Arts manifest hash and size', () => {
  const original = JSON.parse(read('StreamingAssets/Bundles/versions.json'));
  const derived = JSON.parse(read('StreamingAssets/Bundles/versions.mj.json'));
  const arts = derived.data.find((item) => item.name === 'Arts');
  const manifestPath = `StreamingAssets/Bundles/arts_${arts.hash}.json`;
  assert.deepEqual(record.outputs[manifestPath], { md5: arts.hash, size: arts.size });
  const expected = structuredClone(original);
  Object.assign(expected.data.find((item) => item.name === 'Arts'), { hash: arts.hash, size: arts.size });
  assert.deepEqual(derived, expected);
});

function loadPatch() {
  const fetched = [], opened = [];
  const document = { head: { appendChild() {} }, body: { appendChild() {} }, documentElement: { appendChild() {} },
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), querySelector: () => null, hidden: false, addEventListener() {} };
  class XHR { open(method, url) { opened.push(url); } setRequestHeader() {} }
  const win = { WebSocket: class {}, document, fetch(url) { fetched.push(String(url)); return Promise.resolve({}); }, addEventListener() {} };
  const context = vm.createContext({
    window: win, document, navigator: {}, console: { log() {}, warn() {}, error() {} },
    location: { href: 'http://127.0.0.1:8765/game.html', protocol: 'http:', host: '127.0.0.1:8765', search: '' },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, XMLHttpRequest: XHR,
    Element: class { setAttribute() {} }, HTMLScriptElement: class {}, URL, URLSearchParams, Promise, Object, Array, String, Math, Date, Symbol,
  });
  context.window.window = context.window;
  vm.runInContext(read('offline-patch.js').toString(), context);
  return { win, context, fetched, opened };
}

test('the page loads versions.mj.json instead of versions.json; other assets keep their own paths', () => {
  const { win, context, fetched, opened } = loadPatch();
  win.fetch('http://127.0.0.1:8765/StreamingAssets/Bundles/versions.json');
  win.fetch('http://127.0.0.1:8765/StreamingAssets/Bundles/WebGL/mjab_jp_ui_ingame_bae168ce5cac36fd332ea44d80071cb5.bundle');
  new context.XMLHttpRequest().open('GET', '/StreamingAssets/Bundles/versions.json');
  new context.XMLHttpRequest().open('GET', '/StreamingAssets/Bundles/playerassets.json');
  assert.deepEqual(fetched, [
    'http://127.0.0.1:8765/StreamingAssets/Bundles/versions.mj.json',
    'http://127.0.0.1:8765/StreamingAssets/Bundles/WebGL/mjab_jp_ui_ingame_bae168ce5cac36fd332ea44d80071cb5.bundle',
  ]);
  assert.deepEqual(opened, [
    'http://127.0.0.1:8765/StreamingAssets/Bundles/versions.mj.json',
    'http://127.0.0.1:8765/StreamingAssets/Bundles/playerassets.json',
  ]);
});
