import assert from 'node:assert/strict';
import { buildWall } from '../../mockjs/tiles.mjs';
import { Result } from '../../mockjs/proto_enum.mjs';

// deadWall is an index table set at initialization, not an independent ownership zone: its front section overlaps with the replacements,
// and only the last ten tiles are the dora zone. Wall-tail tiles removed when replacing draws are tracked one by one by the observer.
export function assertInvariants(engine, { sealed = [], winningCard = null, scores = null, expectedActor, label = '' } = {}) {
  const legal = new Set(buildWall({ sanma: engine.sanma }).tiles);
  const rinLen = engine.sanma ? 8 : 4;
  const zones = engine.players.flatMap((p) => [
    ...p.hand, ...p.discards, ...p.melds.flatMap((meld) => meld.tiles),
  ]).concat(engine.wall, engine.replacements, engine.deadWall.slice(rinLen), sealed);
  // Ron does not copy the winner's hand; a tile won by robbing a kan / North pull is in the settlement parameters, while an ordinary ron still sits in the river.
  if (winningCard != null && !zones.includes(winningCard)) zones.push(winningCard);
  assert.equal(new Set(zones).size, zones.length, `Duplicate physical tile: ${label}`);
  assert.ok(zones.every((id) => legal.has(id)), `Illegal physical tile: ${label}`);
  assert.equal(zones.length, legal.size, `Physical tile count mismatch: ${label}`);
  assert.equal(engine.replacements.length + sealed.length, rinLen, `Replacement and sealed tile count: ${label}`);
  assert.equal((scores || engine.players.map((p) => p.score)).reduce((a, b) => a + b, 0)
    + engine.riichiSticks * 1000, engine.playersN * engine.startScore, `Points plus riichi sticks: ${label}`);
  assert.ok(!(engine._expectedDraw && engine._expectedClaim), `Action windows overlap: ${label}`);
  assert.ok(!(engine._bufferedDraw && engine._bufferedClaim), `Action buffers overlap: ${label}`);
  const actors = engine.players.filter((p) => p.hand.length
    + p.melds.filter((meld) => meld.type !== 'babei').length * 3 === 14);
  assert.ok(actors.length <= 1, `Multiple current actors: ${label}`);
  if (expectedActor !== undefined) {
    assert.deepEqual(actors.map((p) => p.seat), [expectedActor], `Wrong current actor: ${label}`);
  }
  for (const [kind, window] of [['draw', engine._expectedDraw], ['claim', engine._expectedClaim]]) {
    if (!window) continue;
    assert.ok(Number.isInteger(window.seat) && window.seat >= 0 && window.seat < engine.playersN,
      `Action seat out of range: ${label}`);
    assert.equal(engine.players[window.seat].isHuman, true, `Action window for a non-human seat: ${label}`);
    assert.ok(window.actions.length > 0, `Empty action window: ${label}`);
    if (kind === 'draw') {
      assert.deepEqual(actors.map((p) => p.seat), [window.seat], `Draw window actor mismatch: ${label}`);
    } else {
      assert.notEqual(window.seat, window.discarderSeat, `Cannot claim own discard: ${label}`);
      assert.ok(engine.players[window.discarderSeat], `Discarder seat out of range: ${label}`);
      assert.ok(engine.players[window.discarderSeat].discards.includes(window.card)
        || engine.players[window.discarderSeat].hand.includes(window.card), `Discarded tile not found: ${label}`);
    }
  }
  if (engine._pending) {
    const key = engine._pending.kind === 'draw' ? '_expectedDraw' : '_expectedClaim';
    assert.ok(engine[key], `Pending task has no action window: ${label}`);
  }
}

// Does not use engine.snapshot() (it omits many authoritative fields). Functions and timers are runtime handles;
// the snapshot keeps the wait kind / start point / whether a timer exists, and all other own data fields are deep-copied.
export function stateSnapshot(engine) {
  const state = Object.fromEntries(Object.entries(engine).filter(([key, value]) =>
    typeof value !== 'function' && key !== '_pending'));
  state._pending = engine._pending ? {
    kind: engine._pending.kind, startedAt: engine._pending.startedAt, timer: !!engine._pending.timer,
  } : null;
  return structuredClone(state);
}

export function assertRejectedUnchanged(engine, method, payload, expectedResult) {
  const before = stateSnapshot(engine);
  const pending = engine._pending;
  const timer = pending?.timer;
  const resolve = pending?.resolve;
  const result = engine[method](payload);
  assert.notEqual(result, Result.Succ, 'Illegal action must not succeed');
  if (expectedResult !== undefined) assert.equal(result, expectedResult);
  assert.deepEqual(stateSnapshot(engine), before, `${method} partially committed an illegal action`);
  assert.equal(engine._pending, pending, `${method} replaced the pending task on an illegal action`);
  assert.equal(engine._pending?.timer, timer, `${method} replaced the timer on an illegal action`);
  assert.equal(engine._pending?.resolve, resolve, `${method} replaced the wait callback on an illegal action`);
  return result;
}

// Wraps only instance methods; does not change the wall, AI, return values, timing or the engine prototype. The outermost return of a recursive async action
// is already the end of the whole hand, so the just-committed state is also checked at the entry of the next phase.
export function observeCommits(engine) {
  const counts = new Map();
  let context = {};
  let currentPlayers;
  const check = (label, expectedActor) => {
    if (!engine.players) return;
    assertInvariants(engine, { ...context, expectedActor, label: `${engine.seed}/${engine.handIndex}/${label}` });
    counts.set(label, (counts.get(label) || 0) + 1);
  };
  const entry = new Set(['awaitTurn', 'discard', 'resolveClaims', 'executeClaim', 'doKan', 'doBaBei',
    'drawReplacement', 'endHand', 'prepareFinalResult', 'buildStopUserInfos', 'finishHand']);
  const exit = new Set(['expectDraw', 'expectClaim', 'resolveHumanPending', 'submitDraw', 'submitClaim',
    'revealKanDora', 'flushDeferredKanDora', 'rollbackRiichiDeclaration', 'confirmRiichiDeclaration',
    'markPassedRon', 'finishHand', 'setInternalState', 'setHumanAutoplay', 'cancelPending']);
  for (const name of new Set([...entry, ...exit, 'waitPrepare'])) {
    const original = engine[name];
    engine[name] = function (...args) {
      if (name === 'waitPrepare' && currentPlayers !== engine.players) {
        currentPlayers = engine.players;
        context = { sealed: [] };
        check('deal commit');
      }
      if (name === 'endHand') context.winningCard = args[0].type === 'ron' ? args[0].card : null;
      // Settlement is computed atomically on local scores; players.score is the cache at the start of this hand,
      // and this.scores is committed only at finishHand, so accounts from two different moments must not be added together.
      if (['prepareFinalResult', 'buildStopUserInfos'].includes(name)) context.scores = args[0];
      if (name === 'finishHand') context.scores = args[2];
      if (entry.has(name)) check(`${name}:entry commit`,
        !engine.handEnded && ['awaitTurn', 'doKan', 'doBaBei'].includes(name) ? args[0] : undefined);
      const tail = name === 'drawReplacement' && engine.replacements.length && engine.remain > 0
        ? engine.wall.at(-1) : null;
      const result = original.apply(this, args);
      if (tail != null) {
        context.sealed.push(tail);
        check('replacement commit');
      }
      if (name === 'finishHand') {
        assert.deepEqual(engine.scores, args[2], 'Final scores must be committed in full');
        context.scores = engine.scores;
      }
      if (exit.has(name)) check(`${name}:return commit`);
      return result;
    };
  }
  return { counts, check: () => check('external check') };
}
