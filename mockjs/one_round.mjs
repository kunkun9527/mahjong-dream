// Riichi 1-Round match (roomType=6 in the original client): play a single hand; rewards are granted by the human's winning han from the original config
// DailyCompetitionOneMatchRewardTb. Config key = roomID × 10000 + roomLevel, consistent with the client's
// OneRoundGameCfgMgr.GetOneMatchRewardCfg: roomID 1 is the Dream Stone room, 2 the coin room; roomLevel 1..5 are the entry-fee tiers.
import { ECONOMY_CATALOG as C } from './economy_catalog.mjs';
import { ManType } from './proto_enum.mjs';

export const ONE_ROUND_ROOM_TYPE = 6;

export function oneRoundRoom(roomId, roomLevel) {
  return C.oneRound.find((row) => row.id === roomId * 10_000 + roomLevel) || null;
}

/** riichi.EnumItemRewardLevel: 1..4 han → 1..4, mangan 5, haneman 6, baiman 7, sanbaiman 8, yakuman 9, double yakuman 10. */
export function oneRoundRewardLevel(win) {
  if (!win) return 0;
  if (win.yakuman >= 2) return 10;
  if (win.manType >= ManType.ManGuan) return 4 + win.manType;
  return Math.min(Math.max(win.totalFan || 0, 0), 4);
}

/** Settle the entry fee and rewards into inventory (DT 6) in one step; return the reward fields and DataChange used by NtfGameStop. */
export function settleOneRound(user, room, humanWin) {
  const level = oneRoundRewardLevel(humanWin);
  const rewards = level ? room.rewards[level - 1] : [];
  const deltas = room.cost.map((item) => ({ dtype: 6, id: item.id, count: -item.count }))
    .concat(rewards.map((item) => ({ dtype: 6, id: item.id, count: item.count })));
  return {
    itemRewardLevel: level,
    itemRewards: rewards.map((item) => ({ itemId: item.id, itemCount: item.count })),
    changes: user.changeInventory(deltas)
  };
}

/** The match may start only if the entry fee is fully covered. */
export function canAffordOneRound(user, room) {
  return room.cost.every((item) => user.inventoryCount(6, item.id) >= item.count);
}
