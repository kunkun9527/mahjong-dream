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

test('default quiet mode skips heartbeats but still logs normal, unsupported and error request results, without payloads', (t) => {
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

test('debug mode still shows heartbeat results', (t) => {
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
  ['friend search', 100040], ['friend action', 100042], ['view other profile', 100143], ['gacha recruit', 100300],
  ['top-up order', 100400], ['Steam payment', 100420], ['leaderboard', 100505], ['event reward claim', 100508],
  ['event list', 100510], ['mail claim', 100602], ['notice read', 100701], ['newbie sign-in', 102100],
  ['create friend room', 20500], ['join friend room', 20502], ['create custom event', 21001], ['sign up reward event', 21403],
]) {
  test(`offline entry ${name} (${mid}) fails explicitly and pushes the native offline notice, without sending an empty success`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const session = mock.createSession();
    const received = connect(session);
    const [response] = request(session, mid, 41);
    assert.equal(response[2], mid + 1);
    assert.equal(response[11], 41, 'failed response echoes the RPC sequence number');
    assert.equal(response[8], 1, 'outer transport status is still success');
    assert.equal(P.dict(response[3])[1], 10, 'business result is CommandServiceNotAvailable');
    t.mock.timers.tick(1);
    assert.equal(received.length, 1);
    assert.equal(received[0][2], 20106);
    assert.equal(received[0][11], undefined, 'the notice is an unsolicited push, without an RPC sequence number');
    assert.equal(P.fromUtf8(P.dict(received[0][3])[1]), 'This feature is unavailable in offline mode');
  });
}

for (const [name, gameType, roomId] of [
  ['Sichuan blood battle', 5022, 502205], ['Sichuan blood flow', 5021, 502107], ['Red Dragon blood flow', 5023, 502306],
  ['Dou dizhu', 4101, 1], ['Guandan', 4111, 1],
]) {
  test(`non-riichi mode ${name} (${gameType}) shows the offline-unavailable notice and does not form a table`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const session = mock.createSession();
    const received = connect(session);
    const srm = P.W().v(1, gameType).v(3, 11).v(4, roomId).bytes();
    const [response] = request(session, 20403, 9, P.W().s(1, srm).bytes());
    assert.equal(response[2], 20404);
    assert.equal(P.dict(response[3])[1], 10, 'business result is CommandServiceNotAvailable');
    t.mock.timers.tick(5_000);
    assert.deepEqual(received.map((frame) => frame[2]), [20106], 'only the offline notice is pushed, not 20408 (table formation)');
    assert.equal(session.tableId, 0);
  });
}

for (const mid of [21407, 21409, 21411]) {
  test(`reward event query ${mid} returns error code 30 (match info expired), which the original client already shows a notice for`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const session = mock.createSession();
    const received = connect(session);
    const [response] = request(session, mid, 7);
    assert.equal(response[2], mid + 1);
    assert.equal(P.dict(response[3])[1], 30);
    t.mock.timers.tick(1);
    assert.equal(received.length, 0, 'the original client already shows its own notice, so nothing extra is pushed');
  });
}

test('connected local features are not blocked by the offline entry table', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = mock.createSession();
  const received = connect(session);
  const [rankList] = request(session, 21401, 3);
  assert.equal(rankList[2], 21402, 'the event list auto-requested on entering the lobby still replays recorded data');
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

test('content normalization fills in all 19 avatars from the original config and keeps the obtained time of existing avatars', () => {
  const user = new U.UserData(P.b64decode(data.userdataB64), 1);
  const before = new Map(P.parse(user.row(U.DT_HEAD, '0')).map(([, , bytes]) => [P.dict(bytes)[1], bytes]));
  assert.equal(before.size, 5);
  const changes = user.normalizeOfflineContent();
  assert.ok(changes?.[U.DT_HEAD]);
  assert.deepEqual(headIds(user), Array.from({ length: 19 }, (_, i) => 1001 + i));
  const after = new Map(P.parse(user.row(U.DT_HEAD, '0')).map(([, , bytes]) => [P.dict(bytes)[1], bytes]));
  for (const [id, bytes] of before) assert.deepEqual(after.get(id), bytes, `avatar ${id} original record unchanged`);
  const packet = P.parse(user.changePacket(changes)).filter(([field]) => field === 2).map(([, , bytes]) => P.dict(bytes));
  assert.ok(packet.some((module) => module[1] === U.DT_HEAD && module[2] === user.modules[U.DT_HEAD].version));
});

test('content normalization raises the warriors in low-affection old saves to max level and awakens them, idempotently and without touching currency', () => {
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
  assert.equal(user.normalizeOfflineContent(), null, 'an already normalized profile produces no further changes');
  assert.deepEqual(Object.fromEntries(Object.entries(user.modules).map(([dt, m]) => [dt, m.version])), versions);
});

test('riichi settlement shows the affection level of the local seat, no longer Lv.0', async () => {
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


test('lobby reward promo normalization: no sign-in, newbie, gift or event popups, balance and monthly-card benefits unchanged, idempotent per day', () => {
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
  for (const [dt, bytes] of Object.entries(stable)) assert.deepEqual(ud.modules[dt].serialize(), bytes, 'does not change rewards, inventory, shop, monthly-card benefits or other modules');
  assert.equal(ud.normalizeOfflineLobby(now + 60), null);
  const versions = Object.fromEntries(ud.moduleOrder.map((dt) => [dt, ud.modules[dt].version]));
  assert.equal(ud.normalizeOfflineLobby(now + 120), null);
  for (const [dt, version] of Object.entries(versions)) assert.equal(ud.modules[dt].version, version);
  const tomorrow = new U.UserData(P.b64decode(data.userdataB64), 10_000_001);
  tomorrow.normalizeOfflineLobby(now + 86400);
  assert.ok(tomorrow.modules[34].version > ud.modules[34].version, 'an old snapshot reloaded across a day change must also invalidate the client cache from the previous day');
});

test('international lobby rolls over on UTC+9: popup flag refreshes at Beijing 23:00, and Beijing midnight does not refresh again', () => {
  const ud = new U.UserData(P.b64decode(data.userdataB64), 10_000_001);
  const beforeMidnight = Date.UTC(2026, 9, 22, 14, 55) / 1000;
  const afterMidnight = Date.UTC(2026, 9, 22, 15, 5) / 1000;
  ud.normalizeOfflineLobby(beforeMidnight);
  const previousVersion = ud.modules[34].version;
  const stable = Object.fromEntries([6, 29, 39].map((dt) => [dt, ud.modules[dt].serialize()]));
  ud.setRow(44, '0', P.W().v(6, beforeMidnight).bytes());
  const changes = ud.normalizeOfflineLobby(afterMidnight);
  const clientDay = (timestamp) => Math.floor((timestamp + 9 * 3600) / 86400);
  assert.equal(clientDay(P.get(ud.row(34, '0'), 1)), clientDay(afterMidnight), 'same UTC+9 date as the international CanSignIn, so no sign-in popup is queued');
  assert.equal(P.get(ud.row(44, '0'), 6), afterMidnight, 'newbie sign-in uses the same client day boundary');
  assert.ok(changes[34] && changes[44]);
  assert.ok(ud.modules[34].version > previousVersion, 'old cache is invalidated after the day change');
  for (const [dt, bytes] of Object.entries(stable)) assert.deepEqual(ud.modules[dt].serialize(), bytes, 'does not suppress the popup by granting rewards or changing the monthly card');
  const afterBeijingMidnight = Date.UTC(2026, 9, 22, 16, 5) / 1000;
  assert.equal(ud.normalizeOfflineLobby(afterBeijingMidnight), null, 'Beijing midnight is not a new day for the international version');
});

test('event and notice red-dot normalization: removes matching red dots, marks built-in and server notices as read, keeps other modules and unknown fields', () => {
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
  for (const id of [9999, 8888, 234567, 1, 2, 3, 4, 5, 6, 100001, 100004, 100005, 100006, 100007, 100008, 100009]) assert.ok(ids.includes(id), `notice ${id} marked read`);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(P.get(notice, 2), serverNotice, 'only the read list changes, notice data is not deleted');
  assert.equal(P.fromUtf8(P.get(notice, 99)), 'unknown');
  for (const [dt, bytes] of Object.entries(stable)) assert.deepEqual(ud.modules[dt].serialize(), bytes);
  assert.equal(ud.normalizeOfflineLobby(), null);
  const restored = new U.UserData(ud.serialize(), ud.uid);
  assert.equal(restored.normalizeOfflineLobby(), null, 'still idempotent after serialize and reload');
});

test('profile query and re-login refresh reward popup flags, old client versions get the complete new module, cross-day queries no longer pop rewards', () => {
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
    assert.ok(P.parse(module).some(([f]) => f === 3), 'returns the new module rows, not the empty response of an old version');
    const badgeQuery = P.W();
    for (const dt of [27, 33]) badgeQuery.s(2, P.W().v(1, dt).v(2, oldBadges[dt]).bytes());
    const [badges] = mock.handlers[100141](session, badgeQuery.bytes());
    const modules = P.parse(badges[1]).filter(([f]) => f === 3).map(([, , value]) => value);
    assert.equal(modules.length, 2);
    for (const value of modules) {
      const dt = P.get(value, 1);
      assert.ok(P.get(value, 2) > oldBadges[dt], `DT${dt} old red-dot cache version invalidated`);
      assert.ok(P.parse(value).some(([f]) => f === 3), `DT${dt} sent the complete new module`);
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
