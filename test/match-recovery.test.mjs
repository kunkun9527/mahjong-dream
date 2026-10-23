import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../mockjs/engine.mjs';
import { PlayAction, RiichiMsg } from '../mockjs/proto_enum.mjs';
import { NPCS } from '../mockjs/npc_roster.mjs';
import { createDefaultProfile } from '../mockjs/profile.mjs';
import { createProfileHost, AWAY_LIMIT_MS } from '../mockjs/profile_host.mjs';

globalThis.location = { search: '' };
await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');
const P = globalThis.__mj.proto;
const mock = globalThis.__mj.server;
mock.quiet(true);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('等待超时');
    await wait(2);
  }
}

// The test plays the human seat like a client: the neutral AI picks each decision and submits it through the public API.
function humanMove(engine) {
  if (engine._pending?.kind === 'draw' && engine._expectedDraw) {
    const exp = engine._expectedDraw;
    const d = engine.aiTurn(0, exp.drew, exp.actions, exp.cantPlays);
    return engine.submitDraw({ action: d.action, card: d.card });
  }
  if (engine._pending?.kind === 'claim' && engine._expectedClaim) {
    const exp = engine._expectedClaim;
    const c = engine.aiClaim(0, exp.discarderSeat, exp.card, exp.actions);
    return engine.submitClaim(c ? { action: c.action, otherCards: c.otherCards || [] } : { action: PlayAction.Guo, otherCards: [] });
  }
  return null;
}

// Answer every human wait as soon as it opens (prepare included) until `stop` says to leave the next one open.
function autoRespond(engine, stop = () => false) {
  const waitHuman = engine.waitHuman.bind(engine);
  engine.waitHuman = (kind) => {
    const promise = waitHuman(kind);
    if (engine._pending && !stop()) setImmediate(() => humanMove(engine));
    return promise;
  };
  const waitPrepare = engine.waitPrepare.bind(engine);
  engine.waitPrepare = (ms) => {
    const promise = waitPrepare(ms);
    if (engine._prepareWaiter && !stop()) setImmediate(() => engine.submitPrepare());
    return promise;
  };
}

const STYLES = [null, NPCS[0].style, NPCS[8].style, NPCS[12].style];
const settings = (extra = {}) => ({
  players: 4, seed: 4242, speed: 0, matchLength: 'east', maxHands: 64, aiLevel: 'intermediate', aiStyles: STYLES, ...extra,
});
const frameKey = (event, payload) => `${event}:${JSON.stringify(payload, (k, v) => (k === 'gameID' ? undefined : v))}`;

test('真人决策记录可在任意切点重演到同一局面，接着打完结果一致', async () => {
  // Original match: record frames, and how many frames had been emitted when each log entry was taken.
  const frames = [];
  const framesAtEntry = [];
  const original = new GameEngine({ ...settings(), emit: (e, p) => frames.push(frameKey(e, p)), onRecord: () => framesAtEntry.push(frames.length) });
  autoRespond(original);
  await original.start();
  const log = original.matchRecord();
  assert.ok(log.length > 40, `记录条数 ${log.length}`);
  assert.ok(log.some((entry) => entry[0] === 'c') && log.some((entry) => entry[0] === 'd') && log.some((entry) => entry[0] === 'p'));

  for (const cut of [0, 1, 7, Math.floor(log.length / 2), log.length - 1]) {
    const replayFrames = [];
    let doneAt = null;
    const replay = new GameEngine({
      ...settings({ speed: 1 }), replayLog: log.slice(0, cut), humanPresent: false,
      emit: (e, p) => replayFrames.push(frameKey(e, p)),
      onReplayDone: (clean) => { assert.ok(clean, `cut ${cut} 分叉`); doneAt = replayFrames.length; },
    });
    const started = replay.start();
    await until(() => doneAt != null);
    // The replay stops exactly where the original was waiting for decision `cut` (AI moves after the last decision included).
    assert.deepEqual(replayFrames.slice(0, doneAt), frames.slice(0, framesAtEntry[cut]), `cut ${cut}`);
    assert.equal(replay.speed, 1, '重演结束后恢复正常速度');
    // Continue live with the same player and finish identically.
    replay.speed = 0;
    replay.setHumanPresent(true); // The connection/sync gate opens before live client input resumes.
    autoRespond(replay);
    if (replay._pending) humanMove(replay);
    if (replay._prepareWaiter) replay.submitPrepare();
    await started;
    assert.deepEqual(replay.scores, original.scores, `cut ${cut} 终局点数`);
    assert.deepEqual(replay.matchRecord(), log, `cut ${cut} 记录`);
  }
});

test('默认精简日志不改变牌局，调试模式可还原摸牌、AI及空窗口细节', async () => {
  const normal = [], detailed = [];
  const options = settings({ players: 3, maxHands: 1, autoHuman: true });
  const engine = new GameEngine({ ...options, log: (line) => normal.push(line) });
  const debug = new GameEngine({ ...options, debug: true, log: (line) => detailed.push(line) });
  await engine.start();
  await debug.start();
  assert.deepEqual(engine.scores, debug.scores);
  assert.deepEqual(engine.matchRecord(), debug.matchRecord());
  assert.ok(normal.length < detailed.length / 2, `${normal.length} < ${detailed.length}/2`);
  assert.doesNotMatch(normal.join('\n'), /\[ai\]|\[claim\]|\[draw\].*P\d 摸/);
  assert.match(normal.join('\n'), /\[hand\].*开局/);
  assert.match(normal.join('\n'), /\[discard\]/);
  assert.match(normal.join('\n'), /\[hand\].*结束/);
  assert.match(detailed.join('\n'), /\[ai\]/);
  assert.match(detailed.join('\n'), /\[claim\]/);
  assert.match(detailed.join('\n'), /\[draw\].*P\d 摸/);
});

test('离开时真人回合冻结不超时，回来后才开始计时', async () => {
  const engine = new GameEngine({ ...settings({ baseTime: 0, extraTime: 0, speed: 0 }), humanPresent: false, emit() {} });
  let pendingSeen = false;
  const waitHuman = engine.waitHuman.bind(engine);
  engine.waitHuman = (kind) => { pendingSeen = true; return waitHuman(kind); };
  const waitPrepare = engine.waitPrepare.bind(engine);
  engine.waitPrepare = (ms) => { const p = waitPrepare(ms); if (engine._prepareWaiter) setImmediate(() => engine.submitPrepare()); return p; };
  const started = engine.start();
  await until(() => pendingSeen && engine._pending);
  const before = engine.humanLog.length;
  await wait(60);
  assert.ok(engine._pending, '离开期间不超时');
  assert.equal(engine.humanLog.length, before);
  engine.setHumanPresent(true);
  await until(() => engine.humanLog.length > before);
  engine.setHumanAutoplay(true);
  await started;
  assert.ok(engine.matchOver);
});

test('开了摸切/不鸣牌后离开：自动动作也冻结，回来后才继续', async () => {
  const engine = new GameEngine({
    ...settings({ baseTime: 0, extraTime: 0, speed: 0 }), humanPresent: false, internalState: { 2: true, 3: true }, emit() {},
  });
  const waitPrepare = engine.waitPrepare.bind(engine);
  engine.waitPrepare = (ms) => { const p = waitPrepare(ms); if (engine._prepareWaiter) setImmediate(() => engine.submitPrepare()); return p; };
  const started = engine.start();
  await until(() => engine._pending);
  const before = engine.humanLog.length;
  await wait(60);
  assert.ok(engine._pending, '离开期间自动动作不执行');
  assert.equal(engine.humanLog.length, before);
  engine.setHumanPresent(true);
  await until(() => engine.humanLog.length > before);
  engine.setHumanAutoplay(true);
  await started;
  assert.ok(engine.matchOver);
});

function socket() {
  const frames = [], controls = [];
  return { frames, controls, readyState: 1, _deliver(bytes) { frames.push(P.dict(bytes)); },
    _sync(message) { controls.push(message); },
  };
}

/** Start a ranked match through the protocol and play `moves` human decisions; returns the session and its latest record. */
async function playUntil(moves) {
  const session = mock.createSession();
  let record = null;
  session.onMatchRecord = (r) => { record = r; };
  session.resume(socket());
  const match = P.W().v(1, 4001).v(3, 7).v(4, 3).v(6, 1).bytes();
  mock.dispatch(session, P.W().v(2, 20403).v(11, 1).s(3, P.W().s(1, match).bytes()).bytes());
  await until(() => session.riichi?.engine);
  const engine = session.riichi.engine;
  let made = 0;
  autoRespond(engine, () => made >= moves);
  const prepare = engine.waitHuman;
  engine.waitHuman = (kind) => { const p = prepare(kind); made++; return p; };
  const ready = P.W().v(1, RiichiMsg.EReqPrepare).v(3, Date.now()).s(100, new Uint8Array()).bytes();
  mock.dispatch(session, P.W().v(2, 20018).v(11, 2).s(3, ready).bytes());
  await until(() => made > moves && engine._pending);
  return { session, engine, record };
}

const config = { seed: 9001, matchDelay: 0, engineStartDelay: 0, speed: 0 };
function withConfig(t) {
  const old = { ...mock.config };
  Object.assign(mock.config, config);
  t.after(() => { for (const key of Object.keys(config)) mock.config[key] = old[key]; });
}

test('页面重载：从记录重建对局，20162 等重演完成后回到同一局面，客户端同步后才恢复计时', async (t) => {
  withConfig(t);
  const { session, engine, record } = await playUntil(12);
  assert.ok(record && record.table.robots.length === 3 && record.log.length >= 12);
  assert.ok(record.table.robots.every((r) => NPCS.some((npc) => npc.id === r.npc && npc.nick === r.nick)));
  const expected = { hand: engine.players.map((p) => p.hand.slice()), discards: engine.players.map((p) => p.discards.slice()),
    remain: engine.remain, kind: engine._pending.kind, scores: engine.players.map((p) => p.score) };
  session.destroy(); // the page is gone

  const restored = mock.createSession();
  t.after(() => restored.destroy());
  const ws = socket();
  restored.resume(ws);
  const ready = mock.restoreMatch(restored, JSON.parse(JSON.stringify(record)));
  assert.equal(restored.tableId, 1, '登录前就带对局标记');
  // The client asks before the replay has caught up: the answer waits.
  assert.deepEqual(mock.dispatch(restored, P.W().v(2, 20162).v(11, 3).s(3, new Uint8Array()).bytes()), []);
  await ready;
  const engine2 = restored.riichi.engine;
  assert.deepEqual(engine2.players.map((p) => p.hand), expected.hand);
  assert.deepEqual(engine2.players.map((p) => p.discards), expected.discards);
  assert.equal(engine2.remain, expected.remain);
  assert.deepEqual(engine2.players.map((p) => p.score), expected.scores);
  assert.equal(engine2._pending?.kind, expected.kind);
  await until(() => ws.frames.some((f) => f[2] === 20163));
  const reply = P.dict(ws.frames.find((f) => f[2] === 20163)[3]);
  assert.ok(reply[4], '20163 带牌桌');
  await until(() => ws.controls.some((message) => message.phase === 'end'));
  assert.equal(restored.replaying, true, '发完恢复快照不是客户端已消费完成');
  assert.equal(engine2.humanPresent, false);
  assert.equal(restored.ackClientSync(ws.controls.find((message) => message.phase === 'end'), ws), true);
  assert.equal(restored.replaying, false);
  assert.equal(engine2.humanPresent, true, '客户端同步后恢复计时');
  restored.destroy();
});

test('离开超过 5 分钟：打开时 AI 中性代打完成上一场，计入战绩并留下英文提示；未超时则原样恢复', async (t) => {
  withConfig(t);
  const { session, record } = await playUntil(8);
  session.destroy();
  const now = Date.now();

  const stale = createDefaultProfile();
  stale.activeMatch = { ...JSON.parse(JSON.stringify(record)), lastSeen: now - AWAY_LIMIT_MS - 1000 };
  const writes = [];
  const host = createProfileHost(mock, stale, { persist: (urgent) => { writes.push(urgent); } });
  host.load();
  const games = stale.stats.yonma.games;
  const settled = await host.recoverMatch({ now });
  assert.equal(settled.settled, true);
  assert.equal(stale.activeMatch, null);
  assert.equal(stale.stats.yonma.games, games + 1, '计入战绩');
  assert.match(stale.notice, /^You were away for more than 5 minutes, so the AI finished your last match: \d(st|nd|rd|th) place, [+-]\d+ PT, \+\d+ coins\.$/);
  assert.ok(writes.includes(true));
  assert.equal((await host.handle({ action: 'state' })).notice, stale.notice);
  await host.handle({ action: 'dismissNotice' });
  assert.equal(stale.notice, null);

  const fresh = createDefaultProfile();
  fresh.activeMatch = { ...JSON.parse(JSON.stringify(record)), lastSeen: now - 60_000 };
  const host2 = createProfileHost(mock, fresh, { persist() {} });
  host2.load();
  const target = host2.attach(mock.createSession());
  target.resume(socket());
  const restored = await host2.recoverMatch({ session: target, now });
  assert.equal(restored.restored, true);
  assert.equal(restored.remainingMs, AWAY_LIMIT_MS - 60_000);
  await restored.ready;
  assert.equal(target.tableId, 1);
  assert.ok(fresh.activeMatch, '恢复后仍保留记录直到打完');
  assert.equal((await host2.handle({ action: 'state' })).inMatch, true);
  await assert.rejects(host2.handle({ action: 'resetStats' }), /Finish or leave the current match first/);
  // Leaving the table drops the record.
  mock.dispatch(target, P.W().v(2, 20025).v(11, 9).s(3, new Uint8Array()).bytes());
  assert.equal(fresh.activeMatch, null);
  target.destroy();
});
