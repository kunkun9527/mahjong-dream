import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GameEngine } from '../mockjs/engine.mjs';
import { encodeMsg } from '../mockjs/pb.mjs';
import { buildRiichiReloadScene } from '../mockjs/riichi_reload.mjs';
import { PlayAction, RiichiMsg, Result } from '../mockjs/proto_enum.mjs';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function drawWindow(t, opts = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const engine = new GameEngine({ players: 3, speed: 0, ...opts });
  engine.players = [0, 1, 2].map((seat) => ({ seat, isHuman: seat === 0, timeBank: 20,
    hand: seat === 0 ? [111] : [], drawnTile: seat === 0 ? 111 : null,
    discards: [], melds: [], score: 35000, waits: [], riichi: false }));
  t.after(() => { engine.finished = true; engine.cancelPending(); });
  engine.expectDraw(0, true, [PlayAction.Normal]);
  return engine;
}

for (const honba of [0, 1]) {
  test('庄家' + (honba ? '连庄' : '首局') + '发牌期间不扣时，客户端真正启用倒计时后才获得完整8+20', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const engine = new GameEngine({ players: 4, speed: 0, seed: 777, deferHumanClock: true });
    engine.honba = honba;
    engine.awaitTurn = async () => {};
    t.after(() => { engine.finished = true; engine.submitPrepare(); engine.cancelPending(); });
    const hand = engine.runHand();
    await flush(); engine.submitPrepare(); await hand;
    const id = engine.humanClockState().id;
    const turn = engine.waitHuman('draw');
    t.mock.timers.tick(30_000);
    assert.deepEqual(engine.humanClockState(), { id, baseMs: 8000, extraMs: 20000, running: false });
    assert.equal(engine.markHumanReady(id + 1), false, '旧或未来窗口不能起表');
    engine.setHumanPresent(false);
    assert.equal(engine.markHumanReady(id), false, '真实断线时不能起表');
    engine.setHumanPresent(true);
    assert.equal(engine.humanClockState().running, false, '连接恢复不代替可操作确认');
    assert.equal(engine.markHumanReady(id), true);
    assert.deepEqual(engine.humanClockState(), { id, baseMs: 8000, extraMs: 20000, running: true });
    t.mock.timers.tick(3000);
    assert.equal(engine.markHumanReady(id), false, '重复确认不能重置计时');
    assert.equal(engine.humanClockState().baseMs, 5000);
    t.mock.timers.tick(5000);
    assert.equal(engine.humanClockState().extraMs, 20000);
    t.mock.timers.tick(20_000 + 3000);
    await turn;
    assert.equal(engine.players[0].timeBank, 0);
    engine.expectDraw(0, true, [PlayAction.Normal]);
    assert.equal(engine.humanClockState().baseMs, 5000);
    assert.equal(engine.markHumanReady(id), false, '上一窗口的迟到确认不能启动下一巡');
    assert.equal(engine.humanClockState().running, false);
    assert.equal(engine.markHumanReady(engine.humanClockState().id), true);
  });
}

test('宿主投影发布开窗、精确冻结、续时和清理，不包含网络宽限', async (t) => {
  const states = [];
  const engine = drawWindow(t, { onHumanClock: (state) => states.push(state) });
  assert.deepEqual(states.at(-1), { id: 1, baseMs: 5000, extraMs: 20000, running: true });
  const turn = engine.waitHuman('draw');
  t.mock.timers.tick(7001);
  engine.setHumanPresent(false);
  assert.deepEqual(states.at(-1), { id: 1, baseMs: 0, extraMs: 17999, running: false });
  t.mock.timers.tick(600000);
  assert.equal(engine.humanClockState().extraMs, 17999);
  engine.setHumanPresent(true);
  assert.equal(states.at(-1).running, true);
  assert.equal(states.at(-1).extraMs, 17999);
  engine.submitDraw({ action: PlayAction.Normal, card: 111 });
  await turn;
  assert.equal(states.at(-1), null);
  assert.equal(engine.humanClockState(), null);
});

test('普通决策基础5秒加剩余备用，10秒操作扣5秒备用，重演不补时间', async (t) => {
  const engine = drawWindow(t);
  assert.equal(engine.humanTime().leftTimer, 20);
  const first = engine.waitHuman('draw');
  t.mock.timers.tick(10_000);
  assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: 111 }), Result.Succ);
  await first;
  assert.equal(engine.players[0].timeBank, 15);
  // 拔北、暗杠后的下一次等待只重置基础段，备用仍是本小局共享余量。
  engine.expectDraw(0, true, [PlayAction.Normal]);
  assert.equal(engine.humanTime().leftTimer, 15);
  const record = engine.matchRecord();
  const restored = new GameEngine({ players: 3, speed: 0, replayLog: record });
  restored.players = engine.players;
  restored.expectDraw(0, true, [PlayAction.Normal]);
  await restored.waitHuman('draw');
  restored.expectDraw(0, true, [PlayAction.Normal]);
  assert.equal(restored.humanTime().leftTimer, 15);
});

for (const players of [3, 4]) {
  test(`${players}人重复准备不跨小局：庄家下一局延迟准备仍保留完整8+20秒`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const frames = [];
    const engine = new GameEngine({ players, speed: 0, seed: 1,
      emit: (id, data) => frames.push([id, data]) });
    // Only isolate turn execution; exercise the actual per-hand prepare and clock opening path.
    engine.awaitTurn = async () => {};
    t.after(() => { engine.finished = true; engine.submitPrepare(); engine.cancelPending(); });
    const first = engine.runHand();
    await flush();
    engine.submitPrepare();
    await first;
    engine.submitPrepare(); // Duplicate after the first hand has already started.
    engine.cancelPending();
    frames.length = 0;
    const next = engine.runHand();
    await flush();
    assert.equal(frames.some(([id]) => id === RiichiMsg.ENtfGameStart), false);
    for (const delay of [12_000, 13_000, 60_000]) {
      t.mock.timers.tick(delay);
      await flush();
      assert.equal(frames.some(([id]) => id === RiichiMsg.ENtfGameStart), false);
      assert.equal(engine.humanClockState(), null, '未准备不能提前扣基础或备用时间');
      assert.equal(engine.players[0].timeBank, 20);
    }
    engine.submitPrepare();
    await next;
    assert.deepEqual(engine.humanClockState(), { id: 2, baseMs: 8000, extraMs: 20000, running: true });
    assert.equal(engine.matchRecord().filter(([kind]) => kind === 'p').length, 2);
  });

  test(`${players}人未准备超过15秒或断线重连都不能强制开牌`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const frames = [];
    const engine = new GameEngine({ players, speed: 0, seed: 1,
      emit: (id, data) => frames.push([id, data]) });
    engine.awaitTurn = async () => {};
    t.after(() => { engine.finished = true; engine.submitPrepare(); engine.cancelPending(); });
    if (players === 4) engine.submitPrepare(); // Before this hand: not a credit for a future hand.
    const hand = engine.runHand();
    await flush();
    t.mock.timers.tick(30_000);
    await flush();
    engine.setHumanPresent(false);
    t.mock.timers.tick(600_000);
    engine.setHumanPresent(true);
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(frames.some(([id]) => id === RiichiMsg.ENtfGameStart), false);
    assert.equal(engine.humanClockState(), null);
    engine.submitPrepare();
    await hand;
    assert.equal(engine.humanTime().defaultMinTimeout, 8);
    assert.equal(engine.humanTime().leftTimer, 20);
  });
}

for (const players of [3, 4]) {
  test(`${players}人实际浏览器bundle：准备不串局，连庄首手8秒，非庄家5秒`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const context = vm.createContext({ console, Date, setTimeout, clearTimeout, TextEncoder, TextDecoder });
    vm.runInContext(readFileSync(new URL('../mock/riichi.js', import.meta.url), 'utf8'), context);
    const engine = new context.__mj.riichi.GameEngine({ players, speed: 0, seed: 1 });
    engine.awaitTurn = async () => {};
    t.after(() => { engine.finished = true; engine.submitPrepare(); engine.cancelPending(); });
    for (const honba of [0, 1]) {
      engine.honba = honba;
      const hand = engine.runHand();
      await flush();
      t.mock.timers.tick(60_000);
      assert.equal(engine.humanClockState(), null, '实际bundle未准备也不能强制开局');
      engine.submitPrepare();
      await hand;
      assert.equal(engine.humanClockState().baseMs, 8000);
      assert.equal(engine.humanClockState().extraMs, 20000);
      engine.submitPrepare(); // Must not authorize the following hand.
      engine.cancelPending();
    }
    engine.dealerSeat = 1;
    const hand = engine.runHand();
    engine.submitPrepare();
    await hand;
    engine.expectDraw(0, true, [PlayAction.Normal]);
    assert.equal(engine.humanClockState().baseMs, 5000);
    engine.finished = true;
    engine.cancelPending();
  });
}

test('准备通知同步触发的合法请求不丢失，也不能多预存一次', async (t) => {
  const frames = [];
  const engine = new GameEngine({ players: 3, speed: 0, seed: 1,
    emit: (id) => {
      frames.push(id);
      if (id === RiichiMsg.ENtfToPrepare) { engine.submitPrepare(); engine.submitPrepare(); }
    } });
  engine.awaitTurn = async () => {};
  t.after(() => { engine.finished = true; engine.submitPrepare(); engine.cancelPending(); });
  await engine.runHand();
  assert.ok(frames.includes(RiichiMsg.ENtfGameStart));
  assert.deepEqual(engine.matchRecord(), [['p']]);
});

test('准备阶段切换托管或停止会话可释放等待，不依赖强制开局计时器', async (t) => {
  const engine = new GameEngine({ players: 3, speed: 0, seed: 1 });
  t.after(() => engine.cancelPending());
  const prepare = engine.waitPrepare();
  engine.setHumanAutoplay(true);
  await prepare;
  assert.equal(engine._prepareWaiter, null);
  assert.deepEqual(engine.matchRecord(), [['p']]);
  engine.setHumanAutoplay(false);
  const stopped = engine.waitPrepare();
  engine.finished = true;
  engine.submitPrepare();
  await stopped;
  assert.equal(engine._prepareWaiter, null);
  assert.deepEqual(engine.matchRecord(), [['p']], '停止不能额外记录一次准备');
  const restoring = new GameEngine({ players: 3, speed: 0, replayLog: [] });
  const interrupted = restoring.waitPrepare();
  restoring.finished = true;
  restoring.submitPrepare();
  await flush();
  assert.equal(restoring._prepareWaiter, null, '重演让出执行权期间停止，不能随后新建等待');
  await interrupted;
  assert.deepEqual(restoring.matchRecord(), []);
});

test('庄家首手8+20秒，额外3秒不扣备用；随后决策和非庄家仍是5秒', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const frames = [];
  const engine = new GameEngine({ players: 3, speed: 0, seed: 1, emit: (id, data) => frames.push([id, data]) });
  engine.awaitTurn = async () => {};
  t.after(() => { engine.finished = true; engine.cancelPending(); });
  void engine.runHand();
  engine.submitPrepare();
  await flush();
  const start = frames.find(([id]) => id === RiichiMsg.ENtfGameStart)[1];
  assert.equal(start.defaultMinTimeout, 5);
  assert.equal(start.leftTimer, 20);
  assert.equal(engine.humanTime().leftTimer, start.leftTimer);
  assert.equal(engine.humanTime().defaultMinTimeout, 8);
  const opening = engine.waitHuman('draw');
  t.mock.timers.tick(10_000);
  engine.setHumanPresent(false);
  assert.equal(engine.humanTime().bankLeft, 18, '庄家首手10秒应仅消耗2秒备用');
  t.mock.timers.tick(60_000);
  assert.equal(engine.humanTime().bankLeft, 18, '断线不能重新赠送庄家首手时间');
  engine.setHumanPresent(true);
  assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: engine.players[0].drawnTile }), Result.Succ);
  await opening;
  assert.equal(engine.players[0].timeBank, 18, '动作提交按首手8秒基础结算共享备用');
  engine.expectDraw(0, true, [PlayAction.Normal]);
  assert.equal(engine.humanTime().defaultMinTimeout, 5, '庄家后续摸牌不再补3秒');
  engine.cancelPending();
  engine.dealerSeat = 1;
  const next = engine.runHand();
  engine.submitPrepare();
  await flush();
  // Non-dealer has no human window until their own decision, not at GameStart.
  assert.equal(engine.humanClockState(), null);
  await next;
  engine.expectDraw(0, true, [PlayAction.Normal]);
  assert.equal(engine.humanTime().defaultMinTimeout, 5, '非庄家首个决策不补3秒');
  assert.equal(engine.humanTime().leftTimer, 20);
});

for (const elapsed of [2_000, 10_000, 15_000]) {
  test(`已计时${elapsed}ms后反复冻结：快照不扣断线时间，恢复不补基础或备用`, async (t) => {
    const engine = drawWindow(t);
    engine.handIndex = 1;
    // 打开一个新的普通等待。
    engine.cancelPending();
    engine.expectDraw(0, true, [PlayAction.Normal]);
    const turn = engine.waitHuman('draw');
    t.mock.timers.tick(elapsed);
    engine.setHumanPresent(false);
    const frozen = engine.humanTime();
    const start = encodeMsg('NtfGameStart', { zhuangSeat: 0, remainDuiCardNum: 40, defaultMinTimeout: 5,
      userInfos: engine.players.map((p) => ({ seat: p.seat, handCards: p.hand, score: p.score, initScore: p.score })) });
    engine.isFuriten = () => false;
    engine.furitenTypes = () => [];
    engine.buildTingInfos = () => [];
    engine.riichiFutureAnkanKinds = () => [];
    t.mock.timers.tick(60_000);
    assert.deepEqual(engine.humanTime(), frozen);
    const own = buildRiichiReloadScene([[RiichiMsg.ENtfGameStart, start]], engine).offline2OnlineUserInfos[0];
    assert.equal(own.leftTimer, frozen.leftTimer);
    assert.equal(own.DefaultMinTimeout, frozen.defaultMinTimeout);
    engine.setHumanPresent(true);
    engine.setHumanPresent(true); // 心跳不能再给一次时间。
    t.mock.timers.tick(1_000);
    engine.setHumanPresent(false);
    t.mock.timers.tick(60_000);
    engine.setHumanPresent(true);
    assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: 111 }), Result.Succ);
    await turn;
    assert.equal(engine.players[0].timeBank, 20 - Math.max(0, (elapsed + 1_000) / 1000 - 5));
  });
}

test('通知到waitHuman之间的时间也属于同一窗口；早到请求只扣至提交时', async (t) => {
  const engine = drawWindow(t);
  engine.handIndex = 1;
  engine.cancelPending();
  engine.expectDraw(0, true, [PlayAction.Normal]);
  t.mock.timers.tick(7_000);
  engine.submitDraw({ action: PlayAction.Normal, card: 111 });
  t.mock.timers.tick(2_000);
  await engine.waitHuman('draw');
  assert.equal(engine.players[0].timeBank, 18);
});

test('断线客户端的超时上行不能推进冻结窗口，恢复同步后才接受动作', async (t) => {
  const engine = drawWindow(t);
  const turn = engine.waitHuman('draw');
  t.mock.timers.tick(2_000);
  engine.setHumanPresent(false);
  const frozen = engine.humanTime();
  t.mock.timers.tick(60_000);
  assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: 111, isTimeout: true }), Result.Fail_InvalidSequence);
  assert.deepEqual(engine.humanTime(), frozen);
  assert.ok(engine._pending);
  engine.setHumanPresent(true);
  assert.equal(engine.submitDraw({ action: PlayAction.Normal, card: 111 }), Result.Succ);
  await turn;
  assert.equal(engine.players[0].timeBank, 20);
});

test('暂停后的超时只等待余量加网络宽限，旧任务不能影响下个窗口', { timeout: 1000 }, async (t) => {
  const engine = drawWindow(t);
  engine.handIndex = 1;
  engine.cancelPending();
  engine.expectDraw(0, true, [PlayAction.Normal]);
  const turn = engine.waitHuman('draw');
  t.mock.timers.tick(7_000);
  engine.setHumanPresent(false);
  t.mock.timers.tick(600_000);
  engine.setHumanPresent(true);
  t.mock.timers.tick(20_999);
  assert.ok(engine._pending);
  t.mock.timers.tick(1);
  await turn;
  assert.equal(engine.players[0].timeBank, 0);
  engine.expectDraw(0, true, [PlayAction.Normal]);
  void engine.waitHuman('draw');
  t.mock.timers.tick(7_999);
  assert.ok(engine._pending);
});
