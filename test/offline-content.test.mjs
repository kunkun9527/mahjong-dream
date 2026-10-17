import test from 'node:test';
import assert from 'node:assert/strict';

await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');
const { proto: P, data, userdata: U, server: mock } = globalThis.__mj;
mock.quiet(true);

function connect(session) {
  const received = [];
  session.socket = { readyState: 1, _deliver(bytes) { received.push(P.dict(bytes)); } };
  return received;
}

function request(session, mid, seq, payload = new Uint8Array()) {
  return mock.dispatch(session, P.W().v(2, mid).v(11, seq).s(3, payload).bytes()).map((frame) => P.dict(frame));
}

for (const [name, mid] of [
  ['好友搜索', 100040], ['好友操作', 100042], ['查看他人资料', 100143], ['抽卡招募', 100300],
  ['充值下单', 100400], ['Steam 付费', 100420], ['排行榜', 100505], ['活动领奖', 100508],
  ['活动列表', 100510], ['邮件领取', 100602], ['公告已读', 100701], ['新手签到', 102100],
  ['创建友人房', 20500], ['加入友人房', 20502], ['创建自设赛事', 21001], ['报名奖励赛事', 21403],
]) {
  test(`离线入口${name}（${mid}）明确失败并推送原生离线提示，不发空成功`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const session = mock.createSession();
    const received = connect(session);
    const [response] = request(session, mid, 41);
    assert.equal(response[2], mid + 1);
    assert.equal(response[11], 41, '失败响应回显 RPC 序号');
    assert.equal(response[8], 1, '外层传输状态仍为成功');
    assert.equal(P.dict(response[3])[1], 10, '业务结果为 CommandServiceNotAvailable');
    t.mock.timers.tick(1);
    assert.equal(received.length, 1);
    assert.equal(received[0][2], 20106);
    assert.equal(received[0][11], undefined, '提示是主动通知，不带 RPC 序号');
    assert.equal(P.fromUtf8(P.dict(received[0][3])[1]), '离线模式下此功能不可用');
  });
}

for (const mid of [21407, 21409, 21411]) {
  test(`奖励赛事查询 ${mid} 返回原客户端有提示的“比赛信息已失效”错误码 30`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const session = mock.createSession();
    const received = connect(session);
    const [response] = request(session, mid, 7);
    assert.equal(response[2], mid + 1);
    assert.equal(P.dict(response[3])[1], 30);
    t.mock.timers.tick(1);
    assert.equal(received.length, 0, '原客户端自带提示，不再额外推送');
  });
}

test('已接通的本地功能不被离线入口表拦截', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = mock.createSession();
  const received = connect(session);
  const [rankList] = request(session, 21401, 3);
  assert.equal(rankList[2], 21402, '进大厅自动请求的赛事列表仍回放录制数据');
  const [signIn] = request(session, 100620, 4);
  assert.equal(signIn[2], 100621);
  assert.notEqual(P.dict(signIn[3] || new Uint8Array())[1], 10);
  t.mock.timers.tick(1);
  assert.equal(received.length, 0);
});

function headIds(user) {
  return P.parse(user.row(U.DT_HEAD, '0')).filter(([field]) => field === 1)
    .map(([, , bytes]) => P.dict(bytes)[1]).sort((a, b) => a - b);
}

function warriorLevels(user) {
  const module = user.modules[U.DT_MAHJONG_WARRIOR];
  return module.order.map((key) => {
    const inner = P.dict(P.get(module.rows[key], 3));
    return [inner[5], inner[7]];
  });
}

function basicWarriorLevels(user) {
  return P.parse(user.row(U.DT_BASIC_INFO, '0')).filter(([field]) => field === 20)
    .map(([, , bytes]) => P.dict(bytes)[2]);
}

test('内容归一补齐原配置全部 19 个头像，保留已有头像的获得时间', () => {
  const user = new U.UserData(P.b64decode(data.userdataB64), 1);
  const before = new Map(P.parse(user.row(U.DT_HEAD, '0')).map(([, , bytes]) => [P.dict(bytes)[1], bytes]));
  assert.equal(before.size, 5);
  const changes = user.normalizeOfflineContent();
  assert.ok(changes?.[U.DT_HEAD]);
  assert.deepEqual(headIds(user), Array.from({ length: 19 }, (_, i) => 1001 + i));
  const after = new Map(P.parse(user.row(U.DT_HEAD, '0')).map(([, , bytes]) => [P.dict(bytes)[1], bytes]));
  for (const [id, bytes] of before) assert.deepEqual(after.get(id), bytes, `头像 ${id} 原记录不变`);
  const packet = P.parse(user.changePacket(changes)).filter(([field]) => field === 2).map(([, , bytes]) => P.dict(bytes));
  assert.ok(packet.some((module) => module[1] === U.DT_HEAD && module[2] === user.modules[U.DT_HEAD].version));
});

test('内容归一把低好感度旧档的雀士升到最高级并觉醒，且幂等、不动货币', () => {
  const seed = new U.UserData(P.b64decode(data.userdataB64), 1);
  const module = seed.modules[U.DT_MAHJONG_WARRIOR];
  const key = module.order[0];
  const lowered = P.setVarint(P.setVarint(P.get(module.rows[key], 3), 5, 2), 7, 0);
  seed.setRow(U.DT_MAHJONG_WARRIOR, key, P.setBytes(module.rows[key], 3, lowered));
  const basic = P.W();
  for (const [field, wire, value] of P.parse(seed.row(U.DT_BASIC_INFO, '0'))) {
    if (field === 20 && P.dict(value)[1] === 3) basic.s(20, P.setVarint(value, 2, 1));
    else P.reencode(basic, field, wire, value);
  }
  seed.setRow(U.DT_BASIC_INFO, '0', basic.bytes());
  const user = new U.UserData(seed.serialize(), 1);
  const coins = user.inventoryCount(6, 60001);

  const changes = user.normalizeOfflineContent();
  assert.ok(changes[U.DT_MAHJONG_WARRIOR]);
  assert.ok(changes[U.DT_BASIC_INFO]);
  assert.ok(warriorLevels(user).every(([level, arousal]) => level === 6 && arousal === 1));
  assert.ok(basicWarriorLevels(user).every((level) => level === 6));
  assert.equal(basicWarriorLevels(user).length, 10);
  assert.equal(user.inventoryCount(6, 60001), coins);

  const versions = Object.fromEntries(Object.entries(user.modules).map(([dt, m]) => [dt, m.version]));
  assert.equal(user.normalizeOfflineContent(), null, '已归一的档案不再产生增量');
  assert.deepEqual(Object.fromEntries(Object.entries(user.modules).map(([dt, m]) => [dt, m.version])), versions);
});

test('立直结算本人席位回显好感度等级，不再显示 Lv.0', async () => {
  const { GameEngine } = await import('../mockjs/engine.mjs');
  const { RiichiMsg } = await import('../mockjs/proto_enum.mjs');
  const stops = [];
  const engine = new GameEngine({
    players: 4, speed: 0, seed: 11, maxHands: 1, autoHuman: true, selfLoveLevel: 6,
    emit: (event, payload) => { if (event === RiichiMsg.ENtfGameStop) stops.push(payload); },
  });
  await engine.start();
  assert.ok(stops.length >= 1);
  for (const stop of stops) {
    assert.equal(stop.userInfos[0].level, 6);
    assert.equal(stop.userInfos[0].oldLevel, 6);
    assert.ok(stop.userInfos.slice(1).every((info) => info.level === 0 && info.oldLevel === 0));
  }
});
