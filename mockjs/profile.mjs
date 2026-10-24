// Pure profile rules shared by the Node service and the browser host; file IO lives in local/profile.mjs.
import { ECONOMY_CATALOG as C } from './economy_catalog.mjs';

export const PROFILE_VERSION = 1;

const RANK_NAMES = ['Novice', 'D3', 'D2', 'D1', 'C2', 'C1', 'B2', 'B1', 'A2', 'A1', '1st Dan', '2nd Dan', '3rd Dan', '4th Dan', '5th Dan', '6th Dan', '7th Dan', '8th Dan', '9th Dan', '10th Dan', 'Legend', 'Legend+'];

export function applyRankResult(profile, { players, matchLength, placement, roomId = null }) {
  const key = players === 3 ? 'sanma' : 'yonma';
  const table = C[`${key}Ranks`];
  const rank = profile.ranks[key];
  const oldLevel = Math.min(table.length, Math.max(1, Math.trunc(Number(rank.level)) || 1));
  const oldPoint = Math.max(0, Number(rank.point) || 0);
  const rule = table[oldLevel - 1];
  const pointRule = C.rankPoints.find((row) => row.rank === oldLevel && row.room === roomId)
    || C.rankPoints.find((row) => row.rank === oldLevel && row.room === rule.room);
  const prefix = matchLength === 'hanchan' ? 'half' : 'east';
  const change = pointRule?.[`${prefix}${placement}_${players}`] || 0;
  let level = oldLevel;
  let point = oldPoint + change;
  if (level < table.length && point >= rule.up) {
    level += 1;
    // The Dream Pinnacle transition tier inherits the previous tier's PT; regular promotions start from the original table's initial PT.
    point = table[level - 1].inherit ? point : table[level - 1].initial;
  } else if (level > 1 && rule.canDecrease && point < 0) {
    level -= 1;
    point = table[level - 1].down || table[level - 1].initial;
  } else {
    point = Math.max(0, point);
  }
  rank.level = level;
  rank.point = point;
  return { oldLevel, oldPoint, level, point, change, name: RANK_NAMES[level - 1] };
}

function emptyStatDetail(players) {
  return {
    hands: 0,
    games: 0,
    placements: Array.from({ length: players }, () => 0),
    wins: 0,
    dealIns: 0,
    riichi: 0,
    calls: 0,
    tsumo: 0,
    ron: 0,
    winPoints: 0,
    winTurns: 0,
    busts: 0,
    maxRenchan: 0,
  };
}

function emptyStats(players) {
  return {
    players,
    ...emptyStatDetail(players),
    eastGames: 0,
    hanchanGames: 0,
    byLength: {
      east: emptyStatDetail(players),
      hanchan: emptyStatDetail(players),
    },
  };
}

export function createDefaultProfile() {
  return {
    version: PROFILE_VERSION,
    nickname: 'player',
    coins: 999_999,
    ranks: {
      yonma: { ...C.defaults.rank },
      sanma: { ...C.defaults.rank },
    },
    stats: {
      yonma: emptyStats(4),
      sanma: emptyStats(3),
    },
    settings: {
      internalState: { 0: true, 1: false, 2: false, 3: false, 4: false, 5: false },
    },
    lobbyData: null,
    // Unfinished match { v, table, log, lastSeen } (see profile_host.mjs recoverMatch), and a one-time message for the player.
    activeMatch: null,
    notice: null,
  };
}

function normalizeActiveMatch(value) {
  if (!value || typeof value !== 'object' || !value.table || typeof value.table !== 'object' || !Array.isArray(value.log)) return null;
  return { ...value, lastSeen: Number(value.lastSeen) || 0 };
}

function normalizeStats(value, players) {
  const defaults = emptyStats(players);
  const stats = value && typeof value === 'object' ? value : {};
  const normalized = { ...defaults, ...stats };
  normalized.placements = defaults.placements.map((_, index) => Number(stats.placements?.[index]) || 0);
  normalized.byLength = {};
  for (const length of ['east', 'hanchan']) {
    const detail = stats.byLength?.[length];
    normalized.byLength[length] = {
      ...defaults.byLength[length],
      ...detail,
      games: Number(detail?.games ?? stats[`${length}Games`]) || 0,
      placements: defaults.byLength[length].placements.map((_, index) => Number(detail?.placements?.[index]) || 0),
    };
  }
  return normalized;
}


export function normalizeProfile(value) {
  const defaults = createDefaultProfile();
  const profile = value && typeof value === 'object' ? value : {};
  return {
    ...defaults,
    ...profile,
    // Migrate the old default nickname (the legacy Chinese literal below) to the new default nickname; nicknames the player changed are left untouched.
    nickname: profile.nickname === '离线玩家' ? defaults.nickname : (profile.nickname ?? defaults.nickname),
    version: PROFILE_VERSION,
    ranks: {
      yonma: { ...defaults.ranks.yonma, ...profile.ranks?.yonma },
      sanma: { ...defaults.ranks.sanma, ...profile.ranks?.sanma },
    },
    stats: {
      yonma: normalizeStats(profile.stats?.yonma, 4),
      sanma: normalizeStats(profile.stats?.sanma, 3),
    },
    settings: {
      ...defaults.settings,
      ...profile.settings,
      internalState: { ...defaults.settings.internalState, ...profile.settings?.internalState },
    },
    activeMatch: normalizeActiveMatch(profile.activeMatch),
    notice: typeof profile.notice === 'string' ? profile.notice : null,
  };
}

export function sanitizeNickname(value) {
  const nickname = String(value ?? '').trim();
  if (!nickname || /[\u0000-\u001f\u007f]/u.test(nickname)) return null;
  return nickname;
}

function addMatchStats(stats, placement, score, matchStats) {
  stats.games += 1;
  stats.placements[placement - 1] += 1;
  if (score < 0) stats.busts += 1;
  if (!matchStats) return;
  for (const field of ['hands', 'wins', 'dealIns', 'riichi', 'calls', 'tsumo', 'ron', 'winPoints', 'winTurns']) {
    stats[field] += Number(matchStats[field]) || 0;
  }
  stats.maxRenchan = Math.max(stats.maxRenchan, Number(matchStats.maxRenchan) || 0);
}


export function recordMatch(profile, { players, matchLength, scores, matchStats = null, roomId = null, startDealer = 0 }) {
  const key = players === 3 ? 'sanma' : 'yonma';
  const stats = profile.stats[key];
  const order = scores.map((score, seat) => ({ score, seat }))
    // Ties go to the seat closer to the first dealer (chiicha).
    .sort((left, right) => right.score - left.score
      || (left.seat - startDealer + players) % players - (right.seat - startDealer + players) % players);
  const placement = order.findIndex((entry) => entry.seat === 0) + 1;
  const length = matchLength === 'hanchan' ? 'hanchan' : 'east';
  stats[`${length}Games`] += 1;
  addMatchStats(stats, placement, scores[0], matchStats);
  addMatchStats(stats.byLength[length], placement, scores[0], matchStats);
  const rank = applyRankResult(profile, { players, matchLength, placement, roomId });
  profile.coins += 100;
  return { placement, coins: 100, rank };
}
