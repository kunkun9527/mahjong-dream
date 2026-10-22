// High-level AI's tile-reading model: uses only public information (discard rivers and their order / tsumogiri, melds, riichi, dora, scores, tiles left)
// to estimate each opponent's tenpai probability, expected win value, and the deal-in probability of each discard of ours.
//
// Deal-in probability is computed from the count of waiting-shape combinations: when an opponent is tenpai, each waiting shape (ryanmen, kanchan, penchan, shanpon, tanki)
// requires specific tiles in the opponent's hand; combination counts follow the number of unseen copies from our viewpoint, and the shape prior weights follow typical wait ratios.
// An opponent's genbutsu, tiles they discarded after their riichi without winning on them, and tiles they discarded in the same turn without winning on them all make
// waits containing that tile unable to ron (furiten), so empirical rules such as suji, wall and tanki are special cases of this model.
import { decodeId } from './tiles.mjs';

// Ron value for a non-dealer (approximated by han, 30-40 fu); dealer ×1.5.
const KO_POINTS = [0, 1000, 2000, 3900, 7700, 8000, 12000, 12000, 16000, 16000, 16000, 24000, 24000, 32000];
function pointsForHan(han, dealer) {
  const h = Math.max(0, Math.min(13, han));
  const lo = Math.floor(h);
  const hi = Math.min(13, lo + 1);
  const base = KO_POINTS[lo] + (KO_POINTS[hi] - KO_POINTS[lo]) * (h - lo);
  return base * (dealer ? 1.5 : 1);
}

// Wait-shape priors (per combination): calibrated to riichi wait frequencies of roughly ryanmen 55%, kanchan 12%, penchan 5%, shanpon 15%, tanki 13%.
const SHAPE_WEIGHT = { ryanmen: 1, kanchan: 0.19, penchan: 0.27, shanpon: 0.43, tanki: 0.37 };
// Multi-sided waits (three-sided, ryanmen + shanpon combos, etc.) make a single tile more likely to hit, so the total is scaled up.
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

// All wait shapes: { type, held: [idx…], waits: [idx…], suit (0-2; honors = 3) }
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

// Public discard log; hand-built test positions may have no log, in which case it falls back to each river (no order info).
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

// Tiles opponent q currently cannot ron on (tile-kind indices): our own genbutsu + tiles they passed after our riichi + tiles they passed in the same turn.
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

// Opponent tenpai probability: 1 when in riichi; for open hands estimated from the number of melds, turn count and trailing tsumogiri; closed non-riichi hands get a dama probability by turn count.
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

// Open-hand reading: honitsu, tanyao, toitoi; returns a multiplier function for wait shapes and the extra han.
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

// Kokushi Musou: ordinary five-type wait shapes do not cover it, so terminals must not be judged zero-risk because of that.
// Public information only: it cannot have melds (pulling North does not break closed status); discarding a terminal only lowers the prior and cannot exclude it being drawn later.
// A single-tile wait can ron the last copy in our own hand; a thirteen-sided wait makes the whole hand furiten as soon as one terminal genbutsu exists.
// The prior that a tenpai hand is Kokushi is very small (riichi 0.5%, dama 0.15%), but once it is Kokushi, every unseen terminal deals in when the wait is thirteen-sided.
const YAOCHU = (() => {
  const out = [];
  for (let i = 0; i < 34; i++) if (isYaochuIndex(i)) out.push(i);
  return out;
})();
const KOKUSHI_PRIOR = { riichi: 0.005, dama: 0.0015 };
const KOKUSHI_THIRTEEN_SIDED = 0.5; // Share of Kokushi tenpai that is thirteen-sided (holding all 13 kinds); the rest are single-tile waits.
function kokushiModel(q, furiten, avail) {
  if ((q.melds || []).some((m) => m.type !== 'babei')) return null;
  const discarded = YAOCHU.filter((i) => q.discardKinds?.has(indexToKind(i)));
  const prior = (q.riichi ? KOKUSHI_PRIOR.riichi : KOKUSHI_PRIOR.dama) * 0.3 ** discarded.length;
  const thirteen = YAOCHU.every((i) => avail[i] > 0 && !furiten.has(i));
  const single = YAOCHU.filter((i) => !furiten.has(i)
    && YAOCHU.every((j) => j === i || avail[j] > 0)
    && YAOCHU.some((j) => j !== i && avail[j] >= 2));
  if (!thirteen && !single.length) return null;
  const hit = new Float64Array(34);
  for (const i of YAOCHU) {
    if (thirteen) hit[i] += KOKUSHI_THIRTEEN_SIDED;
    if (single.includes(i)) hit[i] += (1 - KOKUSHI_THIRTEEN_SIDED) / single.length;
  }
  return { prior, hit };
}

// Estimated points if an opponent wins by ron on us.
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

// remainOf(idx): unseen count from our viewpoint. lossUtil(seat, points): converts deal-in points into utility (seat adjustment).
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
    // Kokushi mix: hit probability and loss weighted by the prior, with the loss counted as yakuman.
    const kokushi = tenpai >= 0.005 ? kokushiModel(q, furiten, avail) : null;
    let lossHit = null;
    if (kokushi) {
      const dealer = q.seat === engine.dealerSeat;
      const yakuman = (dealer ? 48000 : 32000) + (engine.honba || 0) * 300;
      const kLoss = lossUtil ? lossUtil(q.seat, yakuman) : yakuman;
      lossHit = new Float64Array(34);
      const lossBase = lossUtil ? lossUtil(q.seat, value) : value;
      for (let i = 0; i < 34; i++) {
        const normal = hit[i] * lossBase;
        hit[i] = (1 - kokushi.prior) * hit[i] + kokushi.prior * kokushi.hit[i];
        lossHit[i] = (1 - kokushi.prior) * normal + kokushi.prior * kokushi.hit[i] * kLoss;
      }
    }
    threats.push({
      lossHit,
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
      lossOf[i] += t.tenpai * (t.lossHit ? t.lossHit[i] : t.hit[i] * t.loss);
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
    // Expected deal-in loss from discarding the tile drawn at random (for advancing / discarding after riichi).
    avgDrawLoss: unseen ? drawLoss / unseen : 0,
  };
}

export { readThreats, kokushiModel, pointsForHan, kindToIndex, indexToKind, tenpaiProbability, furitenSet, logOf, SHAPES };
