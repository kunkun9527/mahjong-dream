import test from 'node:test';
import assert from 'node:assert/strict';
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

test('开局只有基础5秒加备用20秒，10秒操作扣5秒备用，重演不补时间', async (t) => {
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

test('坐庄的GameStart与实际窗口公告一致，首手仍保留基础5秒', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const frames = [];
  const engine = new GameEngine({ players: 3, speed: 0, seed: 1, emit: (id, data) => frames.push([id, data]) });
  t.after(() => { engine.finished = true; engine.cancelPending(); });
  engine.submitPrepare();
  void engine.runHand();
  await flush();
  const start = frames.find(([id]) => id === RiichiMsg.ENtfGameStart)[1];
  assert.equal(start.defaultMinTimeout, 5);
  assert.equal(start.leftTimer, 20);
  assert.equal(engine.humanTime().leftTimer, start.leftTimer);
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
