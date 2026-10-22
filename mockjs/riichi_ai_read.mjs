// 高级 AI 的读牌模型：只用公开信息（牌河及其顺序/摸切、副露、立直、宝牌、分数、余牌）
// 估计每位对手的听牌概率、和牌打点，以及自己打出每种牌的放铳概率。
//
// 放铳概率按「待牌形组合数」计算：对手听牌时的待牌形（两面、嵌张、边张、双碰、单骑）
// 各自需要对手手里持有的牌，组合数由自己视角下未见的枚数决定；形的先验权重按常见待牌
// 比例设定。对手的现物、立直后他家打出而未荣和的牌、同巡内他家打出而未荣和的牌都令
// 含该牌的待牌形不能荣和（振听），因此筋、壁、单骑见张等经验规则都是本模型的特例。
import { decodeId } from './tiles.mjs';

// 子家荣和点数（按番数近似，30~40 符）；庄家 ×1.5。
const KO_POINTS = [0, 1000, 2000, 3900, 7700, 8000, 12000, 12000, 16000, 16000, 16000, 24000, 24000, 32000];
function pointsForHan(han, dealer) {
  const h = Math.max(0, Math.min(13, han));
  const lo = Math.floor(h);
  const hi = Math.min(13, lo + 1);
  const base = KO_POINTS[lo] + (KO_POINTS[hi] - KO_POINTS[lo]) * (h - lo);
  return base * (dealer ? 1.5 : 1);
}

// 待牌形先验（每个组合）：按立直待牌约 两面 55%、嵌张 12%、边张 5%、双碰 15%、单骑 13% 校准。
const SHAPE_WEIGHT = { ryanmen: 1, kanchan: 0.19, penchan: 0.27, shanpon: 0.43, tanki: 0.37 };
// 多面待（三面、两面+双碰复合等）使一张牌命中的概率高于单一形状的和，整体放大。
const WAIT_MULTIPLICITY = 1.2;
const HIT_CAP = 0.6;

function kindToIndex(kind) {
  const suit = Math.floor(kind / 10);
  const rank = kind % 10;
  return suit === 4 ? 27 + rank - 1 : (suit - 1) * 9 + rank - 1;
}
function indexToKind(idx) {
  return idx >= 27 ? 40 + (idx - 27 + 1) : (Math.floor(idx / 9) + 1) * 10 + (idx % 9) + 1;
}
const isYaochuIndex = (idx) => idx >= 27 || idx % 9 === 0 || idx % 9 === 8;

// 所有待牌形：{ type, held: [idx…], waits: [idx…], suit (0-2，字牌为 3) }
const SHAPES = (() => {
  const out = [];
  for (let s = 0; s < 3; s++) {
    const b = s * 9;
    for (let r = 1; r <= 8; r++) {
      const i = b + r - 1;
      if (r === 1) out.push({ type: 'penchan', held: [i, i + 1], waits: [i + 2], suit: s });
      else if (r === 8) out.push({ type: 'penchan', held: [i, i + 1], waits: [i - 1], suit: s });
      else out.push({ type: 'ryanmen', held: [i, i + 1], waits: [i - 1, i + 2], suit: s });
    }
    for (let r = 1; r <= 7; r++) {
      const i = b + r - 1;
      out.push({ type: 'kanchan', held: [i, i + 2], waits: [i + 1], suit: s });
    }
  }
  for (let i = 0; i < 34; i++) {
    const suit = i >= 27 ? 3 : Math.floor(i / 9);
    out.push({ type: 'shanpon', held: [i, i], waits: [i], suit });
    out.push({ type: 'tanki', held: [i], waits: [i], suit });
  }
  return out;
})();

const OPEN_TYPES = new Set(['chi', 'pon', 'kan']);

// 公开牌河日志；测试中手工搭建的牌局可能没有日志，则按各家牌河退化（没有顺序信息）。
function logOf(engine) {
  if (Array.isArray(engine.discardLog)) return engine.discardLog;
  const out = [];
  for (const q of engine.players) {
    for (const tile of q.discards || []) {
      const { suit, rank } = decodeId(tile);
      out.push({ seat: q.seat, kind: suit * 10 + rank, tsumogiri: false, riichi: false, synthetic: true });
    }
  }
  return out;
}

// 对手 q 当前不能荣和的牌（牌种下标）：自家现物 + 立直后他家通过牌 + 同巡通过牌。
function furitenSet(engine, q, log) {
  const safe = new Set();
  for (const kind of q.discardKinds || []) safe.add(kindToIndex(kind));
  if (log.length && !log[0].synthetic) {
    let riichiAt = -1;
    let lastOwn = -1;
    for (let i = 0; i < log.length; i++) {
      if (log[i].seat !== q.seat) continue;
      lastOwn = i;
      if (log[i].riichi) riichiAt = i;
    }
    const from = q.riichi && riichiAt >= 0 ? riichiAt + 1 : lastOwn + 1;
    if (from > 0) for (let i = from; i < log.length; i++) safe.add(kindToIndex(log[i].kind));
  }
  return safe;
}

function openMeldsOf(q) {
  return (q.melds || []).filter((m) => OPEN_TYPES.has(m.type));
}

// 对手听牌概率：立直为 1；副露按副露数、巡目和末尾连续摸切估计；门清未立直按巡目给默听概率。
function tenpaiProbability(q, log) {
  if (q.riichi) return 1;
  const own = log.filter((e) => e.seat === q.seat);
  const d = own.length || (q.discards || []).length;
  const m = openMeldsOf(q).length;
  let p;
  if (m >= 4) p = 0.95;
  else if (m === 3) p = Math.min(0.9, 0.35 + 0.05 * d);
  else if (m === 2) p = Math.min(0.72, 0.12 + 0.045 * d);
  else if (m === 1) p = Math.min(0.38, 0.03 + 0.025 * d);
  else p = d <= 6 ? 0.01 : Math.min(0.28, 0.02 * (d - 6));
  if (m >= 1) {
    let streak = 0;
    for (let i = own.length - 1; i >= 0 && own[i].tsumogiri; i--) streak++;
    p = Math.min(0.97, p + 0.05 * Math.min(4, streak));
  }
  return p;
}

// 副露手读牌：染手花色、断幺、对对和；返回待牌形的倍率函数和额外番数。
function openHandShape(engine, q) {
  const melds = openMeldsOf(q);
  const tiles = melds.flatMap((m) => m.tiles);
  if (!melds.length) return { factor: null, han: 0 };
  const decoded = tiles.map(decodeId);
  const suits = new Set(decoded.filter(({ suit }) => suit !== 4).map(({ suit }) => suit - 1));
  const honors = decoded.some(({ suit }) => suit === 4);
  const allSimples = decoded.every(({ suit, rank }) => suit !== 4 && rank >= 2 && rank <= 8);
  const pons = melds.filter((m) => m.type !== 'chi').length;
  const chis = melds.length - pons;
  const flushSuit = melds.length >= 2 && suits.size === 1 ? [...suits][0] : -1;
  const allHonor = melds.length >= 2 && suits.size === 0;
  const toitoi = pons >= 2 && chis === 0;
  let han = 0;
  if (flushSuit >= 0) han += honors ? 2 : 5;
  if (toitoi && pons >= 3) han += 2;
  const factor = (shape) => {
    let f = 1;
    if (flushSuit >= 0 && shape.suit !== 3 && shape.suit !== flushSuit) f *= 0.08;
    if (allHonor && shape.suit !== 3) f *= 0.3;
    if (allSimples) {
      if (shape.held.some(isYaochuIndex) || shape.waits.some(isYaochuIndex)) f *= 0.15;
    }
    if (toitoi && (shape.type === 'ryanmen' || shape.type === 'kanchan' || shape.type === 'penchan')) f *= 0.25;
    if (toitoi && (shape.type === 'shanpon' || shape.type === 'tanki')) f *= 2.5;
    return f;
  };
  return { factor, han, allSimples };
}

function yakuhaiHan(engine, q, idx) {
  if (idx < 27) return 0;
  const rank = idx - 26;
  let han = 0;
  if (rank >= 5) han++;
  if (rank === engine.roundWind) han++;
  if (rank === engine.seatWindOf(q.seat)) han++;
  return han;
}

// 对手若和牌（荣和自己）的估计点数。
function threatValue(engine, q, shapeInfo) {
  const dealer = q.seat === engine.dealerSeat;
  const honba = (engine.honba || 0) * 300;
  if (q.riichi) {
    const kanDora = Math.max(0, (engine.doraIndicators?.length || 1) - 1);
    return (dealer ? 8700 : 5800) * (1 + 0.15 * kanDora) + honba;
  }
  const melds = openMeldsOf(q);
  if (!melds.length) return (dealer ? 6800 : 4500) + honba;
  const doraKinds = engine.doraKinds ? engine.doraKinds() : new Set();
  let dora = 0;
  let yaku = 0;
  for (const m of q.melds || []) {
    if (m.type === 'babei') { dora += 1; continue; }
    for (const t of m.tiles) {
      const { suit, rank } = decodeId(t);
      if (doraKinds.has(suit * 10 + rank)) dora++;
      if (engine.akaSet?.has(t)) dora++;
    }
    if (m.type !== 'chi') {
      const { suit, rank } = decodeId(m.tiles[0]);
      yaku += yakuhaiHan(engine, q, kindToIndex(suit * 10 + rank));
    }
  }
  yaku += shapeInfo.han;
  if (!yaku) yaku = 1;
  return pointsForHan(yaku + dora + 0.6, dealer) + honba;
}

// remainOf(idx)：自己视角下未见枚数。lossUtil(seat, points)：把放铳点数换算成效用（顺位修正）。
function readThreats(engine, seat, remainOf, { lossUtil = null } = {}) {
  const log = logOf(engine);
  const avail = new Array(34);
  for (let i = 0; i < 34; i++) avail[i] = Math.max(0, remainOf(i));
  const threats = [];
  for (const q of engine.players) {
    if (q.seat === seat) continue;
    const tenpai = tenpaiProbability(q, log);
    if (tenpai < 0.005) continue;
    const furiten = furitenSet(engine, q, log);
    const shapeInfo = openHandShape(engine, q);
    const num = new Float64Array(34);
    let den = 0;
    for (const shape of SHAPES) {
      if (shape.waits.some((w) => furiten.has(w))) continue;
      let w = SHAPE_WEIGHT[shape.type];
      if (shape.type === 'shanpon') {
        const a = avail[shape.held[0]];
        w *= a >= 2 ? (a * (a - 1)) / 2 : 0;
      } else if (shape.type === 'tanki') {
        w *= avail[shape.held[0]] * (shape.suit === 3 ? 1.5 : 1);
      } else {
        w *= avail[shape.held[0]] * avail[shape.held[1]];
      }
      if (!w) continue;
      if (shapeInfo.factor) w *= shapeInfo.factor(shape);
      den += w;
      for (const t of shape.waits) num[t] += w;
    }
    const hit = new Float64Array(34);
    if (den > 0) for (let i = 0; i < 34; i++) if (!furiten.has(i)) hit[i] = Math.min(HIT_CAP, (WAIT_MULTIPLICITY * num[i]) / den);
    const value = threatValue(engine, q, shapeInfo);
    threats.push({
      seat: q.seat,
      riichi: !!q.riichi,
      dealer: q.seat === engine.dealerSeat,
      tenpai,
      value,
      loss: lossUtil ? lossUtil(q.seat, value) : value,
      hit,
      furiten,
    });
  }
  const dealOf = new Float64Array(34);
  const lossOf = new Float64Array(34);
  let tenpaiMass = 0;
  let threatValueSum = 0;
  for (const t of threats) {
    tenpaiMass += t.tenpai;
    threatValueSum += t.tenpai * t.loss;
    for (let i = 0; i < 34; i++) {
      dealOf[i] += t.tenpai * t.hit[i];
      lossOf[i] += t.tenpai * t.hit[i] * t.loss;
    }
  }
  let unseen = 0;
  let drawLoss = 0;
  for (let i = 0; i < 34; i++) {
    unseen += avail[i];
    drawLoss += avail[i] * lossOf[i];
  }
  return {
    threats,
    dealOf,
    lossOf,
    tenpaiMass,
    threatValue: threatValueSum,
    // 随机摸到的一张牌直接打出的期望放铳损失（推进/立直后摸切用）。
    avgDrawLoss: unseen ? drawLoss / unseen : 0,
  };
}

export { readThreats, pointsForHan, kindToIndex, indexToKind, tenpaiProbability, furitenSet, logOf, SHAPES };
