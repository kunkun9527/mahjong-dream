// AI difficulty head-to-head benchmark: for each seed, enumerate the balanced seat layouts of the two label groups (4-player 2:2; 3-player 2:1 and 1:2).
//   Usage: node tools/ai_benchmark.mjs [A=intermediate] [B=basic] [seed count=40] [players=4] [east|hanchan] [starting seed=1000] [options]
//   A / B are "labels": `level` (basic|intermediate|advanced) or `old:level`. Statistics are merged by label, not by level name.
//   `old:level` means that seat uses the decisions of the old mockjs in the --baseline directory (the old engine's aiTurn/aiClaim, applied to the same position),
//   so new and old versions can play the same deal; an error is raised when --baseline is missing. A and B labels must not be identical.
//   `--baseline=DIR`  root of an old worktree (e.g. 502b376 created by git worktree add)
//   `--out=DIR`       writes per-seed raw results (JSON and CSV, not committed); default $AI_BENCH_OUT or the system temp dir/ai_benchmark
//   `--tag=NAME`      output filename prefix (default bench)
//   `--merge=a.json,b.json`  runs no games; merges several raw results and re-summarizes (for parallel segment runs)
// Both player counts give 6 games per seed; each label appears 3 times in each seat. Duplicate layouts are not run again.
// Standard errors are clustered by seed, so same-seed positions are not treated as independent samples; single-seed standard errors/intervals cannot be estimated.
// The JSON records the seed, layout and action stage of the slowest decision, reproducible with the same command and seed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { GameEngine } from '../mockjs/engine.mjs';
import { RiichiMsg } from '../mockjs/proto_enum.mjs';

const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => {
  const [k, ...v] = a.slice(2).split('=');
  return [k, v.join('=') || 'true'];
}));
const positional = argv.filter((a) => !a.startsWith('--'));
const [labelA = 'intermediate', labelB = 'basic', seedArg = '40', playersArg = '4', length = 'east', seedStartArg = '1000'] = positional;
const LEVELS = ['basic', 'intermediate', 'advanced'];
const seeds = Number(seedArg);
const players = Number(playersArg);
const outDir = flags.out || process.env.AI_BENCH_OUT || path.join(os.tmpdir(), 'ai_benchmark');
const tag = flags.tag || 'bench';

function parseLabel(label) {
  const old = label.startsWith('old:');
  const level = old ? label.slice(4) : label;
  if (!LEVELS.includes(level)) throw new Error(`unknown level ${label}`);
  return { label, level, old };
}

// ---------- Statistics helpers ----------
// Seed-clustered standard error for a ratio (total num / total den). items: [{ seed, num, den }].
function ratioStat(items) {
  const bySeed = new Map();
  for (const it of items) {
    const cur = bySeed.get(it.seed) || { num: 0, den: 0 };
    cur.num += it.num;
    cur.den += it.den;
    bySeed.set(it.seed, cur);
  }
  let num = 0;
  let den = 0;
  for (const c of bySeed.values()) { num += c.num; den += c.den; }
  const r = den ? num / den : 0;
  const k = bySeed.size;
  let ss = 0;
  for (const c of bySeed.values()) ss += (c.num - r * c.den) ** 2;
  const se = k > 1 ? (den ? Math.sqrt(ss * k / (k - 1)) / den : 0) : null;
  return { value: r, se, n: den, clusters: k };
}

function pairedStat(perSeed) {
  const k = perSeed.length;
  if (!k) return { mean: 0, se: 0, lo: 0, hi: 0, k };
  const mean = perSeed.reduce((a, b) => a + b, 0) / k;
  const variance = k > 1 ? perSeed.reduce((a, b) => a + (b - mean) ** 2, 0) / (k - 1) : 0;
  const se = k > 1 ? Math.sqrt(variance / k) : null;
  return { mean, se, lo: se === null ? null : mean - 1.96 * se, hi: se === null ? null : mean + 1.96 * se, k };
}

// Decision time: log-binned histogram (1% per bin), mergeable; p99 takes the bin's upper bound (error about 1%).
const BIN_BASE = 1.01;
const BIN_MIN_MS = 0.001;
const binOf = (ms) => Math.max(0, Math.floor(Math.log(Math.max(ms, BIN_MIN_MS) / BIN_MIN_MS) / Math.log(BIN_BASE)));
const binUpper = (b) => BIN_MIN_MS * BIN_BASE ** (b + 1);
function newTiming() { return { n: 0, sum: 0, max: 0, bins: {}, slowest: [] }; }
function addTiming(t, ms, context) {
  if (context && (t.slowest.length < 5 || ms > t.slowest.at(-1).ms)) {
    t.slowest.push({ ms, ...context() });
    t.slowest.sort((a, b) => b.ms - a.ms);
    t.slowest.length = Math.min(5, t.slowest.length);
  }
  t.n++;
  t.sum += ms;
  if (ms > t.max) t.max = ms;
  const b = binOf(ms);
  t.bins[b] = (t.bins[b] || 0) + 1;
}
function mergeTiming(into, from) {
  into.n += from.n;
  into.sum += from.sum;
  into.max = Math.max(into.max, from.max);
  into.slowest = into.slowest.concat(from.slowest || []).sort((a, b) => b.ms - a.ms).slice(0, 5);
  for (const [b, c] of Object.entries(from.bins)) into.bins[b] = (into.bins[b] || 0) + c;
}
function timingSummary(t) {
  if (!t.n) return { n: 0, mean: 0, p99: 0, max: 0 };
  const target = Math.ceil(t.n * 0.99);
  let acc = 0;
  let p99 = t.max;
  for (const b of Object.keys(t.bins).map(Number).sort((a, c) => a - c)) {
    acc += t.bins[b];
    if (acc >= target) { p99 = Math.min(t.max, binUpper(b)); break; }
  }
  return { n: t.n, mean: t.sum / t.n, p99, max: t.max, slowest: t.slowest };
}

// ---------- Games ----------
let OldEngine = null;
async function loadBaseline() {
  if (!flags.baseline) throw new Error('old: labels require --baseline=<old repo root>');
  const mod = await import(pathToFileURL(path.resolve(flags.baseline, 'mockjs/engine.mjs')).href);
  OldEngine = mod.GameEngine;
}

function seatLayouts(n) {
  if (n !== 3 && n !== 4) throw new Error('players must be 3 or 4');
  return Array.from({ length: 2 ** n }, (_, mask) => Array.from({ length: n }, (_, seat) => (mask >> seat) & 1))
    .filter((layout) => Math.abs(layout.reduce((a, b) => a + b, 0) * 2 - n) <= 1);
}

// The entry and the strategy helpers it dispatches dynamically must be routed together, so an old aiClaim does not call the new call strategy.
function routeAiMethods(engine, specs, oldPrototype) {
  // Older basic policies call helpers removed from the unified engine.
  for (const name of ['aiTurnBasic', 'aiShouldFold', 'riichiDecision']) {
    if (!engine[name] && oldPrototype?.[name]) engine[name] = oldPrototype[name];
  }
  for (const name of ['aiTurn', 'aiClaim', 'aiClaimByPolicy']) {
    const current = engine[name];
    engine[name] = function routeAi(seat, ...args) {
      return (specs[seat].old ? oldPrototype[name] : current).call(this, seat, ...args);
    };
  }
}

async function playOne(seed, rot, specs, timings) {
  let finalScores = null;
  const tally = specs.map(() => ({ hands: 0, wins: 0, tsumo: 0, dealIn: 0 }));
  const engine = new GameEngine({
    players,
    startScore: players === 3 ? 35000 : 25000,
    speed: 0,
    seed,
    matchLength: length,
    autoHuman: true,
    aiLevels: specs.map((s) => s.level),
    emit: (type, payload) => {
      if (type !== RiichiMsg.ENtfGameStop) return;
      for (const t of tally) t.hands++;
      const winners = payload.huSeats || [];
      if (!winners.length) return;
      const tsumo = winners.length === 1 && payload.huCardSeat === winners[0];
      for (const w of winners) {
        tally[w].wins++;
        if (tsumo) tally[w].tsumo++;
      }
      if (!tsumo && payload.huCardSeat >= 0) tally[payload.huCardSeat].dealIn++;
    },
    onFinish: (scores) => { finalScores = scores.slice(); },
  });
  // Decision timing and old/new routing: seats labelled old: call the old engine's AI methods (same position, same public-information interface).
  routeAiMethods(engine, specs, OldEngine?.prototype);
  const turn = engine.aiTurn;
  const claim = engine.aiClaim;
  const context = (phase, seat) => () => ({
    seed, rot, phase, seat, handIndex: engine.handIndex, xunNum: engine.xunNum,
    hand: engine.players[seat].hand.slice(), melds: structuredClone(engine.players[seat].melds),
    remain: engine.remain,
  });
  engine.aiTurn = function aiTurnTimed(seat, ...rest) {
    const impl = turn;
    const t0 = performance.now();
    const r = impl.call(this, seat, ...rest);
    addTiming(timings[specs[seat].label], performance.now() - t0, context('turn', seat));
    return r;
  };
  engine.aiClaim = function aiClaimTimed(seat, ...rest) {
    const impl = claim;
    const t0 = performance.now();
    const r = impl.call(this, seat, ...rest);
    addTiming(timings[specs[seat].label], performance.now() - t0, context('claim', seat));
    return r;
  };
  await engine.start();
  return { scores: finalScores || engine.players.map((p) => p.score), tally };
}

async function runGames() {
  if (!Number.isSafeInteger(seeds) || seeds < 1 || !Number.isSafeInteger(Number(seedStartArg))) throw new Error('seed count must be a positive integer and start seed must be a safe integer');
  if (!['east', 'hanchan'].includes(length)) throw new Error('match length must be east or hanchan');
  const layouts = seatLayouts(players);
  const specA = parseLabel(labelA);
  const specB = parseLabel(labelB);
  if (specA.label === specB.label) throw new Error('A and B labels are the same and cannot be told apart; use the old: prefix for the old version');
  if (specA.old || specB.old) await loadBaseline();
  const timings = { [specA.label]: newTiming(), [specB.label]: newTiming() };
  const games = [];
  const start0 = players === 3 ? 35000 : 25000;
  for (let s = 0; s < seeds; s++) {
    const seed = Number(seedStartArg) + s;
    for (let rot = 0; rot < layouts.length; rot++) {
      const specs = layouts[rot].map((side) => side === 0 ? specA : specB);
      const { scores, tally } = await playOne(seed, rot, specs, timings);
      const order = scores.map((score, seat) => ({ score, seat })).sort((a, b) => b.score - a.score || a.seat - b.seat);
      games.push({
        seed,
        rot,
        seats: scores.map((score, seat) => ({
          seat,
          label: specs[seat].label,
          delta: score - start0,
          place: order.findIndex((o) => o.seat === seat) + 1,
          ...tally[seat],
        })),
      });
    }
  }
  return { meta: { schema: 3, layouts, labels: [specA.label, specB.label], players, length, seedStart: Number(seedStartArg), seeds }, games, timings };
}

// ---------- Summary ----------
function summarize(meta, games, timings) {
  const [la, lb] = meta.labels;
  const samples = games.flatMap((g) => g.seats.map((s) => ({ seed: g.seed, ...s })));
  const lines = [];
  const uncertainty = (v, digits = 0) => v === null ? 'n/a' : v.toFixed(digits);
  const fmt = (st, digits = 0) => `${st.value.toFixed(digits)}±${uncertainty(st.se, digits)}`;
  const out = { meta, labels: {}, paired: {} };
  for (const label of meta.labels) {
    const mine = samples.filter((s) => s.label === label);
    const bySeat = {};
    for (const seat of [...new Set(mine.map((s) => s.seat))].sort()) {
      const group = mine.filter((s) => s.seat === seat);
      bySeat[seat] = { n: group.length, delta: ratioStat(group.map((s) => ({ seed: s.seed, num: s.delta, den: 1 }))).value };
    }
    const info = {
      n: mine.length,
      delta: ratioStat(mine.map((s) => ({ seed: s.seed, num: s.delta, den: 1 }))),
      place: ratioStat(mine.map((s) => ({ seed: s.seed, num: s.place, den: 1 }))),
      dealIn: ratioStat(mine.map((s) => ({ seed: s.seed, num: s.dealIn, den: s.hands }))),
      win: ratioStat(mine.map((s) => ({ seed: s.seed, num: s.wins, den: s.hands }))),
      bySeat,
      timing: timingSummary(timings[label] || newTiming()),
    };
    out.labels[label] = info;
    lines.push(`${label.padEnd(16)} samples=${info.n} avg score delta=${fmt(info.delta)} avg place=${fmt(info.place, 3)} deal-in rate=${(info.dealIn.value * 100).toFixed(2)}%±${uncertainty(info.dealIn.se === null ? null : info.dealIn.se * 100, 2)} win rate=${(info.win.value * 100).toFixed(2)}%±${uncertainty(info.win.se === null ? null : info.win.se * 100, 2)} (hands=${info.dealIn.n})`);
    lines.push(`${''.padEnd(16)} by seat (seat:samples:mean) ${Object.entries(bySeat).map(([s, v]) => `${s}:${v.n}:${v.delta.toFixed(0)}`).join('  ')}`);
    const t = info.timing;
    lines.push(`${''.padEnd(16)} decision time n=${t.n} mean=${t.mean.toFixed(2)}ms p99≈${t.p99.toFixed(1)}ms max=${t.max.toFixed(1)}ms`);
  }
  // Paired by seed: for each seed, the mean of A-label samples minus the mean of B-label samples.
  const seedList = [...new Set(games.map((g) => g.seed))].sort((a, b) => a - b);
  const perSeed = (field) => seedList.map((seed) => {
    const mean = (label) => {
      const g = samples.filter((s) => s.seed === seed && s.label === label);
      return g.reduce((a, s) => a + s[field], 0) / Math.max(1, g.length);
    };
    return mean(la) - mean(lb);
  });
  const dDelta = pairedStat(perSeed('delta'));
  const dPlace = pairedStat(perSeed('place'));
  out.paired = { delta: dDelta, place: dPlace, perSeedDelta: Object.fromEntries(seedList.map((s, i) => [s, perSeed('delta')[i]])) };
  lines.push(`paired diff ${la} − ${lb} (${seedList.length} seed clusters): score delta ${dDelta.mean.toFixed(0)}±${uncertainty(dDelta.se)}, 95%CI [${uncertainty(dDelta.lo)}, ${uncertainty(dDelta.hi)}]; place ${dPlace.mean.toFixed(3)}±${uncertainty(dPlace.se, 3)}, 95%CI [${uncertainty(dPlace.lo, 3)}, ${uncertainty(dPlace.hi, 3)}]`);
  return { lines, out, samples };
}

function writeRaw(raw, samples, summary) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${tag}-${raw.meta.players}p-${raw.meta.seedStart}-${raw.meta.seeds}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ ...raw, summary }, null, 1));
  const header = 'seed,rot,seat,label,delta,place,hands,wins,tsumo,dealIn';
  const rows = raw.games.flatMap((g) => g.seats.map((s) => [g.seed, g.rot, s.seat, s.label, s.delta, s.place, s.hands, s.wins, s.tsumo, s.dealIn].join(',')));
  fs.writeFileSync(`${base}.csv`, [header, ...rows].join('\n') + '\n');
  return base;
}

async function main() {
const t0 = performance.now();
let raw;
if (flags.merge) {
  const parts = flags.merge.split(',').map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const reference = parts[0].meta;
  const seen = new Set();
  for (const part of parts) {
    for (const key of ['schema', 'labels', 'players', 'length', 'layouts']) {
      if (JSON.stringify(part.meta[key]) !== JSON.stringify(reference[key])) throw new Error(`cannot merge results with different ${key}`);
    }
    for (const game of part.games) {
      const key = `${game.seed}:${game.rot}`;
      if (seen.has(key)) throw new Error(`duplicate match ${key}`);
      seen.add(key);
    }
  }
  const timings = {};
  for (const part of parts) {
    for (const [label, t] of Object.entries(part.timings)) mergeTiming(timings[label] ||= newTiming(), t);
  }
  const games = parts.flatMap((p) => p.games);
  const seedList = games.map((g) => g.seed);
  raw = {
    meta: { ...parts[0].meta, seedStart: Math.min(...seedList), seeds: new Set(seedList).size },
    games,
    timings,
  };
} else {
  raw = await runGames();
}
const { lines, out, samples } = summarize(raw.meta, raw.games, raw.timings);
for (const line of lines) console.log(line);
console.log(`elapsed ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log(`raw results: ${writeRaw(raw, samples, out)}.{json,csv}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
export { seatLayouts, ratioStat, pairedStat, routeAiMethods };
