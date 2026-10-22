import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProfile } from '../mockjs/profile.mjs';
import { createProfileHost } from '../mockjs/profile_host.mjs';
import { ECONOMY_CATALOG as C } from '../mockjs/economy_catalog.mjs';

globalThis.location = { search: '' };
await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');
const mock = globalThis.__mj.server;
mock.quiet(true);

function freshHost(profile = createDefaultProfile()) {
  const writes = [];
  const host = createProfileHost(mock, profile, { persist: (urgent) => { writes.push(urgent ? 'urgent' : 'soon'); } });
  host.load();
  return { host, profile, writes };
}

test('新档案载入时执行一次性补给，修改器状态列出段位名与可编辑货币', async () => {
  const { host } = freshHost();
  const state = await host.handle({ action: 'state' });
  assert.equal(state.rankNames.length, C.yonmaRanks.length);
  assert.equal(state.rankNames[16], '7th Dan');
  assert.deepEqual(state.ranks.yonma, C.defaults.rank);
  assert.equal(state.items.find((item) => item.id === 60002).count, 999_999);
  assert.equal(state.inMatch, false);
});

test('修改昵称、段位和货币后同步到大厅数据并立即存档', async () => {
  const { host, profile, writes } = freshHost();
  const state = await host.handle({ action: 'edit', changes: {
    nickname: '  新雀士 ', ranks: { yonma: { level: 20, point: 3900 } }, items: { 60001: 5, 60007: 3 },
  } });
  assert.equal(profile.nickname, '新雀士');
  assert.deepEqual(profile.ranks.yonma, { level: 20, point: 3900 });
  assert.deepEqual(profile.ranks.sanma, C.defaults.rank);
  assert.equal(mock.userdata.inventoryCount(6, 60001), 5);
  assert.equal(state.items.find((item) => item.id === 60007).count, 3);
  assert.deepEqual(writes, ['urgent']);
  // The lobby rows the client reads must change too, not only the JSON profile.
  const P = globalThis.__mj.proto;
  assert.equal(P.get(mock.userdata.row(41, '4001'), 1), 20);
  const basic = P.get(mock.userdata.row(1, '0'), 1);
  assert.equal(new TextDecoder().decode(P.get(basic, 1)), '新雀士');
});

test('任一字段非法时整次修改都不生效', async () => {
  const { host, profile, writes } = freshHost();
  const before = host.snapshot().lobbyData;
  for (const changes of [
    { nickname: ' \n ' },
    { ranks: { yonma: { level: 0, point: 0 } } },
    { ranks: { sanma: { level: 23, point: 0 } } },
    { ranks: { yonma: { level: 5, point: -1 } } },
    { items: { 60002: 1, 60001: -1 } },
    { items: { 60002: 1.5 } },
    { items: { 99999: 1 } },
    { nickname: 'ok', items: { 60002: 2 ** 31 } },
  ]) {
    await assert.rejects(host.handle({ action: 'edit', changes }));
  }
  assert.ok(host.snapshot().lobbyData === before, 'lobby data must be unchanged');
  assert.equal(profile.nickname, 'player');
  assert.deepEqual(writes, []);
});

test('重置战绩只清空对局记录，保留段位与货币', async () => {
  const { host, profile } = freshHost();
  profile.stats.yonma.games = 7;
  profile.stats.sanma.byLength.east.games = 2;
  profile.ranks.yonma = { level: 19, point: 100 };
  const state = await host.handle({ action: 'resetStats' });
  assert.deepEqual(state.games, { yonma: 0, sanma: 0 });
  assert.deepEqual(profile.stats, createDefaultProfile().stats);
  assert.deepEqual(profile.ranks.yonma, { level: 19, point: 100 });
});

test('导出再导入可还原存档；坏存档导入失败时保留当前档案', async () => {
  const { host, profile } = freshHost();
  await host.handle({ action: 'edit', changes: { nickname: 'Exported', items: { 60010: 42 } } });
  const exported = JSON.parse(JSON.stringify(await host.handle({ action: 'export' })));
  await host.handle({ action: 'reset' });
  assert.equal(profile.nickname, 'player');
  assert.equal(mock.userdata.inventoryCount(6, 60010), 999_999);

  await host.handle({ action: 'import', profile: exported });
  assert.equal(profile.nickname, 'Exported');
  assert.equal(mock.userdata.inventoryCount(6, 60010), 42);

  // Restoring reloads the lobby rows, so module versions may advance; compare the profile and the wallet instead.
  const withoutLobby = () => JSON.stringify({ ...host.snapshot(), lobbyData: null });
  const before = withoutLobby();
  await assert.rejects(host.handle({ action: 'import', profile: [] }));
  await assert.rejects(host.handle({ action: 'import', profile: { ...exported, nickname: 'Broken', lobbyData: 123 } }));
  await assert.rejects(host.handle({ action: 'import', profile: { ...exported, nickname: 'Broken', lobbyData: '!!!not base64' } }));
  assert.equal(withoutLobby(), before);
  assert.equal(profile.nickname, 'Exported');
  assert.equal(mock.userdata.inventoryCount(6, 60010), 42);
});

test('对局或匹配进行中拒绝修改存档，但允许查看与导出', async () => {
  const { host, profile } = freshHost();
  const session = host.attach(mock.createSession());
  session.tableId = 12;
  assert.equal((await host.handle({ action: 'state' })).inMatch, true);
  assert.ok((await host.handle({ action: 'export' })).lobbyData);
  for (const action of ['edit', 'resetStats', 'import', 'reset']) {
    await assert.rejects(host.handle({ action, changes: { nickname: 'x' }, profile: {} }), /match/);
  }
  assert.equal(profile.nickname, 'player');
  session.tableId = 0;
  await host.handle({ action: 'edit', changes: { nickname: 'after' } });
  assert.equal(profile.nickname, 'after');
  await assert.rejects(host.handle({ action: 'drop' }), /Unknown action/);
});
