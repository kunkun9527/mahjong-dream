import { decodeId, tileId } from './tiles.mjs';

// 红中血流（5023）的六张红中赖子：实体 451..456，展示牌种为 450（原 guiCards）。
export const RED_ZHONG_KIND = 27;
export const RED_ZHONG_DISPLAY = 450;
export const isRedZhong = (id) => Number.isSafeInteger(id) && id >= 451 && id <= 456;

// 普通血战/血流：27种牌各4张，共108张；红中血流另加6张红中，共114张。
export function buildSichuanWall({ wild = false } = {}) {
  const tiles = [];
  for (let suit = 1; suit <= 3; suit += 1) {
    for (let rank = 1; rank <= 9; rank += 1) {
      for (let copy = 1; copy <= 4; copy += 1) tiles.push(tileId(suit, rank, copy));
    }
  }
  if (wild) for (let copy = 1; copy <= 6; copy += 1) tiles.push(tileId(4, 5, copy));
  return tiles;
}

// wild=false 时只接受普通序数牌；红中只在明确的红中血流规则下返回赖子牌种 27。
export function sichuanKind(id, wild = false) {
  if (!Number.isSafeInteger(id)) throw new RangeError('四川实体牌 ID 必须是整数');
  if (wild && isRedZhong(id)) return RED_ZHONG_KIND;
  const { suit, rank, copy } = decodeId(id);
  if (suit < 1 || suit > 3 || rank < 1 || rank > 9 || copy < 1 || copy > 4) {
    throw new RangeError(`无效的普通四川实体牌：${id}`);
  }
  return (suit - 1) * 9 + rank - 1;
}

function inspectHolding(hand, melds, missingSuit, wild) {
  if (![1, 2, 3].includes(missingSuit)) throw new RangeError('必须明确指定万/筒/条中的定缺花色');
  if (!Array.isArray(hand) || !Array.isArray(melds) || melds.length > 4 || hand.length > 14) {
    throw new RangeError('四川手牌或副露结构无效');
  }
  const used = new Set();
  const counts = Array(27).fill(0);
  const allCounts = Array(27).fill(0);
  let wilds = 0;
  let hasMissing = false;
  function add(id, allowWild) {
    const kind = sichuanKind(id, wild && allowWild);
    if (used.has(id)) throw new RangeError(`重复实体牌：${id}`);
    used.add(id);
    if (kind === RED_ZHONG_KIND) return kind;
    allCounts[kind] += 1;
    if (Math.floor(kind / 9) + 1 === missingSuit) hasMissing = true;
    return kind;
  }
  for (const id of hand) {
    const kind = add(id, true);
    if (kind === RED_ZHONG_KIND) wilds += 1;
    else counts[kind] += 1;
  }
  const fixedGroups = [];
  for (const meld of melds) {
    const length = meld?.type === 'pon' ? 3 : ['kan', 'ankan'].includes(meld?.type) ? 4 : 0;
    if (!length || !Array.isArray(meld.tiles) || meld.tiles.length !== length) {
      throw new RangeError('四川仅支持三张碰或四张杠，不能吃');
    }
    // 红中只能作为暗手赖子或单张红中杠，不能碰杠成副露（ADR 0005）。
    const kinds = [];
    for (const id of meld.tiles) kinds.push(add(id, false));
    if (!kinds.every((kind) => kind === kinds[0])) throw new RangeError('碰杠必须是同一种牌');
    fixedGroups.push({ type: length === 4 ? 'quad' : 'triplet', kind: kinds[0], open: meld.type !== 'ankan', wild: 0 });
  }
  return { counts, allCounts, used, wilds, hasMissing, fixedGroups };
}

const suitKinds = (missingSuit) => Array.from({ length: 27 }, (_, kind) => kind)
  .filter((kind) => Math.floor(kind / 9) + 1 !== missingSuit);

// 全由赖子组成的面子：可当作非缺门任意刻子或顺子。
function wildGroups(missingSuit) {
  const groups = [];
  for (const kind of suitKinds(missingSuit)) {
    groups.push({ type: 'triplet', kind, open: false, wild: 3 });
    if (kind % 9 <= 6) groups.push({ type: 'sequence', kind, open: false, wild: 3 });
  }
  return groups;
}

/**
 * 只判断牌形与定缺；不判断过胡、抢杠时机或支付倍率。
 * 分解中的 kind 为内部 0..26 牌种（赖子已替换为所代表的牌种），pairWild/group.wild 记录用了几张赖子。
 * wild=true 时红中为万能牌；winTile 为本次和牌实体，用于「红中不能做将牌单吊」：
 * 将牌由和牌（普通牌）与一张赖子组成、且该牌种在暗手只有这一张时，此分解无效（ADR 0005）。
 * limit 用于只判断能否和牌的调用，找到足够分解后提前结束。
 */
export function analyzeSichuanHand(hand, { melds = [], missingSuit, wild = false, winTile = null, limit = Infinity } = {}) {
  const { counts, hasMissing, fixedGroups, wilds: totalWilds } = inspectHolding(hand, melds, missingSuit, wild);
  if (hasMissing || hand.length !== 14 - 3 * melds.length) return [];
  const winKind = winTile !== null && wild && !isRedZhong(winTile) ? sichuanKind(winTile) : null;
  // 分解时 counts 会被递归消耗，单吊判断必须看原始暗手张数。
  const original = counts.slice();
  const forbiddenPair = (kind, pairWild) => winKind !== null && kind === winKind && pairWild === 1 && original[kind] === 1;
  const allowed = suitKinds(missingSuit);
  const shapes = [];
  const full = () => shapes.length >= limit;

  if (!melds.length) {
    const singles = counts.filter((count) => count % 2 === 1).length;
    const spare = totalWilds - singles;
    if (spare >= 0 && spare % 2 === 0) {
      const pairs = [];
      const quadKinds = [];
      let forbidden = false;
      for (let kind = 0; kind < counts.length; kind += 1) {
        for (let pair = 0; pair < Math.floor(counts[kind] / 2); pair += 1) pairs.push(kind);
        if (counts[kind] % 2) {
          pairs.push(kind);
          if (forbiddenPair(kind, 1)) forbidden = true;
        }
        if (counts[kind] === 4) quadKinds.push(kind);
      }
      if (!forbidden) {
        // 四川龙七对允许四张相同牌作为两个对子；龙只按真实四张计（ADR 0005），赖子对可当任意非缺门对子。
        const extra = spare / 2;
        const choose = (start, chosen) => {
          if (full()) return;
          if (chosen.length === extra) {
            shapes.push({ type: 'sevenPairs', pairs: [...pairs, ...chosen].sort((a, b) => a - b), quadKinds: [...quadKinds],
              wildPairs: extra });
            return;
          }
          for (let index = start; index < allowed.length; index += 1) choose(index, [...chosen, allowed[index]]);
        };
        choose(0, []);
      }
    }
  }

  const groups = [];
  const required = 4 - melds.length;
  let wilds = totalWilds;
  const record = (pair, pairWild) => {
    if (!forbiddenPair(pair, pairWild)) {
      shapes.push({ type: 'standard', pair, pairWild, groups: [...fixedGroups, ...groups].map((group) => ({ ...group })) });
    }
  };
  function finishWild(pair, pairWild, start) {
    if (full()) return;
    if (groups.length === required) return record(pair, pairWild);
    const options = wildGroups(missingSuit);
    for (let index = start; index < options.length; index += 1) {
      groups.push(options[index]);
      finishWild(pair, pairWild, index);
      groups.pop();
      if (full()) return;
    }
  }
  function split(pair, pairWild) {
    if (full()) return;
    const kind = counts.findIndex((count) => count > 0);
    if (kind === -1) {
      if (wilds === 3 * (required - groups.length)) {
        if (wilds) {
          const saved = wilds;
          wilds = 0;
          finishWild(pair, pairWild, 0);
          wilds = saved;
        } else if (groups.length === required) record(pair, pairWild);
      }
      return;
    }
    if (groups.length >= required) return;
    // 刻子：三张真牌，或以一/两张赖子补足。
    for (const used of [3, 2, 1]) {
      const need = 3 - used;
      if (counts[kind] < used || wilds < need || (!wild && need)) continue;
      counts[kind] -= used;
      wilds -= need;
      groups.push({ type: 'triplet', kind, open: false, wild: need });
      split(pair, pairWild);
      groups.pop();
      wilds += need;
      counts[kind] += used;
    }
    // 顺子：kind 是剩余最小真牌，比它小的位置只能由赖子补；更大的位置有真牌就用真牌（与赖子互换等价）。
    for (let start = kind - 2; start <= kind; start += 1) {
      if (start < 0 || Math.floor(start / 9) !== Math.floor(kind / 9) || start % 9 > 6) continue;
      let need = 0;
      const taken = [];
      for (let offset = 0; offset < 3; offset += 1) {
        const position = start + offset;
        if (position >= kind && counts[position] > 0) {
          counts[position] -= 1;
          taken.push(position);
        } else need += 1;
      }
      if (taken[0] === kind && need <= wilds && (wild || !need)) {
        wilds -= need;
        groups.push({ type: 'sequence', kind: start, open: false, wild: need });
        split(pair, pairWild);
        groups.pop();
        wilds += need;
      }
      for (const position of taken) counts[position] += 1;
    }
  }
  for (let pair = 0; pair < counts.length && !full(); pair += 1) {
    if (counts[pair] >= 2) {
      counts[pair] -= 2;
      split(pair, 0);
      counts[pair] += 2;
    }
  }
  if (wild) {
    for (let pair = 0; pair < counts.length && !full(); pair += 1) {
      if (counts[pair] >= 1 && wilds >= 1) {
        counts[pair] -= 1;
        wilds -= 1;
        split(pair, 1);
        wilds += 1;
        counts[pair] += 1;
      }
    }
    if (wilds >= 2) {
      for (const pair of allowed) {
        if (full()) break;
        wilds -= 2;
        split(pair, 2);
        wilds += 2;
      }
    }
  }
  return shapes;
}

function spareCopy(used, kind) {
  const suit = Math.floor(kind / 9) + 1;
  const rank = kind % 9 + 1;
  let copy = 1;
  while (used.has(tileId(suit, rank, copy))) copy += 1;
  return tileId(suit, rank, copy);
}

// 只列出普通序数牌等待（可被荣和的牌种）；红中赖子不能被打出放铳，不计入等待。
export function sichuanWaitKinds(hand, { melds = [], missingSuit, wild = false } = {}) {
  const { allCounts, used, hasMissing } = inspectHolding(hand, melds, missingSuit, wild);
  if (hasMissing || hand.length !== 13 - 3 * melds.length) return [];
  const waits = [];
  for (let kind = 0; kind < 27; kind += 1) {
    const suit = Math.floor(kind / 9) + 1;
    if (suit === missingSuit || allCounts[kind] >= 4) continue;
    const id = spareCopy(used, kind);
    if (analyzeSichuanHand([...hand, id], { melds, missingSuit, wild, winTile: id, limit: 1 }).length) waits.push(kind);
  }
  return waits;
}

// 普通出牌候选；红中不作为普通弃牌（打出即红中杠），只有手里全是红中时才允许打出。
export function legalSichuanDiscards(hand, missingSuit, wild = false) {
  inspectHolding(hand, [], missingSuit, wild);
  const missing = hand.filter((id) => !isRedZhong(id) && decodeId(id).suit === missingSuit);
  if (missing.length) return missing;
  const ordinary = wild ? hand.filter((id) => !isRedZhong(id)) : hand.slice();
  return ordinary.length ? ordinary : hand.slice();
}
