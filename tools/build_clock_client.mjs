// Development-only derivation. Original Unity files are never written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { execFileSync, execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = '730effb3ff74fb93975c29e48249f29c43d32b9c65d55805a03f765de260cab9';
const source = path.join(root, 'Build_intl/mj-h5.wasm.unityweb');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const original = fs.readFileSync(source);
if (hash(original) !== expected) throw new Error('Unsupported Unity build: re-audit the clock hooks before deriving a new client');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mahjong-clock-build-'));
try {
  const raw = path.join(temp, 'original.wasm');
  const watFile = path.join(temp, 'original.wat');
  const patchedWat = path.join(temp, 'clock.wat');
  const patchedWasm = path.join(temp, 'clock.wasm');
  fs.writeFileSync(raw, brotliDecompressSync(original));
  execSync(`npm exec --yes --package=wabt@1.0.39 -- wasm2wat "${raw}" -o "${watFile}" --generate-names`, { stdio: 'inherit' });
  const wat = fs.readFileSync(watFile);
  const changes = [];
  for (const id of [39470, 14666, 35847, 21653, 35819, 4571, 106610]) {
    const start = wat.indexOf(`\n  (func $f${id} `);
    const end = wat.indexOf('\n  (func ', start + 1);
    if (start < 0 || end < 0) throw new Error('Missing function ' + id);
    const body = wat.subarray(start, end).toString('utf8');
    const sites = {
      39470: ['      i64.store offset=368\n', '      local.get $p0\n      local.get $l4\n      call $mj.apply\n'],
      14666: ['    call $f1119\n    local.set $l7\n', '    local.get $p0\n    local.get $l7\n    call $mj.apply\n'],
      35847: ['            return\n', '            local.get $mj.packets\n            call $mj.consumed\n'],
      21653: ['    call $f39590\n', '    local.get $p0\n    call $mj.render\n'],
      35819: ['    call_indirect $Kk (type $t2)', '    i32.const 5\n    i32.const 0\n    call $mj.sync\n'],
      4571: ['    global.set $g0)', '    local.get $mj.state\n    i32.const 4\n    i32.eq\n    if\n      i32.const 4\n      local.get $mj.machine\n      call $mj.sync\n    end'],
      106610: ['      local.get $p0\n      local.get $p0\n      call $f14666\n', ''],
    };
    const [needle, hook] = sites[id];
    if (body.split(needle).length !== 2) throw new Error('Ambiguous clock/sync patch site ' + id);
    let patched = id === 35847 || id === 35819 ? body.replace(needle, hook + needle) : body.replace(needle, needle + hook);
    if (id === 35847) {
      patched = patched.replace('    (local $l3 i32)', '    (local $mj.packets i32) (local $l3 i32)')
        .replace('    global.get $g0\n', '    local.get $p1\n    local.set $mj.packets\n    global.get $g0\n');
    }
    // Native InitCountDown is the real playable-hand boundary, not receipt of NtfGameStart.
    if (id === 39470) patched = patched.replace('    global.set $g0)', '    global.set $g0\n    i32.const 7\n    local.get $p0\n    call $mj.sync)');
    // Reload dispatch uses HybridCLR: observe the real native state machine, not an unused AOT async clone.
    if (id === 35819) patched = patched.replace(needle + ')', needle + '\n    i32.const 6\n    i32.const 0\n    call $mj.sync)');
    if (id === 4571) {
      patched = body.replace(needle, needle.slice(0, -1) + '\n' + hook + ')')
        .replace('    (local $l3 i32)', '    (local $mj.machine i32) (local $mj.state i32) (local $l3 i32)')
        .replace('    global.get $g0\n', '    local.get $p0\n    local.set $mj.machine\n    local.get $p1\n    local.set $mj.state\n    local.get $p1\n    i32.const 9\n    i32.eq\n    if\n      i32.const 3\n      local.get $p0\n      call $mj.sync\n    end\n    global.get $g0\n');
    }
    if (id === 106610) {
      // Refresh active countdowns every frame; keep the native one-second sound/effect cadence.
      const block = '    block $B1\n';
      if (body.split(block).length !== 2) throw new Error('Ambiguous countdown refresh block');
      patched = body.replace(needle, '').replace(block,
        '    local.get $p0\n    i32.load8_u offset=376\n    if\n      local.get $p0\n      local.get $p0\n      call $f14666\n    end\n' + block);
    }
    changes.push({ start, end, data: Buffer.from(patched) });
  }
  const importsAt = wat.indexOf('\n  (import ');
  const helperAt = wat.indexOf('\n  (table ');
  if (importsAt < 0 || helperAt < 0) throw new Error('Missing module insertion site');
  changes.push({ start: importsAt, end: importsAt, data: Buffer.from('\n  (import "mj" "clock" (func $mj.clock (param i32) (result i32)))\n  (import "mj" "sync" (func $mj.sync (param i32 i32)))') });
  const helper = `
  ;; Packet.f27 is the actual delivery counter (i64 at +160), not an RPC sequence.
  ;; Called only after RiichiMode.ProcessPackets has successfully dispatched the list.
  (func $mj.consumed (param $list i32)
    (local $i i32) (local $packet i32)
    block $done
      loop $next
        local.get $i
        local.get $list
        i32.load offset=12
        i32.ge_u
        br_if $done
        local.get $list
        i32.load offset=8
        local.get $i
        i32.const 4
        i32.mul
        i32.add
        i32.load offset=16
        local.tee $packet
        if
          i32.const 1
          local.get $packet
          i64.load offset=160
          i32.wrap_i64
          call $mj.sync
        end
        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $next
      end
    end)
  ;; MGRenderManager: +36 paused, +48 processing, +44 queue; Queue.Count at +20.
  (func $mj.render (param $render i32)
    (local $idle i32) (local $queue i32)
    local.get $render
    i32.load offset=44
    local.tee $queue
    if
      local.get $queue
      i32.load offset=20
      i32.eqz
      local.get $render
      i32.load8_u offset=36
      i32.eqz
      i32.and
      local.get $render
      i32.load8_u offset=48
      i32.eqz
      i32.and
      local.set $idle
    end
    i32.const 2
    local.get $idle
    call $mj.sync)
  (func $mj.apply (param $view i32) (param $now i64)
    (local $base i64) (local $total i64)
    i32.const 0
    call $mj.clock
    if
      i32.const 1
      call $mj.clock
      i64.extend_i32_u
      local.set $base
      i32.const 2
      call $mj.clock
      i64.extend_i32_u
      local.set $total
      local.get $view
      local.get $now
      local.get $base
      i64.add
      i64.store offset=352
      local.get $view
      local.get $now
      local.get $base
      i64.add
      i64.store offset=360
      local.get $view
      local.get $now
      local.get $total
      i64.add
      i64.store offset=368
    end)
`;
  changes.push({ start: helperAt, end: helperAt, data: Buffer.from(helper) });
  changes.sort((a, b) => a.start - b.start);
  const out = fs.openSync(patchedWat, 'w');
  let cursor = 0;
  try {
    for (const change of changes) {
      fs.writeSync(out, wat.subarray(cursor, change.start));
      fs.writeSync(out, change.data);
      cursor = change.end;
    }
    fs.writeSync(out, wat.subarray(cursor));
  } finally { fs.closeSync(out); }
  execFileSync('python', [path.join(root, 'tools/compile_clock_wat.py'), patchedWat, patchedWasm], { stdio: 'inherit' });
  const derived = fs.readFileSync(patchedWasm);
  const module = new WebAssembly.Module(derived);
  const oldModule = new WebAssembly.Module(fs.readFileSync(raw));
  const extraImports = WebAssembly.Module.imports(module).filter((entry) => entry.module === 'mj');
  if (JSON.stringify(extraImports) !== JSON.stringify([{ module: 'mj', name: 'clock', kind: 'function' }, { module: 'mj', name: 'sync', kind: 'function' }]) ||
      JSON.stringify(WebAssembly.Module.exports(module)) !== JSON.stringify(WebAssembly.Module.exports(oldModule))) {
    throw new Error('Unexpected derived imports or exports');
  }
  if (hash(fs.readFileSync(source)) !== expected) throw new Error('Original build changed during derivation');
  const wasmHash = hash(derived);
  const codeFile = 'mj-h5.clock-' + wasmHash.slice(0, 16) + '.wasm.unityweb';
  const compressed = fs.readFileSync(patchedWasm + '.br');
  if (hash(brotliDecompressSync(compressed)) !== wasmHash ||
      !compressed.subarray(0, 64).includes(Buffer.from('UnityWeb Compressed Content (brotli)'))) {
    throw new Error('Invalid Unity Brotli artifact');
  }
  fs.writeFileSync(path.join(root, 'Build_intl', codeFile), compressed);
  const manifest = { v: 3, sourceHash: expected, wasmHash, compressedHash: hash(compressed), codeFile };
  fs.writeFileSync(path.join(root, 'Build_intl/mj-h5.clock.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
