import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDefaultProfile, loadProfile, saveProfile } from '../local/profile.mjs';
import { initializeOfflineEconomy } from '../mockjs/economy.mjs';

await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
const { proto: P, data, userdata: U } = globalThis.__mj;
// This is the mock configuration for the migration mechanism; the real rank / currency mapping is verified separately by the shop catalog regression.
const config = { coinId: 60001, currencyIds: [60001, 60002, 60008], rank: { level: 17, point: 2000 } };
const fresh = () => new U.UserData(P.b64decode(data.userdataB64), 10_000_001);

test('an old profile gets a one-time grant and is upgraded to three- and four-player, without overwriting nickname, equipment or stats', () => {
  const profile = createDefaultProfile();
  profile.nickname = '测试档案';
  profile.stats.sanma.games = 7;
  profile.ranks.sanma = { level: 2, point: 0 };
  profile.coins = 500;
  const user = fresh();
  const equipment = user.row(1, '0');
  const before = user.inventoryCount(6, config.coinId);
  assert.equal(initializeOfflineEconomy(profile, user, config), true);
  assert.equal(profile.coins, 999999);
  assert.deepEqual(profile.ranks, { yonma: config.rank, sanma: config.rank });
  assert.equal(user.inventoryCount(6, config.coinId), before * 100);
  assert.equal(user.inventoryCount(6, 60002), 999999);
  assert.equal(user.inventoryCount(6, 60008), 999999);
  assert.equal(profile.nickname, '测试档案');
  assert.equal(profile.stats.sanma.games, 7);
  assert.deepEqual(user.row(1, '0'), equipment);
});

test('after a new profile is granted, spending and a rank demotion, then an atomic save and reload, do not refill the grant again', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mj-economy-'));
  try {
    const profile = createDefaultProfile();
    const user = fresh();
    initializeOfflineEconomy(profile, user, config);
    user.changeInventory([{ dtype: 6, id: 60002, count: -999900 }]);
    profile.ranks.yonma = { level: 16, point: 1300 };
    profile.coins = 321;
    profile.lobbyData = Buffer.from(user.serialize()).toString('base64');
    await saveProfile(directory, profile);
    const loaded = await loadProfile(directory);
    const restored = new U.UserData(Buffer.from(loaded.lobbyData, 'base64'), user.uid);
    assert.equal(initializeOfflineEconomy(loaded, restored, config), false);
    assert.equal(restored.inventoryCount(6, 60002), 99);
    assert.deepEqual(loaded.ranks.yonma, { level: 16, point: 1300 });
    assert.equal(loaded.coins, 321);
    assert.deepEqual(restored.serialize(), user.serialize());
    assert.deepEqual(await fs.readdir(directory), ['profile.json']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('when migrated balance overflows, both the profile and lobby snapshot are unchanged, and no completion marker is written', () => {
  const profile = createDefaultProfile();
  const user = fresh();
  user.setRow(6, config.coinId, P.W().v(1, config.coinId).v(2, Number.MAX_SAFE_INTEGER).bytes());
  const beforeProfile = structuredClone(profile);
  const beforeUser = user.serialize();
  assert.throws(() => initializeOfflineEconomy(profile, user, config), RangeError);
  assert.deepEqual(profile, beforeProfile);
  assert.deepEqual(user.serialize(), beforeUser);
});
