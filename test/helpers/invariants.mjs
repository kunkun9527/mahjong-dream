import assert from 'node:assert/strict';
import { buildWall } from '../../mockjs/tiles.mjs';
import { Result } from '../../mockjs/proto_enum.mjs';

// deadWall 是初始化时的索引表，不是独立所有权区：前段与 replacements
// 重叠，后十张才是宝牌区。补牌时移出的牌山尾牌由观察器逐张记账。
export function assertInvariants(engine, { sealed = [], winningCard = null, scores = null, expectedActor, label = '' } = {}) {
  const legal = new Set(buildWall({ sanma: engine.sanma }).tiles);
  const rinLen = engine.sanma ? 8 : 4;
  const zones = engine.players.flatMap((p) => [
    ...p.hand, ...p.discards, ...p.melds.flatMap((meld) => meld.tiles),
  ]).concat(engine.wall, engine.replacements, engine.deadWall.slice(rinLen), sealed);
  // 荣和不复制赢家手牌；抢杠/抢北成功的牌在结算参数中，普通荣和仍在牌河。
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

// 不使用 engine.snapshot()（它省略大量权威字段）。函数和计时器是运行时句柄，
// 快照保留等待种类/起点/是否有计时器，其余所有自身数据字段均深拷贝。
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

// 仅包装实例方法，不改牌山、AI、返回值、时序或引擎原型。递归异步动作的
// 最外层返回已是整局结束，所以同时在下一个阶段的入口检查刚刚提交的状态。
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
      // 结算在局部 scores 上原子计算；players.score 是本手起始缓存，
      // this.scores 到 finishHand 才提交，不能把两本不同时刻的账混加。
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
