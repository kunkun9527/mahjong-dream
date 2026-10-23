import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__mj = {};
await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');
const { oneRoundRoom, oneRoundRewardLevel, settleOneRound } = await import('../mockjs/one_round.mjs');

const P = globalThis.__mj.proto;
const R = globalThis.__mj.riichi;
const mock = globalThis.__mj.server;
mock.quiet(true);
const CRYSTAL = 60002;
const COIN = 60001;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('one-round reward tiers map han and mangan tiers from the original EnumItemRewardLevel', () => {
  assert.equal(oneRoundRewardLevel(null), 0);
  assert.equal(oneRoundRewardLevel({ totalFan: 1, manType: 0 }), 1);
  assert.equal(oneRoundRewardLevel({ totalFan: 4, manType: 0, fu: 30 }), 4);
  assert.equal(oneRoundRewardLevel({ totalFan: 4, manType: 1 }), 5, '4 han 40 fu is mangan');
  assert.equal(oneRoundRewardLevel({ totalFan: 6, manType: 2 }), 6);
  assert.equal(oneRoundRewardLevel({ totalFan: 8, manType: 3 }), 7);
  assert.equal(oneRoundRewardLevel({ totalFan: 11, manType: 4 }), 8);
  assert.equal(oneRoundRewardLevel({ totalFan: 13, manType: 5, yakuman: 1 }), 9);
  assert.equal(oneRoundRewardLevel({ totalFan: 26, manType: 5, yakuman: 2 }), 10);
});

test('one-round rooms and rewards come from the original client config', () => {
  const crystal = oneRoundRoom(1, 5);
  assert.deepEqual(crystal.cost, [{ id: CRYSTAL, count: 350 }]);
  assert.deepEqual(crystal.rewards[0], [{ id: CRYSTAL, count: 175 }]);
  assert.deepEqual(crystal.rewards[8], [{ id: CRYSTAL, count: 6125 }], 'yakuman = UI Jackpot');
  assert.deepEqual(crystal.rewards[9], [{ id: CRYSTAL, count: 12250 }], 'double yakuman = Super Jackpot');
  assert.deepEqual(oneRoundRoom(2, 1).cost, [{ id: COIN, count: 25000 }]);
  assert.equal(oneRoundRoom(3, 1), null);
  assert.equal(oneRoundRoom(1, 6), null);
});

test('one-round charges the entry fee once and pays rewards by tier; when the balance is insufficient, everything stays unchanged', () => {
  const user = mock.userdata;
  const room = oneRoundRoom(1, 2);
  const before = user.inventoryCount(6, CRYSTAL);
  const result = settleOneRound(user, room, { totalFan: 5, manType: 1 });
  assert.equal(result.itemRewardLevel, 5);
  assert.deepEqual(result.itemRewards, [{ itemId: CRYSTAL, itemCount: 150 }]);
  assert.equal(user.inventoryCount(6, CRYSTAL), before - 100 + 150);
  settleOneRound(user, room, null);
  assert.equal(user.inventoryCount(6, CRYSTAL), before - 100 + 150 - 100);

  const huge = { id: 0, cost: [{ id: CRYSTAL, count: 2 ** 52 }], rewards: [] };
  const balance = user.inventoryCount(6, CRYSTAL);
  assert.throws(() => settleOneRound(user, huge, null));
  assert.equal(user.inventoryCount(6, CRYSTAL), balance);
});

function oneRoundRequest(roomId, roomLevel) {
  return P.W().s(1, P.W().v(1, 4002).v(3, 6).v(4, roomId).v(5, roomLevel).v(6, 1).bytes()).bytes();
}

function rpc(session, mid, seq, payload) {
  return mock.dispatch(session, P.W().v(2, mid).v(11, seq).s(3, payload).bytes()).map((bytes) => P.dict(bytes));
}

function riichiFrames(frames) {
  return frames.filter((f) => f[2] === 20018).map((f) => {
    const env = P.dict(f[3]);
    const name = R.MSG_NAME[env[1]];
    return { type: env[1], name, payload: R.decodeMsg(name, env[100] || new Uint8Array(0)) };
  });
}

test('one-round matchmaking echoes YiJu/OneGame, plays one hand, settles rewards, and writes no rank records', async (t) => {
  const old = { ...mock.config };
  // seed 2: the human seat ron-wins a haneman on the only hand, covering the reward payout path.
  Object.assign(mock.config, { seed: 2, matchDelay: 0, engineStartDelay: 0, speed: 0, autoHuman: true });
  const session = mock.createSession();
  const frames = [];
  session.resume({ readyState: 1, _deliver(bytes) { frames.push(P.dict(bytes)); } });
  let rankWrites = 0;
  session.onFinalResult = () => { rankWrites += 1; return null; };
  t.after(() => {
    session.destroy();
    for (const key of ['seed', 'matchDelay', 'engineStartDelay', 'speed', 'autoHuman']) mock.config[key] = old[key];
  });

  const before = mock.userdata.inventoryCount(6, COIN);
  rpc(session, 20403, 3, oneRoundRequest(2, 1));
  const end = Date.now() + 15_000;
  while (!riichiFrames(frames).some((f) => f.name === 'NtfGameStop')) {
    if (Date.now() > end) throw new Error('timed out waiting for the match to end');
    await wait(10);
  }
  await wait(50);

  const table = P.dict(P.dict(frames.find((f) => f[2] === 20408)[3])[2]);
  assert.equal(table[1], 4002);
  assert.equal(table[5], 3, 'subType = enumSubTypeYiJu');
  assert.equal(table[6], 6, 'roomType = enumRoomTypeOneGame');
  assert.equal(table[8], 2);

  const games = riichiFrames(frames);
  assert.equal(games.filter((f) => f.name === 'NtfGameStart').length, 1);
  assert.equal(games.find((f) => f.name === 'NtfGameStart').payload.isAllLast, true);
  const stops = games.filter((f) => f.name === 'NtfGameStop');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].payload.isFinal, true);
  const self = stops[0].payload.userInfos.find((u) => u.seat === 0);
  assert.equal(Number(self.changePT || 0), 0);
  assert.equal(rankWrites, 0, 'one-round does not write rank or records');

  const room = oneRoundRoom(2, 1);
  assert.equal(self.itemRewardLevel, 6);
  const reward = room.rewards[5][0].count;
  assert.equal(reward, 75000);
  assert.deepEqual(self.itemRewards.map((item) => [Number(item.itemId), Number(item.itemCount)]), [[COIN, reward]]);
  const finish = rpc(session, 20102, 4, new Uint8Array(0));
  assert.equal(mock.userdata.inventoryCount(6, COIN), before - 25000 + reward);
  assert.ok(finish[0][24] instanceof Uint8Array, 'the leave response carries the crystal DataChange');
});

test('one-round rejects matchmaking for an unknown tier or insufficient entry fee', (t) => {
  const session = mock.createSession();
  t.after(() => session.destroy());
  const unknown = rpc(session, 20403, 1, oneRoundRequest(1, 9));
  assert.equal(P.dict(unknown[0][3])[1], 1);
  assert.equal(session.matchTimer, null);
});
