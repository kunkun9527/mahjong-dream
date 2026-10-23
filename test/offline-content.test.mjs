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

test('默认quiet不记心跳，仍记录普通、未支持和异常请求结果，不输出载荷', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', () => {});
  const session = mock.createSession();
  t.after(() => session.destroy());
  const privatePayload = P.W().s(1, 'private-payload-fixture').bytes();
  request(session, 20019, 71);
  request(session, 20102, 74);
  request(session, 987654, 72, privatePayload);
  mock.handlers[987650] = () => { throw new Error('handler-fixture'); };
  t.after(() => { delete mock.handlers[987650]; });
  request(session, 987650, 73, privatePayload);
  const results = lines.filter((line) => line.startsWith('[request] '))
    .map((line) => JSON.parse(line.slice('[request] '.length)));
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((entry) => [entry.mid, entry.seq, entry.result]), [
    [20102, 74, 'handled'], [987654, 72, 'unsupported'], [987650, 73, 'error'],
  ]);
  assert.deepEqual(results[1].replies, [987655]);
  assert.doesNotMatch(lines.join('\n'), /private-payload-fixture/);
});

test('调试模式仍可查看心跳结果', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const session = mock.createSession();
  mock.quiet(false);
  t.after(() => { session.destroy(); mock.quiet(true); });
  request(session, 20019, 75);
  assert.ok(lines.some((line) => line.startsWith('[request] ') && line.includes('20019')));
});

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

for (const [name, gameType, roomId] of [
  ['四川血战', 5022, 502205], ['四川血流', 5021, 502107], ['红中血流', 5023, 502306],
  ['斗地主', 4101, 1], ['掼蛋', 4111, 1],
]) {
  test(`非立直玩法${name}（${gameType}）匹配提示离线不可用，不组桌`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const session = mock.createSession();
    const received = connect(session);
    const srm = P.W().v(1, gameType).v(3, 11).v(4, roomId).bytes();
    const [response] = request(session, 20403, 9, P.W().s(1, srm).bytes());
    assert.equal(response[2], 20404);
    assert.equal(P.dict(response[3])[1], 10, '业务结果为 CommandServiceNotAvailable');
    t.mock.timers.tick(5_000);
    assert.deepEqual(received.map((frame) => frame[2]), [20106], '只推离线提示，不推 20408 组桌');
    assert.equal(session.tableId, 0);
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


test('大厅奖励推广归一：不弹签到、新手、礼包或活动，不改变余额与月卡权益，且按天幂等', () => {
  const ud = new U.UserData(P.b64decode(data.userdataB64), 10_000_001);
  const now = Math.floor(Date.UTC(2026, 9, 23, 12) / 1000);
  ud.setRow(44, '0', P.W().v(1, 123).v(3, 2).v(4, now - 10000).v(5, now + 10000).v(6, 1).s(99, 'newbie').bytes());
  const act = P.W().v(1, 7).v(3, 2).s(4, P.W().v(1, 1).v(2, 1).bytes()).s(99, 'activity').bytes();
  ud.setRow(31, '0', P.W().s(1, P.W().v(1, 7).s(2, act).bytes()).v(99, 42).bytes());
  const pay = P.W().v(2, 100).v(7, now - 1000).v(8, now + 100000).bytes();
  ud.setRow(29, '0', pay);
  const stable = Object.fromEntries(ud.moduleOrder.filter((dt) => ![31, 33, 34, 43, 44].includes(dt)).map((dt) => [dt, ud.modules[dt].serialize()]));
  const signHistory = P.parse(ud.row(34, '0')).filter(([f]) => f !== 1);
  const changes = ud.normalizeOfflineLobby(now);
  assert.deepEqual(Object.keys(changes).sort(), ['31', '33', '34', '43', '44']);
  assert.equal(P.get(ud.row(34, '0'), 1), now);
  assert.deepEqual(P.parse(ud.row(34, '0')).filter(([f]) => f !== 1), signHistory);
  assert.equal(P.get(ud.row(44, '0'), 6), now);
  assert.deepEqual(P.parse(ud.row(44, '0')).filter(([f]) => f !== 6), P.parse(P.W().v(1, 123).v(3, 2).v(4, now - 10000).v(5, now + 10000).s(99, 'newbie').bytes()));
  const cleanAct = P.get(P.get(ud.row(31, '0'), 1), 2);
  assert.equal(P.get(cleanAct, 4), undefined);
  assert.equal(P.get(cleanAct, 3), 2);
  assert.equal(P.fromUtf8(P.get(cleanAct, 99)), 'activity');
  assert.equal(P.get(ud.row(31, '0'), 99), 42);
  for (const key of ud.modules[43].order) {
    const row = P.get(ud.row(43, key), 3);
    assert.equal(P.get(row, 11), 0);
    assert.equal(P.get(row, 8), now);
  }
  for (const [dt, bytes] of Object.entries(stable)) assert.deepEqual(ud.modules[dt].serialize(), bytes, '不改动奖励、背包、商店、月卡权益或其他模块');
  assert.equal(ud.normalizeOfflineLobby(now + 60), null);
  const versions = Object.fromEntries(ud.moduleOrder.map((dt) => [dt, ud.modules[dt].version]));
  assert.equal(ud.normalizeOfflineLobby(now + 120), null);
  for (const [dt, version] of Object.entries(versions)) assert.equal(ud.modules[dt].version, version);
  const tomorrow = new U.UserData(P.b64decode(data.userdataB64), 10_000_001);
  tomorrow.normalizeOfflineLobby(now + 86400);
  assert.ok(tomorrow.modules[34].version > ud.modules[34].version, '旧快照跨日重新加载也必须使昨日客户端缓存失效');
});

test('国际版大厅按 UTC+9 换日：北京时间 23 点刷新弹窗标记，零点不重复刷新', () => {
  const ud = new U.UserData(P.b64decode(data.userdataB64), 10_000_001);
  const beforeMidnight = Date.UTC(2026, 9, 22, 14, 55) / 1000;
  const afterMidnight = Date.UTC(2026, 9, 22, 15, 5) / 1000;
  ud.normalizeOfflineLobby(beforeMidnight);
  const previousVersion = ud.modules[34].version;
  const stable = Object.fromEntries([6, 29, 39].map((dt) => [dt, ud.modules[dt].serialize()]));
  ud.setRow(44, '0', P.W().v(6, beforeMidnight).bytes());
  const changes = ud.normalizeOfflineLobby(afterMidnight);
  const clientDay = (timestamp) => Math.floor((timestamp + 9 * 3600) / 86400);
  assert.equal(clientDay(P.get(ud.row(34, '0'), 1)), clientDay(afterMidnight), '与国际版 CanSignIn 的 UTC+9 日期相同，不再排入签到弹窗');
  assert.equal(P.get(ud.row(44, '0'), 6), afterMidnight, '新手签到使用同一客户端换日边界');
  assert.ok(changes[34] && changes[44]);
  assert.ok(ud.modules[34].version > previousVersion, '换日后旧缓存失效');
  for (const [dt, bytes] of Object.entries(stable)) assert.deepEqual(ud.modules[dt].serialize(), bytes, '不通过发奖励或修改月卡压制弹窗');
  const afterBeijingMidnight = Date.UTC(2026, 9, 22, 16, 5) / 1000;
  assert.equal(ud.normalizeOfflineLobby(afterBeijingMidnight), null, '北京时间零点并不是国际版的新一天');
});

test('活动和公告红点归一：移除对应红点、标记内置及服务器公告已读，保留其他模块与未知字段', () => {
  const ud = new U.UserData(P.b64decode(data.userdataB64), 10_000_001);
  const entry = (id, type) => P.W().v(1, id).s(2, P.W().v(1, type).v(2, id).v(3, 1).s(99, 'dot').bytes()).bytes();
  const kept = entry(81, 10);
  ud.setRow(27, '0', P.W().s(1, entry(71, 3)).s(1, entry(72, 4)).s(1, kept).v(98, 7).bytes());
  const serverNotice = P.W().v(1, 234567).v(2, 1).v(5, 123).s(99, 'notice').bytes();
  ud.setRow(33, '0', P.W().v(1, 9999).packed(1, [8888, 100001]).s(2, serverNotice).s(99, 'unknown').bytes());
  const stable = Object.fromEntries(ud.moduleOrder.filter((dt) => ![27, 33, 34, 43, 44].includes(dt)).map((dt) => [dt, ud.modules[dt].serialize()]));
  const before = ud.modules[27].version;
  const changes = ud.normalizeOfflineLobby();
  assert.ok(changes[27] && changes[33]);
  assert.ok(ud.modules[27].version > before);
  assert.deepEqual(P.parse(ud.row(27, '0')), [[1, 2, kept], [98, 0, 7]]);
  const notice = ud.row(33, '0');
  const ids = P.unpack(P.get(notice, 1));
  for (const id of [9999, 8888, 234567, 1, 2, 3, 4, 5, 6, 100001, 100004, 100005, 100006, 100007, 100008, 100009]) assert.ok(ids.includes(id), `公告 ${id} 已读`);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(P.get(notice, 2), serverNotice, '只改已读列表，不删公告数据');
  assert.equal(P.fromUtf8(P.get(notice, 99)), 'unknown');
  for (const [dt, bytes] of Object.entries(stable)) assert.deepEqual(ud.modules[dt].serialize(), bytes);
  assert.equal(ud.normalizeOfflineLobby(), null);
  const restored = new U.UserData(ud.serialize(), ud.uid);
  assert.equal(restored.normalizeOfflineLobby(), null, '序列化后重载也幂等');
});

test('资料查询和重新登录前刷新奖励弹窗标记，旧客户端版本得到完整新模块，跨日查询不再弹奖励', () => {
  const before = mock.userdata.serialize();
  const session = mock.createSession();
  try {
    const ud = new U.UserData(P.b64decode(data.userdataB64), mock.uid);
    const oldVersion = ud.modules[34].version;
    ud.setRow(27, '0', P.W().s(1, P.W().v(1, 19).s(2, P.W().v(1, 3).v(2, 19).v(3, 1).bytes()).bytes()).bytes());
    ud.setRow(33, '0', P.W().v(1, 9999).bytes());
    const oldBadges = Object.fromEntries([27, 33].map((dt) => [dt, ud.modules[dt].version]));
    mock.setUserdata(ud.serialize());
    mock.handlers[20001](session);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(P.get(mock.userdata.row(34, '0'), 1) - now) < 3);
    const query = P.W().s(2, P.W().v(1, 34).v(2, oldVersion).bytes()).bytes();
    const [frame] = mock.handlers[100141](session, query);
    const module = P.parse(frame[1]).find(([f]) => f === 3)[2];
    assert.ok(P.get(module, 2) > oldVersion);
    assert.ok(P.parse(module).some(([f]) => f === 3), '返回新模块行，而非旧版本的空响应');
    const badgeQuery = P.W();
    for (const dt of [27, 33]) badgeQuery.s(2, P.W().v(1, dt).v(2, oldBadges[dt]).bytes());
    const [badges] = mock.handlers[100141](session, badgeQuery.bytes());
    const modules = P.parse(badges[1]).filter(([f]) => f === 3).map(([, , value]) => value);
    assert.equal(modules.length, 2);
    for (const value of modules) {
      const dt = P.get(value, 1);
      assert.ok(P.get(value, 2) > oldBadges[dt], `DT${dt} 旧红点缓存版本失效`);
      assert.ok(P.parse(value).some(([f]) => f === 3), `DT${dt} 下发完整新模块`);
    }
    assert.equal(P.get(mock.userdata.row(27, '0'), 1), undefined);
    assert.ok(P.unpack(P.get(mock.userdata.row(33, '0'), 1)).includes(100009));
    mock.userdata.setRow(34, '0', P.setVarint(mock.userdata.row(34, '0'), 1, now - 86400));
    mock.handlers[100141](session, query);
    assert.ok(Math.abs(P.get(mock.userdata.row(34, '0'), 1) - now) < 3);
  } finally {
    mock.setUserdata(before);
    session.destroy();
  }
});
