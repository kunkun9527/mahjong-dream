import { SICHUAN_CATALOG } from './sichuan_catalog.mjs';
import { RED_ZHONG_KIND, analyzeSichuanHand, isRedZhong, sichuanKind, sichuanWaitKinds } from './sichuan_hand.mjs';
import { tileId } from './tiles.mjs';

const catalogs = new Map([5021, 5022, 5023].map((gameType) => [gameType,
  new Map(SICHUAN_CATALOG.games[gameType].yaku.map((item) => [item.calcYiType, item]))]));

function checkRules(gameType, topBei) {
  if (!catalogs.has(gameType)) throw new RangeError('此计分器仅支持血战、血流与红中血流');
  // 单次和牌按房间封顶（原表为128/256，红中血流免费场按128，见ADR 0005）；血流整局累计上限由局序执行。
  if (![128, 256].includes(topBei)) throw new RangeError('必须由房间规则明确指定合法封顶倍数');
}

function yaku(gameType, calcYiType) {
  const rule = catalogs.get(gameType).get(calcYiType);
  if (!rule || rule.beiType !== 2) throw new Error(`未核验的四川番型 ${calcYiType}`);
  return { yiType: rule.yiType, name: rule.name, bei: rule.bei };
}

const terminal = (kind) => kind % 9 === 0 || kind % 9 === 8;
const isWildGame = (gameType) => gameType === 5023;

// 分解后（赖子已替换）的全部牌种，用于清一色、断幺九、将对等按牌形判断的番。
function shapeKinds(shape) {
  if (shape.type === 'sevenPairs') return shape.pairs.flatMap((kind) => [kind, kind]);
  const kinds = [shape.pair, shape.pair];
  for (const group of shape.groups) {
    if (group.type === 'sequence') kinds.push(group.kind, group.kind + 1, group.kind + 2);
    else kinds.push(...Array(group.type === 'quad' ? 4 : 3).fill(group.kind));
  }
  return kinds;
}

// 复合牌型替代已包含的组成项；不执行原表中有自引用/跨玩法引用的ExceptYis。
// 未写清的组成项扣除约定见docs/adr/0004-sichuan-scoring-clarifications.md。
function shapeYaku(shape, melds, kinds, rootCount) {
  const pure = new Set(kinds.map((kind) => Math.floor(kind / 9))).size === 1;
  const simple = kinds.every((kind) => !terminal(kind));
  const jiang = kinds.every((kind) => [1, 4, 7].includes(kind % 9));
  const ids = [];
  let includedPure = false;
  let consumedRoots = 0;
  if (shape.type === 'sevenPairs') {
    const dragons = shape.quadKinds.length;
    consumedRoots = dragons;
    if (jiang) {
      ids.push(dragons === 3 ? 3010 : dragons === 2 ? 3009 : 3005);
    } else if (pure && dragons <= 1) {
      ids.push(dragons ? 3007 : 3004);
      includedPure = true;
    } else {
      ids.push([3001, 3003, 3006, 3008][dragons]);
    }
  } else {
    const triplets = shape.groups.every((group) => group.type !== 'sequence');
    const singleWait = melds.length === 4;
    const fourKongs = singleWait && shape.groups.every((group) => group.type === 'quad');
    if (fourKongs) {
      ids.push(pure ? 1009 : 1008);
      includedPure = pure;
      consumedRoots = 4;
      if (jiang) ids.push(1006);
    } else if (singleWait) {
      ids.push(pure ? 1007 : 1004);
      includedPure = pure;
      if (jiang) ids.push(1006);
    } else if (triplets) {
      ids.push(pure ? 1005 : jiang ? 1006 : 1003);
      includedPure = pure;
    }
    if (terminal(shape.pair) && shape.groups.every((group) => group.type === 'sequence'
      ? group.kind % 9 === 0 || group.kind % 9 === 6 : terminal(group.kind))) ids.push(14);
  }
  if (pure && !includedPure) ids.push(13);
  if (simple && !jiang) ids.push(12);
  return { ids, countedRoots: rootCount - consumedRoots, pure };
}

/**
 * 红中血流独有牌形番（ADR 0005）。按原文「不计……」替换被包含的番：
 * 一条龙不计连六；四连刻不计三连刻、碰碰胡；四暗刻不计三暗刻、碰碰胡；全双刻不计碰碰胡、断幺九；
 * 十二金钗不计根；一色双龙会、九莲宝灯不计清一色；红中金钩钓不计金钩钓、碰碰胡。
 */
function wildShapeYaku(shape, melds, { ids, countedRoots, pure }, { winType, winTile }) {
  const remove = new Set();
  const add = [];
  if (shape.type === 'standard') {
    const groups = shape.groups;
    const sequences = groups.filter((group) => group.type === 'sequence').map((group) => group.kind);
    const triplets = groups.filter((group) => group.type !== 'sequence');
    const hasSequence = (kind) => sequences.includes(kind);
    const sameSuit = (a, b) => Math.floor(a / 9) === Math.floor(b / 9);
    if ([0, 9, 18].some((base) => hasSequence(base) && hasSequence(base + 3) && hasSequence(base + 6))) {
      add.push(1016);
    } else if (sequences.some((kind) => kind % 9 <= 3 && hasSequence(kind + 3) && sameSuit(kind, kind + 3))) add.push(1013);
    const ranks = triplets.map((group) => group.kind % 9);
    if (triplets.some((a, index) => triplets.some((b, other) => other !== index && a.kind % 9 === b.kind % 9
      && !sameSuit(a.kind, b.kind)))) add.push(1014);
    let run = 0;
    const tripletKinds = new Set(triplets.map((group) => group.kind));
    for (const kind of tripletKinds) {
      let length = 1;
      while (tripletKinds.has(kind + length) && sameSuit(kind, kind + length)) length += 1;
      run = Math.max(run, length);
    }
    if (run >= 4) {
      add.push(1020);
      remove.add(1003);
    } else if (run === 3) add.push(1017);
    // 暗刻：未副露的刻子/暗杠；荣和补成的刻子不算暗刻（和牌张能放进顺子或将牌时视为不占刻子）。
    let concealed = triplets.filter((group) => !group.open).length;
    if (winType !== 'tsumo' && winTile !== null && !isRedZhong(winTile)) {
      const winKind = sichuanKind(winTile);
      const elsewhere = shape.pair === winKind || sequences.some((kind) => winKind >= kind && winKind <= kind + 2
        && sameSuit(kind, winKind));
      if (!elsewhere && triplets.some((group) => !group.open && group.kind === winKind && group.type === 'triplet')) concealed -= 1;
    }
    if (concealed >= 4) {
      add.push(1021);
      remove.add(1003);
    } else if (concealed === 3) add.push(1015);
    if (!sequences.length && ranks.every((rank) => rank % 2 === 1) && shape.pair % 9 % 2 === 1) {
      add.push(1018);
      remove.add(1003).add(12);
    }
    const kongs = melds.filter((meld) => meld.type !== 'pon').length;
    if (kongs === 3) add.push(1019);
    if (pure && sequences.length === 4 && shape.pair % 9 === 4) {
      const base = Math.floor(shape.pair / 9) * 9;
      const sorted = [...sequences].sort((a, b) => a - b);
      if (sorted.join() === [base, base, base + 6, base + 6].join()) {
        add.push(1023);
        remove.add(13);
      }
    }
    if (melds.length === 4 && shape.pairWild === 2 && isRedZhong(winTile)) {
      // 红中金钩钓：四副碰杠后，摸到红中与手里的红中成将（只能自摸，原 cantHuTypes=[荣和,抢杠]）。
      if (ids.includes(1004)) {
        remove.add(1004).add(1003);
        add.push(1022);
      } else if (ids.includes(1007)) {
        remove.add(1007).add(1003);
        add.push(1022, 13);
      }
    }
  }
  if (!melds.length) {
    const counts = Array(9).fill(0);
    const kinds = shapeKinds(shape);
    if (pure) {
      for (const kind of kinds) counts[kind % 9] += 1;
      const base = [3, 1, 1, 1, 1, 1, 1, 1, 3];
      if (counts.every((count, rank) => count >= base[rank])) {
        add.push(1024);
        remove.add(13);
      }
    }
  }
  if (add.includes(1016)) remove.add(1013);
  if (add.includes(1020)) remove.add(1017);
  if (add.includes(1021)) remove.add(1015);
  let roots = countedRoots;
  if (add.includes(1019)) roots = 0;
  const merged = [...ids.filter((id) => !remove.has(id)), ...add.filter((id) => !remove.has(id))];
  return { ids: merged, countedRoots: roots };
}

/**
 * hand包含本次和牌的实体牌。winType及开局/杠/海底标记必须由权威局序提供。
 * 红中血流额外情境：kongDiscard=杠后打出的牌被荣和（杠上炮）；redKongs=本人本局已打出的红中杠张数。
 * winTile 默认取 hand 最后一张，用于红中单吊限制与荣和暗刻判断。
 */
export function scoreSichuanHand(hand, {
  melds = [], missingSuit, gameType = 5022, topBei,
  winType = 'ron', afterKong = false, lastTile = false, opening = null,
  kongDiscard = false, redKongs = 0, winTile = hand.at(-1) ?? null,
} = {}) {
  checkRules(gameType, topBei);
  const wild = isWildGame(gameType);
  if (!['ron', 'tsumo', 'robKong'].includes(winType) || ![null, 'heaven', 'earth'].includes(opening)
      || typeof afterKong !== 'boolean' || typeof lastTile !== 'boolean' || typeof kongDiscard !== 'boolean'
      || !Number.isInteger(redKongs) || redKongs < 0 || redKongs > 6) throw new RangeError('无效的四川和牌情境');
  if (!wild && (kongDiscard || redKongs)) throw new RangeError('杠上炮与红中杠只属于红中血流');
  if ((afterKong || lastTile || opening) && winType !== 'tsumo') throw new RangeError('自摸情境不能用于荣和或抢杠');
  if (kongDiscard && winType !== 'ron') throw new RangeError('杠上炮只能用于荣和');
  if (opening && (afterKong || lastTile || melds.length || redKongs)) throw new RangeError('天胡/地胡不能与杠、海底或已有副露混用');
  if (winTile !== null && !hand.includes(winTile)) throw new RangeError('和牌张必须在手牌中');
  const shapes = analyzeSichuanHand(hand, { melds, missingSuit, wild, winTile });
  if (afterKong && !redKongs && !melds.some((meld) => ['kan', 'ankan'].includes(meld.type))) throw new RangeError('杠上开花必须有实际杠牌');
  if (!shapes.length) return null;
  // 根只按真实同种四张计；赖子不凑根（ADR 0005）。
  const counts = Array(27).fill(0);
  for (const id of [...hand, ...melds.flatMap((meld) => meld.tiles)]) {
    const kind = sichuanKind(id, wild);
    if (kind !== RED_ZHONG_KIND) counts[kind] += 1;
  }
  const rootCount = counts.filter((count) => count === 4).length;
  let best = null;
  for (const shape of shapes) {
    let base = shapeYaku(shape, melds, shapeKinds(shape), rootCount);
    if (wild) base = { ...base, ...wildShapeYaku(shape, melds, base, { winType, winTile }) };
    const { ids, countedRoots } = base;
    if (!ids.length) ids.push(1001);
    if (countedRoots > 0) ids.push(6 + countedRoots);
    if (opening) ids.push(opening === 'heaven' ? 1 : 2);
    else if (winType === 'tsumo') ids.push(4);
    if (afterKong) ids.push(6);
    if (lastTile) ids.push(5);
    if (winType === 'robKong') ids.push(3);
    if (kongDiscard) ids.push(23);
    // 红中杠倍率按原表档位 2/4/6/8/10/12（n 张取第 n 档），不是逐张乘2（ADR 0005）。
    if (redKongs) ids.push(23 + redKongs);
    const items = ids.map((id) => yaku(gameType, id));
    if (countedRoots > 0) {
      const item = items.find((entry) => entry.yiType === yaku(gameType, 6 + countedRoots).yiType);
      item.name = countedRoots === 1 ? '根' : `${countedRoots}根`;
    }
    if (redKongs > 1) items.find((entry) => entry.yiType === yaku(gameType, 23 + redKongs).yiType).name = `红中杠×${redKongs}`;
    const rawBei = items.reduce((total, item) => total * item.bei, 1);
    if (!Number.isSafeInteger(rawBei)) throw new RangeError('四川倍数溢出');
    const result = { gameType, winType, rawBei, bei: Math.min(rawBei, topBei), capped: rawBei > topBei,
      rootCount, countedRoots, yaku: items, shape };
    // 先比较未封顶倍数；封顶相同也保留真正最优牌形，平手保持分解器稳定顺序。
    if (!best || rawBei > best.rawBei) best = result;
  }
  return best;
}

// 查大叫只能用牌形本身的最大荣和倍数，不能假设未来自摸/抢杠/天胡/红中等机会番。
export function maxSichuanReadyScore(hand, { melds = [], missingSuit, gameType = 5022, topBei } = {}) {
  checkRules(gameType, topBei);
  const wild = isWildGame(gameType);
  const waits = sichuanWaitKinds(hand, { melds, missingSuit, wild });
  const used = new Set([...hand, ...melds.flatMap((meld) => meld.tiles)]);
  let best = null;
  for (const kind of waits) {
    let copy = 1;
    const suit = Math.floor(kind / 9) + 1;
    const rank = kind % 9 + 1;
    while (used.has(tileId(suit, rank, copy))) copy += 1;
    const tile = tileId(suit, rank, copy);
    const score = scoreSichuanHand([...hand, tile], { melds, missingSuit, gameType, topBei, winTile: tile });
    if (score && (!best || score.rawBei > best.rawBei)) best = { ...score, waitKind: kind };
  }
  return best;
}

function seatsAndBase(activeSeats, seat, baseScore) {
  if (!Array.isArray(activeSeats) || activeSeats.length < 2 || activeSeats.length > 4
      || new Set(activeSeats).size !== activeSeats.length || !activeSeats.includes(seat)
      || ![...activeSeats].every((value) => Number.isInteger(value) && value >= 0 && value < 4)) throw new RangeError('无效的在局座位');
  if (!Number.isSafeInteger(baseScore) || baseScore <= 0) throw new RangeError('底分必须为安全正整数');
}

function payments(payers, receiver, units, baseScore) {
  const amount = units * baseScore;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(amount * payers.length)) throw new RangeError('支付金额溢出');
  const delta = [0, 0, 0, 0];
  const transfers = payers.map((from) => ({ from, to: receiver, amount }));
  for (const transfer of transfers) {
    delta[transfer.from] -= transfer.amount;
    delta[transfer.to] += transfer.amount;
  }
  return { delta, transfers };
}

// 仅计算积分转移，不读写钱包；庄家不额外加倍，已胡退出者不再参与付款。
export function sichuanWinPayments({ winner, loser = null, activeSeats, bei, baseScore }) {
  seatsAndBase(activeSeats, winner, baseScore);
  if (!Number.isSafeInteger(bei) || bei <= 0) throw new RangeError('和牌倍数必须为安全正整数');
  if (loser !== null && (!activeSeats.includes(loser) || loser === winner)) throw new RangeError('无效的放铳座位');
  return payments(loser === null ? activeSeats.filter((seat) => seat !== winner) : [loser], winner, bei, baseScore);
}

export function sichuanKongPayments({ seat, kind, from = null, activeSeats, baseScore, waived = false }) {
  seatsAndBase(activeSeats, seat, baseScore);
  if (!['exposed', 'added', 'concealed'].includes(kind) || typeof waived !== 'boolean') throw new RangeError('无效的杠类型');
  if (waived && kind !== 'added') throw new RangeError('先碰后补免杠费只能用于补杠');
  if (kind === 'exposed' ? !activeSeats.includes(from) || from === seat : from !== null) throw new RangeError('无效的放杠座位');
  if (waived) return { delta: [0, 0, 0, 0], transfers: [] };
  return payments(kind === 'exposed' ? [from] : activeSeats.filter((value) => value !== seat),
    seat, kind === 'added' ? 1 : 2, baseScore);
}
