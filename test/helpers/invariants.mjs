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
  assert.equal(new Set(zones).size, zones.length, `实体牌重复：${label}`);
  assert.ok(zones.every((id) => legal.has(id)), `非法实体牌：${label}`);
  assert.equal(zones.length, legal.size, `实体牌总数：${label}`);
  assert.equal(engine.replacements.length + sealed.length, rinLen, `岭上与封存牌数：${label}`);
  assert.equal((scores || engine.players.map((p) => p.score)).reduce((a, b) => a + b, 0)
    + engine.riichiSticks * 1000, engine.playersN * engine.startScore, `点数加供托：${label}`);
  assert.ok(!(engine._expectedDraw && engine._expectedClaim), `动作窗口并存：${label}`);
  assert.ok(!(engine._bufferedDraw && engine._bufferedClaim), `动作缓冲并存：${label}`);
  const actors = engine.players.filter((p) => p.hand.length
    + p.melds.filter((meld) => meld.type !== 'babei').length * 3 === 14);
  assert.ok(actors.length <= 1, `当前行动者不唯一：${label}`);
  if (expectedActor !== undefined) {
    assert.deepEqual(actors.map((p) => p.seat), [expectedActor], `当前行动者错误：${label}`);
  }
  for (const [kind, window] of [['draw', engine._expectedDraw], ['claim', engine._expectedClaim]]) {
    if (!window) continue;
    assert.ok(Number.isInteger(window.seat) && window.seat >= 0 && window.seat < engine.playersN,
      `动作座位越界：${label}`);
    assert.equal(engine.players[window.seat].isHuman, true, `非真人动作窗口：${label}`);
    assert.ok(window.actions.length > 0, `空动作窗口：${label}`);
    if (kind === 'draw') {
      assert.deepEqual(actors.map((p) => p.seat), [window.seat], `摸打窗口行动者：${label}`);
    } else {
      assert.notEqual(window.seat, window.discarderSeat, `不能抢自己的牌：${label}`);
      assert.ok(engine.players[window.discarderSeat], `供牌座位越界：${label}`);
      assert.ok(engine.players[window.discarderSeat].discards.includes(window.card)
        || engine.players[window.discarderSeat].hand.includes(window.card), `供牌实体不存在：${label}`);
    }
  }
  if (engine._pending) {
    const key = engine._pending.kind === 'draw' ? '_expectedDraw' : '_expectedClaim';
    assert.ok(engine[key], `等待任务缺少动作窗口：${label}`);
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
  assert.notEqual(result, Result.Succ, '非法动作不得成功');
  if (expectedResult !== undefined) assert.equal(result, expectedResult);
  assert.deepEqual(stateSnapshot(engine), before, `${method} 非法动作部分提交`);
  assert.equal(engine._pending, pending, `${method} 非法动作替换等待任务`);
  assert.equal(engine._pending?.timer, timer, `${method} 非法动作替换计时器`);
  assert.equal(engine._pending?.resolve, resolve, `${method} 非法动作替换等待回调`);
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
        check('发牌提交');
      }
      if (name === 'endHand') context.winningCard = args[0].type === 'ron' ? args[0].card : null;
      // Settlement is computed atomically on local scores; players.score is the cache at the start of this hand,
      // and this.scores is committed only at finishHand, so accounts from two different moments must not be added together.
      if (['prepareFinalResult', 'buildStopUserInfos'].includes(name)) context.scores = args[0];
      if (name === 'finishHand') context.scores = args[2];
      if (entry.has(name)) check(`${name}:入口提交`,
        !engine.handEnded && ['awaitTurn', 'doKan', 'doBaBei'].includes(name) ? args[0] : undefined);
      const tail = name === 'drawReplacement' && engine.replacements.length && engine.remain > 0
        ? engine.wall.at(-1) : null;
      const result = original.apply(this, args);
      if (tail != null) {
        context.sealed.push(tail);
        check('补牌提交');
      }
      if (name === 'finishHand') {
        assert.deepEqual(engine.scores, args[2], '终局分数必须完整提交');
        context.scores = engine.scores;
      }
      if (exit.has(name)) check(`${name}:返回提交`);
      return result;
    };
  }
  return { counts, check: () => check('外部检查') };
}
