import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__mj = {};
await import('../mock/proto.js');
await import('../mock/data.js');
await import('../mock/userdata.js');
await import('../mockjs/browser_entry.mjs');
await import('../mock/server.js');

const P = globalThis.__mj.proto;
const mock = globalThis.__mj.server;
mock.quiet(true);

function request(gameType, subtype = 0) {
  const match = P.W().v(1, gameType);
  if (subtype) match.v(2, subtype);
  match.v(3, 7).v(4, 1).v(6, 1);
  return P.W().s(1, match.bytes()).bytes();
}

function route(gameType, subtype) {
  const session = mock.createSession();
  mock.handlers[20403](session, request(gameType, subtype));
  clearTimeout(session.matchTimer);
  session.matchTimer = null;
}

test('the matchmaking request from the original mode page decides 3p/4p and east-only/hanchan', () => {
  mock.config.playersExplicit = false;
  mock.config.matchLengthExplicit = false;
  route(4002, 1);
  assert.equal(mock.config.players, 3);
  assert.equal(mock.config.matchLength, 'hanchan');

  route(4001, 0);
  assert.equal(mock.config.players, 4);
  assert.equal(mock.config.matchLength, 'east');
});

test('an explicit URL mode parameter takes priority over the original mode page request', () => {
  mock.config.players = 4;
  mock.config.matchLength = 'east';
  mock.config.playersExplicit = true;
  mock.config.matchLengthExplicit = true;
  route(4002, 1);
  assert.equal(mock.config.players, 4);
  assert.equal(mock.config.matchLength, 'east');

  mock.config.playersExplicit = false;
  mock.config.matchLengthExplicit = false;
});

test('unimplemented requests return an explicit failure instead of an empty success', () => {
  const session = mock.createSession();
  const frames = mock.dispatch(session, P.W().v(2, 199998).v(11, 42).s(3, new Uint8Array(0)).bytes());
  assert.equal(frames.length, 1);
  const wrapper = P.dict(frames[0]);
  assert.equal(wrapper[2], 199999);
  assert.equal(wrapper[11], 42);
  assert.equal(P.dict(wrapper[3])[1], 1);
});

test('a fixed seed fixes both the table ID and the AI appearance', async () => {
  const oldSeed = mock.config.seed;
  const oldMatchDelay = mock.config.matchDelay;
  const oldEngineStartDelay = mock.config.engineStartDelay;
  mock.config.seed = 123456;
  mock.config.matchDelay = 0;
  mock.config.engineStartDelay = 1_000;
  async function formTable() {
    const session = mock.createSession();
    session.socket = { readyState: 1, _deliver() {} };
    mock.handlers[20403](session, request(4001, 0));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const table = structuredClone(session.table);
    session.destroy();
    return table;
  }
  try {
    const first = await formTable();
    const second = await formTable();
    assert.equal(first.seed, 123456);
    assert.deepEqual(second, first);
  } finally {
    mock.config.seed = oldSeed;
    mock.config.matchDelay = oldMatchDelay;
    mock.config.engineStartDelay = oldEngineStartDelay;
  }
});


test('each table draws its first dealer from the match seed and the engine starts with that dealer', async () => {
  const old = { ...mock.config };
  Object.assign(mock.config, { matchDelay: 0, engineStartDelay: 0, speed: 0 });
  async function startTable(seed) {
    mock.config.seed = seed;
    const session = mock.createSession();
    session.resume({ readyState: 1, _deliver() {} });
    mock.handlers[20403](session, request(4001, 0));
    const end = Date.now() + 5_000;
    while (!session.riichi?.engine) {
      if (Date.now() > end) throw new Error('timed out waiting for the engine');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const dealers = { table: session.table.startDealer, engine: session.riichi.engine.startDealer, dealer: session.riichi.engine.dealerSeat };
    session.destroy();
    return dealers;
  }
  try {
    const seen = new Set();
    for (let seed = 1; seed <= 24; seed++) {
      const { table, engine, dealer } = await startTable(seed);
      assert.ok(Number.isInteger(table) && table >= 0 && table < 4, `seed ${seed}: startDealer ${table}`);
      assert.equal(engine, table);
      assert.equal(dealer, table);
      seen.add(table);
    }
    assert.ok(seen.size > 1, 'the human seat must not always be the first dealer');
  } finally {
    for (const key of ['seed', 'matchDelay', 'engineStartDelay', 'speed']) mock.config[key] = old[key];
  }
});

test('cancelling matchmaking after the table is formed does not start a ghost game from a delayed task', async () => {
  const oldMatchDelay = mock.config.matchDelay;
  const oldEngineStartDelay = mock.config.engineStartDelay;
  mock.config.matchDelay = 0;
  mock.config.engineStartDelay = 30;
  const session = mock.createSession();
  session.socket = { readyState: 1, _deliver() {} };
  try {
    mock.handlers[20403](session, request(4001, 0));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(session.engineStartTimer);
    mock.handlers[20405](session);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(session.tableId, 0);
    assert.equal(session.engineStartTimer, null);
    assert.equal(session.riichi, null);
  } finally {
    session.destroy();
    mock.config.matchDelay = oldMatchDelay;
    mock.config.engineStartDelay = oldEngineStartDelay;
  }
});

test('brief consecutive profile queries respond normally and must not reset an ongoing game by disconnecting', () => {
  const session = mock.createSession();
  const closed = [];
  session.socket = { readyState: 1, close(...args) { closed.push(args); } };
  session.tableId = 123;
  const query = P.W().s(2, P.W().v(1, 39).bytes()).bytes();
  try {
    const responses = Array.from({ length: 20 }, () => mock.handlers[100141](session, query));
    assert.deepEqual(closed, []);
    assert.ok(responses.every((frames) => frames.length > 0 && frames[0][0] === 100142));
    assert.equal(session.tableId, 123);
  } finally {
    session.destroy();
  }
});
