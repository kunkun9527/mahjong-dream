// Profile host shared by the Node service and the in-browser backend: loads the single JSON profile into the mock lobby
// data, wires session callbacks, and implements the save editor. Storage (file or localStorage) is supplied by the caller.
import { ECONOMY_CATALOG } from './economy_catalog.mjs';
import { initializeOfflineEconomy } from './economy.mjs';
import { createDefaultProfile, normalizeProfile, recordMatch, sanitizeNickname } from './profile.mjs';

// Names come from the client's BagItemTable + LanguageTbUIEN.
export const EDITABLE_ITEMS = [
  { id: 60001, name: 'Coins' },
  { id: 60002, name: 'Crystals' },
  { id: 60008, name: 'Gacha Coupon' },
  { id: 60009, name: 'Gacha Badge' },
  { id: 60010, name: 'Gift Fragment' },
  { id: 60011, name: 'Costume Tickets' },
  { id: 60012, name: 'Honor Points' },
  { id: 60007, name: 'Rename Card' },
];
// LanguageTbUIEN names of Rank2*CfgTb; level 11 is shown as "Novice" there, but it is 1st Dan.
export const RANK_NAMES = ['Novice', 'D3', 'D2', 'D1', 'C2', 'C1', 'B2', 'B1', 'A2', 'A1', '1st Dan', '2nd Dan', '3rd Dan',
  '4th Dan', '5th Dan', '6th Dan', '7th Dan', '8th Dan', '9th Dan', '10th Dan', 'Legend', 'Legend+'];
// A disconnected player's table waits this long; after that the AI finishes the match and it counts as played.
export const AWAY_LIMIT_MS = 5 * 60_000;
const MAX_ITEM_COUNT = 2_147_483_647;
const MAX_RANK_POINT = 999_999;
const RANK_MODES = { yonma: 'yonmaRanks', sanma: 'sanmaRanks' };

export function bytesToBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function base64ToBytes(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function integerIn(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  return number;
}

/**
 * mock: globalThis.__mj.server; profile: normalized profile object, mutated in place;
 * persist(urgent): stores host.snapshot(); urgent writes (save editor) are awaited, others may be batched.
 */
export function createProfileHost(mock, profile, { persist, log = () => {} }) {
  let session = null;

  /** Load profile.lobbyData into the mock; returns true when the one-time grant or content normalization changed the save. */
  function load() {
    if (profile.lobbyData) mock.setUserdata(base64ToBytes(profile.lobbyData));
    else mock.reset();
    const upgraded = initializeOfflineEconomy(profile, mock.userdata, ECONOMY_CATALOG.defaults);
    // Content unlocks are normalized on every load (idempotent), separate from the one-time currency grant.
    const normalized = mock.userdata.normalizeOfflineContent() !== null;
    mock.updateNickname(profile.nickname);
    mock.updateRanks(profile.ranks);
    mock.updateProfileStats(profile.stats);
    if (upgraded || normalized) profile.lobbyData = bytesToBase64(mock.userdata.serialize());
    return upgraded || normalized;
  }

  /** Current profile including the latest lobby data, in the userdata/profile.json format. */
  function snapshot() {
    profile.lobbyData = bytesToBase64(mock.userdata.serialize());
    return normalizeProfile(profile);
  }

  function attach(sess) {
    session = sess;
    return wire(sess);
  }

  function wire(sess) {
    sess.localProfile = profile;
    sess.internalState = { ...profile.settings.internalState };
    sess.onNicknameChange = (nickname) => {
      profile.nickname = nickname;
      persist();
    };
    sess.onSettingsChange = (state) => {
      profile.settings.internalState = { ...state };
      persist();
    };
    sess.onFinalResult = (scores, engine) => {
      const result = recordMatch(profile, {
        players: engine.playersN,
        matchLength: engine.matchLength,
        scores,
        matchStats: engine.matchStats,
        roomId: sess.rankRoomId,
      });
      // Match-end coins are credited to the real wallet (inventory currency); rank, record and wallet changes are sent in the f24 of the leave-table reply,
      // otherwise the client's rank bar and balance on the room-select page stay at their old values.
      result.changes = [
        mock.userdata.changeInventory([{ dtype: 6, id: ECONOMY_CATALOG.defaults.coinId, count: result.coins }]),
        ...mock.updateRanks(profile.ranks),
        mock.updateProfileStats(profile.stats),
      ];
      log(`[local] Match finished: ${engine.playersN}-player ${engine.matchLength}, place ${result.placement}, rank PT ${result.rank.change >= 0 ? '+' : ''}${result.rank.change}, coins +${result.coins}`);
      persist();
      return result;
    };
    sess.onMatchFinish = () => persist();
    // Keep the unfinished match in the save so a reload or restart can rebuild it (lastSeen moves only with touch()).
    sess.onMatchRecord = (record) => {
      profile.activeMatch = record ? { ...record, lastSeen: profile.activeMatch?.lastSeen || Date.now() } : null;
      persist();
    };
    return sess;
  }

  /** The player is here (any client message); the away clock of a saved match counts from the last call. */
  function touch(now = Date.now()) {
    if (profile.activeMatch) profile.activeMatch.lastSeen = now;
  }

  /** Play a saved match out with the AI in a detached session and leave a notice for the player. */
  async function settleAway(record) {
    const sess = wire(mock.createSession());
    let outcome = null;
    const onFinalResult = sess.onFinalResult;
    sess.onFinalResult = (scores, engine) => (outcome = onFinalResult(scores, engine));
    try {
      await mock.restoreMatch(sess, record, { finish: true });
    } catch (error) {
      log(`[local] Could not finish previous match from its record; discarded: ${error.message}`);
    }
    profile.activeMatch = null;
    const ordinal = (n) => n + ([, 'st', 'nd', 'rd'][n] || 'th');
    profile.notice = outcome
      ? `You were away for more than 5 minutes, so the AI finished your last match: ${ordinal(outcome.placement)} place, `
        + `${outcome.rank.change >= 0 ? '+' : ''}${outcome.rank.change} PT, +${outcome.coins} coins.`
      : 'You were away for more than 5 minutes, so the AI finished your last match.';
    log(`[local] ${profile.notice}`);
    await persist(true);
    return { settled: true, notice: profile.notice };
  }

  /**
   * Recover the saved unfinished match. Away longer than maxAgeMs: the AI finishes it now (no session needed).
   * Otherwise, with a session: rebuild it there, frozen on the player's turn until the client re-syncs the table.
   * Returns null (nothing to do), { settled, notice } or { restored, remainingMs, ready }.
   */
  async function recoverMatch({ session: target = null, maxAgeMs = AWAY_LIMIT_MS, now = Date.now() } = {}) {
    const record = profile.activeMatch;
    if (!record) return null;
    const age = Math.max(0, now - record.lastSeen);
    if (age > maxAgeMs) return settleAway(record);
    if (!target) return null;
    try {
      const ready = mock.restoreMatch(target, record);
      return { restored: true, remainingMs: maxAgeMs - age, ready };
    } catch (error) {
      log(`[local] Match record could not be restored; discarded: ${error.message}`);
      profile.activeMatch = null;
      persist();
      return null;
    }
  }

  function inMatch() {
    return !!(session && (session.tableId || session.matchTimer || session.liveMatch()));
  }

  function state() {
    return {
      nickname: profile.nickname,
      ranks: {
        yonma: { level: profile.ranks.yonma.level, point: profile.ranks.yonma.point },
        sanma: { level: profile.ranks.sanma.level, point: profile.ranks.sanma.point },
      },
      rankNames: RANK_NAMES.slice(0, ECONOMY_CATALOG.yonmaRanks.length),
      items: EDITABLE_ITEMS.map((item) => ({ ...item, count: mock.userdata.inventoryCount(6, item.id) })),
      games: { yonma: profile.stats.yonma.games, sanma: profile.stats.sanma.games },
      inMatch: inMatch(),
      notice: profile.notice,
    };
  }

  function edit(changes) {
    // Validate everything before changing any state.
    const nickname = changes.nickname == null ? null : sanitizeNickname(changes.nickname);
    if (changes.nickname != null && !nickname) throw new RangeError('Nickname must not be blank');
    const ranks = {};
    for (const [mode, table] of Object.entries(RANK_MODES)) {
      const rank = changes.ranks?.[mode];
      if (!rank) continue;
      ranks[mode] = {
        level: integerIn(rank.level, 1, ECONOMY_CATALOG[table].length, 'Rank level'),
        point: integerIn(rank.point, 0, MAX_RANK_POINT, 'Rank PT'),
      };
    }
    const deltas = [];
    for (const [id, count] of Object.entries(changes.items || {})) {
      const item = EDITABLE_ITEMS.find((entry) => entry.id === Number(id));
      if (!item) throw new RangeError(`Item ${id} is not editable`);
      const target = integerIn(count, 0, MAX_ITEM_COUNT, item.name);
      deltas.push({ dtype: 6, id: item.id, count: target - mock.userdata.inventoryCount(6, item.id) });
    }
    mock.userdata.changeInventory(deltas);
    if (nickname) {
      profile.nickname = nickname;
      mock.updateNickname(nickname);
    }
    Object.assign(profile.ranks, ranks);
    mock.updateRanks(profile.ranks);
  }

  function resetStats() {
    profile.stats = createDefaultProfile().stats;
    mock.updateProfileStats(profile.stats);
  }

  /** Replace the whole profile; on any failure the previous profile and lobby data stay active. */
  function replace(next) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new TypeError('Save file must be a JSON object');
    if (next.lobbyData != null && typeof next.lobbyData !== 'string') throw new TypeError('lobbyData must be a base64 string');
    const before = JSON.parse(JSON.stringify(snapshot()));
    const assign = (value) => {
      for (const key of Object.keys(profile)) delete profile[key];
      Object.assign(profile, normalizeProfile(value));
    };
    try {
      assign(next);
      load();
    } catch (error) {
      assign(before);
      load();
      throw error;
    }
    if (session) session.internalState = { ...profile.settings.internalState };
  }

  const ACTIONS = {
    state: () => state(),
    export: () => snapshot(),
    edit: (request) => { edit(request.changes || {}); return state(); },
    resetStats: () => { resetStats(); return state(); },
    // An imported save never resumes the match it may have been exported in.
    import: (request) => {
      const next = request.profile;
      replace(next && typeof next === 'object' && !Array.isArray(next) ? { ...next, activeMatch: null } : next);
      return state();
    },
    reset: () => { replace(createDefaultProfile()); return state(); },
    dismissNotice: () => { profile.notice = null; return state(); },
  };
  const READ_ONLY = new Set(['state', 'export']);
  const ALLOWED_IN_MATCH = new Set(['state', 'export', 'dismissNotice']);

  /** Save editor entry used by both hosts: { action, changes?, profile? } -> result. Writes are refused during a match. */
  async function handle(request) {
    const action = ACTIONS[request?.action];
    if (!action) throw new RangeError('Unknown action');
    if (!ALLOWED_IN_MATCH.has(request.action) && inMatch()) throw new Error('Finish or leave the current match first');
    const result = action(request);
    if (!READ_ONLY.has(request.action)) await persist(true);
    return result;
  }

  return { load, snapshot, attach, handle, touch, recoverMatch, get session() { return session; } };
}
