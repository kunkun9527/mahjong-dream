// Offline opponents: 19 named NPCs, each with a fixed character + skin (one per real skin) and a play style.
// Style axes are 1..5 with 3 = neutral (see resolveStyle in riichi_ai_policy.mjs for how they bend the AI):
//   attack  1 = folds at the first threat, 5 = rarely folds
//   call    1 = stays closed,              5 = calls whenever it helps
//   riichi  1 = prefers dama,              5 = riichi whenever legal
//   value   1 = speed only,                5 = big hands only
//   jitter  how often it picks among near-equal moves (seeded, so replays stay identical)
//   trait   one situational quirk (optional)
// Room difficulty (basic / intermediate / advanced) still decides how deep the AI analyses; style only shifts preferences.

import { ECONOMY_CATALOG } from "./economy_catalog.mjs";

const NPCS = [
  { id: 1, nick: 'Saki', warrior: 8, skin: 8001, head: 1017, style: { attack: 3, call: 2, riichi: 3, value: 3, jitter: 'mid', trait: 'kan' } },
  { id: 2, nick: 'Nodoka', warrior: 10, skin: 10001, head: 1019, style: { attack: 3, call: 3, riichi: 3, value: 3, jitter: 'low' } },
  { id: 3, nick: 'Yuuki', warrior: 2, skin: 2001, head: 1002, style: { attack: 4, call: 4, riichi: 3, value: 1, jitter: 'mid', trait: 'east' } },
  { id: 4, nick: 'Mako', warrior: 4, skin: 3704002, head: 1010, style: { attack: 2, call: 3, riichi: 3, value: 3, jitter: 'low' } },
  { id: 5, nick: 'Hisa', warrior: 5, skin: 5001, head: 1005, style: { attack: 4, call: 2, riichi: 5, value: 3, jitter: 'high' } },
  { id: 6, nick: 'Koromo', warrior: 2, skin: 3702002, head: 1007, style: { attack: 5, call: 3, riichi: 4, value: 4, jitter: 'mid', trait: 'late' } },
  { id: 7, nick: 'Teru', warrior: 4, skin: 4001, head: 1004, style: { attack: 4, call: 2, riichi: 4, value: 4, jitter: 'low', trait: 'dealer' } },
  { id: 8, nick: 'Momo', warrior: 1, skin: 1001, head: 1001, style: { attack: 3, call: 2, riichi: 1, value: 3, jitter: 'mid' } },
  { id: 9, nick: 'Kana', warrior: 9, skin: 9001, head: 1011, style: { attack: 5, call: 3, riichi: 4, value: 2, jitter: 'high' } },
  { id: 10, nick: 'Mihoko', warrior: 1, skin: 3701002, head: 1009, style: { attack: 1, call: 3, riichi: 2, value: 3, jitter: 'low' } },
  { id: 11, nick: 'Toki', warrior: 6, skin: 6001, head: 1006, style: { attack: 2, call: 2, riichi: 3, value: 3, jitter: 'low' } },
  { id: 12, nick: 'Sumire', warrior: 6, skin: 3706002, head: 1013, style: { attack: 4, call: 1, riichi: 2, value: 4, jitter: 'low' } },
  { id: 13, nick: 'Awai', warrior: 5, skin: 3705002, head: 1012, style: { attack: 5, call: 1, riichi: 5, value: 5, jitter: 'mid' } },
  { id: 14, nick: 'Kuro', warrior: 7, skin: 7001, head: 1015, style: { attack: 4, call: 3, riichi: 3, value: 5, jitter: 'mid', trait: 'dora' } },
  { id: 15, nick: 'Shiro', warrior: 8, skin: 3708002, head: 1018, style: { attack: 3, call: 1, riichi: 3, value: 5, jitter: 'high' } },
  { id: 16, nick: 'Toyone', warrior: 9, skin: 3709002, head: 1014, style: { attack: 5, call: 2, riichi: 5, value: 3, jitter: 'mid', trait: 'chase' } },
  { id: 17, nick: 'Yumi', warrior: 7, skin: 3707002, head: 1016, style: { attack: 3, call: 3, riichi: 3, value: 3, jitter: 'low', trait: 'placement' } },
  { id: 18, nick: 'Akagi', warrior: 3, skin: 3001, head: 1003, style: { attack: 5, call: 2, riichi: 2, value: 4, jitter: 'high' } },
  { id: 19, nick: 'Tetsuya', warrior: 3, skin: 3703002, head: 1008, style: { attack: 3, call: 3, riichi: 3, value: 4, jitter: 'low' } },
];

const NPC_UID_BASE = 10000;
const BANG_POOL = [140001, 140002, 140003, 140004, 140006, 140007, 140009];
// Displayed rank: around the player's own rank, kept inside the ranked room's entry range (economy catalog dojos).
function levelRange(roomId, humanLevel) {
  const lv = Math.max(1, Math.trunc(Number(humanLevel)) || 1);
  let lo = Math.max(1, lv - 2), hi = Math.min(22, lv + 2);
  const room = ECONOMY_CATALOG.dojos.find((d) => d.id === Number(roomId));
  if (room) {
    lo = Math.max(lo, room.minRank); hi = Math.min(hi, room.maxRank);
    if (lo > hi) [lo, hi] = [room.minRank, room.maxRank];
  }
  return [lo, hi];
}

function npcById(id) {
  return NPCS.find((npc) => npc.id === Number(id)) || null;
}

/** Seat `count` NPCs: never the player's character, never two of the same character at one table. */
function pickNpcs(rng, { count, humanWarrior, roomId = null, humanLevel = 1 }) {
  const pool = NPCS.filter((npc) => npc.warrior !== Number(humanWarrior));
  const picked = [];
  const used = new Set();
  while (picked.length < count && pool.length) {
    const npc = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    if (used.has(npc.warrior)) continue;
    used.add(npc.warrior);
    const [lo, hi] = levelRange(roomId, humanLevel);
    picked.push({
      npc: npc.id,
      uid: NPC_UID_BASE + npc.id,
      nick: npc.nick,
      head: npc.head,
      frame: 2001,
      title: 3001,
      bang: BANG_POOL[Math.floor(rng() * BANG_POOL.length)],
      warrior: npc.warrior,
      skin: npc.skin,
      level: lo + Math.floor(rng() * (hi - lo + 1)),
      pt: Math.floor(rng() * 60),
    });
  }
  return picked;
}

export { NPCS, NPC_UID_BASE, npcById, pickNpcs };
