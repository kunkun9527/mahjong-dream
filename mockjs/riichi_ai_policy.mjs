// Shared expected-value evaluation of candidates for the riichi AI: basic omits waiting-quality refinement; intermediate keeps refinement but does not search;
// advanced = intermediate framework + tile-reading model (riichi_ai_read.mjs: tenpai probability, deal-in rate by wait-shape combination, opponents' win value)
// + seat utility + fold-route valuation + two-shanten second-order ukeire + fixed-budget draw expectation search (within 1-shanten, valued by real yaku/points).
// Reads only its own hand and public information (discard rivers and their order / tsumogiri, melds, dora indicators, scores, tiles left),
// never the opponents' concealed hands, the wall or the ura dora; results for the same position are deterministic and reproducible.
import { decodeId, doraFromIndicator } from './tiles.mjs';
import { tileIndex, indexToTileId, countsOf, shantenOfCounts, waitsOfCounts } from './shanten.mjs';
import { calcWin, realMelds, kindOf, pickIdFromHand } from './ai.mjs';
import { readThreats, indexToKind } from './riichi_ai_read.mjs';

const AI_LEVELS = ['basic', 'intermediate', 'advanced'];
function normalizeAiLevel(level) {
  return AI_LEVELS.includes(level) ? level : 'intermediate';
}

// ---------- NPC play style (npc_roster.mjs) ----------
// A style only shifts preferences on top of the room's analysis level; no style = the neutral AI (identical to before styles existed).
// risk: multiplier on every perceived deal-in loss (deal-in, future exposure, fold route), so attack/fold balance moves smoothly.
// callBias / riichiBias: points added to the call / riichi side before comparing with pass / dama.
// valueBeta: convexity of the hand-value term (positive prefers big hands, negative prefers speed).
// jitter: amplitude (points) of seeded noise among discard candidates.
const RISK_BY_ATTACK = [1.5, 1.22, 1, 0.82, 0.67];
const JITTER_POINTS = { low: 60, mid: 150, high: 300 };
const NEUTRAL_STYLE = Object.freeze({
  risk: 1, callBias: 0, callReach: 2, riichiBias: 0, valueBeta: 0, jitter: 0, keepDora: false, kan: false, placement: 1, rng: null,
});
const clampAxis = (v) => Math.max(1, Math.min(5, Math.round(Number(v) || 3)));

// Resolve a seat's style for the current situation (traits depend on dealer, wind, wall and riichi state).
function resolveStyle(engine, seat) {
  const raw = engine.aiStyles?.[seat];
  if (!raw) return NEUTRAL_STYLE;
  const attack = clampAxis(raw.attack), call = clampAxis(raw.call), riichi = clampAxis(raw.riichi), value = clampAxis(raw.value);
  const trait = raw.trait;
  let risk = RISK_BY_ATTACK[attack - 1];
  let callBias = (call - 3) * 300;
  // Max shanten at which an open call is considered at all (neutral 2).
  let callReach = call >= 5 ? 3 : call <= 1 ? 1 : 2;
  let riichiBias = (riichi - 3) * 400;
  let valueBeta = (value - 3) * 0.12;
  // Situational traits act on top of the base axes (not clamped back to 5), so maxed-out NPCs still show them.
  if (trait === 'dealer' && seat === engine.dealerSeat) risk *= 0.82;
  if (trait === 'late' && engine.remain != null && engine.remain <= (engine.sanma ? 27 : 35)) risk *= 0.82;
  if (trait === 'east' && engine.roundWind === 1) { callBias += 300; callReach = Math.min(3, callReach + 1); valueBeta -= 0.12; }
  if (trait === 'chase' && engine.players?.some((pl) => pl.seat !== seat && pl.riichi)) riichiBias += 800;
  return {
    risk, callBias, callReach, riichiBias, valueBeta,
    jitter: JITTER_POINTS[raw.jitter] || 0,
    keepDora: trait === 'dora',
    kan: trait === 'kan',
    placement: trait === 'placement' ? 1.5 : 1,
    rng: engine.styleRngOf ? engine.styleRngOf(seat) : null,
  };
}

// Hand-value preference: v · (v / pivot)^beta keeps the neutral style unchanged and bends the speed/value trade-off.
function styledValue(ctx, v) {
  const beta = ctx.style.valueBeta;
  return beta && v > 0 ? v * Math.pow(v / 5200, beta) : v;
}

// Ron value for a non-dealer (approximated by han, 30-40 fu); dealer ×1.5.
const KO_POINTS = [0, 1000, 2000, 3900, 7700, 8000, 12000, 12000, 16000, 16000, 16000, 24000, 24000, 32000];
function pointsForHan(han, dealer) {
  const h = Math.max(0, Math.min(13, han));
  const lo = Math.floor(h);
  const hi = Math.min(13, lo + 1);
  const base = KO_POINTS[lo] + (KO_POINTS[hi] - KO_POINTS[lo]) * (h - lo);
  return base * (dealer ? 1.5 : 1);
}

// Ukeire count assumed at each shanten stage when the concrete wait shape is unknown (used by the next stage).
const DEFAULT_UKEIRE = [6, 18, 30, 40, 48, 54, 60, 60, 60];
// Between our draws, opponents' discards may also ron: each opponent counts as 0.25 effective chances.
const RON_CHANCE_PER_OPPONENT = 0.25;

// ---------- Whole-decision budget shared by all three levels ----------
// One aiTurn / aiClaim shares one budget: calc = number of calcWin calls; work = tile-efficiency computation
// (one shantenOfCounts costs 1, one waitsOfCounts costs 35). The budget is consumed only in call order and does not depend on the clock, so results are deterministic.
// To guarantee a legal action even at zero budget, the mandatory base discard scan is charged separately as baseWork (fixed 35 per discard kind);
// work/calc strictly limit the remaining optional tile-efficiency refinement and search; the base scan neither crowds them out nor is reported as limited work.
// Fallback rules after exhaustion (fixed, deterministic):
//  - Draw expectation search: stop searching; already-searched candidates are kept, the rest may not exceed the lowest value among searched candidates, and fall back to the closed-form valuation (same as intermediate);
//  - Two-shanten tile efficiency: unfinished candidates use the default ukeire (DEFAULT_UKEIRE), same as intermediate;
//  - Riichi / dama: return null when no candidate has been fully evaluated yet (do not declare riichi; leave it to discard evaluation).
const DECISION_CALC_BUDGET = 1500;
const DECISION_WORK_BUDGET = 120000;
const WAITS_WORK = 35;

function createDecisionBudget({ calc = DECISION_CALC_BUDGET, work = DECISION_WORK_BUDGET } = {}) {
  return { calcLimit: calc, workLimit: work, calcUsed: 0, workUsed: 0, baseWork: 0, exhausted: false };
}
function spendCalc(budget, n = 1) {
  if (budget.calcUsed + n > budget.calcLimit) { budget.exhausted = true; return false; }
  budget.calcUsed += n;
  return true;
}
function spendWork(budget, n) {
  if (budget.workUsed + n > budget.workLimit) { budget.exhausted = true; return false; }
  budget.workUsed += n;
  return true;
}
// Give the remaining budget evenly to one of the parts shares (deterministic: rounded down); after use, settleBudget charges it back to the parent budget.
function sliceBudget(budget, parts) {
  return createDecisionBudget({
    calc: Math.floor((budget.calcLimit - budget.calcUsed) / parts),
    work: Math.floor((budget.workLimit - budget.workUsed) / parts),
  });
}
function settleBudget(parent, child) {
  parent.calcUsed += child.calcUsed;
  parent.workUsed += child.workUsed;
  parent.baseWork += child.baseWork;
  if (child.exhausted) parent.fellBack = true;
}

// Within one decision, cache shapes that are independent of visible counts, then recompute ukeire along the current search path.
// Two-shanten tile efficiency and near-tenpai search repeatedly reach the same shape; avoid running 35 shanten computations each time. Not kept across decisions.
function policyWaits(ctx, counts, meldCount, remainOf = ctx.remainOf) {
  const memo = ctx.budget.waitsMemo ||= new Map();
  const key = `${meldCount}:${counts.join('')}`;
  let shape = memo.get(key);
  if (!shape) {
    shape = waitsOfCounts(counts, meldCount);
    memo.set(key, shape);
  }
  return { shanten: shape.shanten, waits: shape.waits, ukeire: shape.waits.reduce((sum, idx) => sum + Math.max(0, remainOf(idx)), 0) };
}

// hypothetical: the hypothetical hand after a proposed call { player, extraSeen }; extraSeen is our own physical tiles moved into the new meld
// that are not yet counted among public tiles (affects only the remaining count).
function publicContext(engine, seat, hypothetical = null, level = 'intermediate', budget = null) {
  const p = hypothetical?.player || engine.players[seat];
  const n = engine.playersN;
  const baseRemain = engine.remainOfFor(p);
  const extra = countsOf(hypothetical?.extraSeen || []);
  const remainOf = (idx) => baseRemain(idx) - extra[idx];
  let unseen = 0;
  for (let i = 0; i < 34; i++) unseen += Math.max(0, remainOf(i));
  const danger = engine.dangerKinds(seat);
  const scores = engine.players.map((player) => player.score);
  const others = scores.filter((_, s) => s !== seat);
  const sorted = scores.slice().sort((a, b) => b - a);
  const placement = sorted.indexOf(p.score);
  const allLast = engine.isAllLast();
  const dealer = seat === engine.dealerSeat;
  const threatLoss = threatLossOf(engine, seat, danger);
  const style = resolveStyle(engine, seat);
  // Seat adjustment: when All Last is ahead, deal-in costs more and point value is lower; in last place it is the opposite.
  // A placement-minded style applies it at every level and more strongly.
  let gainScale = 1;
  let lossScale = 1;
  if (allLast && (level !== 'basic' || style.placement > 1)) {
    const k = style.placement;
    const lead = p.score - Math.max(...others);
    if (placement === 0 && lead > 0) {
      lossScale = 1 + Math.min(1, lead / 8000) * k;
      gainScale = 1 - 0.3 * k;
    } else if (placement === n - 1) {
      gainScale = 1 + 0.25 * k;
      lossScale = 1 - 0.2 * k;
    }
  }
  const ctx = {
    engine,
    seat,
    p,
    n,
    remainOf,
    unseen: Math.max(1, unseen),
    ownDraws: Math.max(0, Math.ceil(engine.remain / n)),
    doraKinds: engine.doraKinds(),
    doraTiles: engine.doraIndicators.map((ind) => doraFromIndicator(ind, engine.sanma)),
    akaSet: engine.akaSet,
    danger,
    dealer,
    threatLoss,
    gainScale,
    lossScale,
    survival: danger ? 0.9 : n === 3 ? 0.94 : 0.95,
    tableBonus: (engine.riichiSticks || 0) * 1000 + (engine.honba || 0) * 300,
    gainUtil: (v) => v * gainScale,
    level,
    style,
    advanced: false,
    threatActive: !!danger,
    // Non-hand conditions for declaring riichi (consistent with engine.canRiichi: points ≥ 1000, tiles left ≥ player count).
    riichiOk: p.score >= 1e3 && engine.remain >= n,
    budget: budget || createDecisionBudget(),
  };
  if (level === 'advanced') {
    attachAdvanced(ctx);
  }
  return ctx;
}

// ---------- Advanced: tile reading, seat utility, fold and advance risk valuation ----------
// Seat chip (only used in utility under All Last).
const PLACEMENT_UMA = { 3: [15000, 0, -15000], 4: [15000, 5000, -5000, -15000] };

function placementUtility(engine, seat) {
  if (!engine.isAllLast()) return null;
  const scores = engine.players.map((pl) => pl.score);
  const n = scores.length;
  const uma = PLACEMENT_UMA[n] || PLACEMENT_UMA[4];
  const rankOf = (arr) => arr.filter((v, j) => j !== seat && (v > arr[seat] || (v === arr[seat] && j < seat))).length;
  const base = uma[rankOf(scores)];
  // Chip difference after we gain d points and the other loses d points.
  const umaDiff = (other, d) => {
    const a = scores.slice();
    a[seat] += d;
    a[other] -= d;
    return uma[rankOf(a)] - base;
  };
  return {
    gain(v) {
      if (v <= 0) return v;
      let s = 0;
      for (let j = 0; j < n; j++) if (j !== seat) s += umaDiff(j, v);
      return v + s / (n - 1);
    },
    loss(who, v) {
      return v - umaDiff(who, -v);
    },
  };
}

function attachAdvanced(ctx) {
  const util = placementUtility(ctx.engine, ctx.seat);
  if (util) ctx.gainUtil = util.gain;
  const read = readThreats(ctx.engine, ctx.seat, ctx.remainOf, { lossUtil: util ? util.loss : null });
  ctx.read = read;
  ctx.advanced = true;
  // Consider the fold route only when at least one player is fairly likely tenpai.
  ctx.threatActive = read.tenpaiMass >= 0.25;
  // Each turn, the probability that the hand ends by an opponent's win increases with opponents' tenpai probability.
  ctx.survival = 1 - Math.min(0.25, 0.015 * (ctx.n - 1) + 0.08 * read.tenpaiMass);
  ctx.gainScale = 1;
  ctx.lossScale = 1;
}

// Expected deal-in loss from discarding a given tile (already including seat adjustment).
function discardRisk(ctx, idx, kind) {
  if (ctx.advanced) return ctx.read.lossOf[idx] * ctx.style.risk;
  return dealInProbability(ctx, kind) * ctx.threatLoss * ctx.lossScale * ctx.style.risk;
}

// Cumulative deal-in loss of future discards if we keep attacking: the current threat uses the average risk of a random draw,
// and future threats (opponents becoming tenpai one after another) grow each turn; if not in riichi we can switch to fold midway, discounted.
function pushExposure(ctx, win, foldable = true, shanten = 0) {
  return rawPushExposure(ctx, win, foldable, shanten) * ctx.style.risk;
}
function rawPushExposure(ctx, win, foldable, shanten) {
  if (ctx.level === 'basic') return 0;
  if (!ctx.advanced) return foldable ? futureExposure(ctx, shanten)
    : Math.min(ctx.ownDraws, 6) * 0.06 * ctx.threatLoss * ctx.lossScale;
  const T = ctx.ownDraws;
  if (!T) return 0;
  const growth = (ctx.n - 1) * 2 * (foldable ? 0.45 : 1);
  const base = ctx.read.avgDrawLoss * (foldable ? 0.75 : 1);
  let alive = 1;
  let total = 0;
  for (let t = 1; t <= T; t++) {
    alive *= ctx.survival;
    total += alive * Math.max(0, 1 - (win * t) / T) * (base + growth * t);
  }
  return total;
}

// Fold route: discard the safest tiles in hand one by one; later draws and new genbutsu lower the risk, discounted 0.75.
function foldLoss(ctx, counts) {
  return rawFoldLoss(ctx, counts) * ctx.style.risk;
}
function rawFoldLoss(ctx, counts) {
  if (!ctx.advanced) return ctx.level === 'basic' ? 0
    : 0.012 * ctx.threatLoss * ctx.lossScale * Math.min(ctx.ownDraws, 6);
  const losses = [];
  for (let i = 0; i < 34; i++) for (let c = 0; c < counts[i]; c++) losses.push(ctx.read.lossOf[i]);
  losses.sort((a, b) => a - b);
  const T = Math.min(ctx.ownDraws, losses.length);
  let alive = 1;
  let total = 0;
  for (let t = 0; t < T; t++) {
    alive *= ctx.survival;
    total += alive * losses[t] * 0.75;
  }
  return total;
}

// Expected exhaustive-draw tenpai payment at the end of the hand (counted only in the last few turns).
function tenpaiBonus(ctx, win) {
  if (ctx.level === 'basic' || ctx.ownDraws > 4) return 0;
  return Math.pow(ctx.survival, ctx.ownDraws) * Math.max(0, 1 - win) * (ctx.n === 4 ? 1500 : 1000);
}

// Second-order ukeire at 2-shanten (13 tiles): weighted average of "1-shanten ukeire" over all draws that enter 1-shanten.
// The hypothetically drawn tile is no longer in the wall, so later ukeire is computed after subtracting the remaining count of that tile.
// Returns null when the budget is exhausted (the caller uses default ukeire).
function oneShantenQuality(ctx, counts, meldCount, budget = ctx.budget) {
  let weight = 0;
  let total = 0;
  for (let t = 0; t < 34; t++) {
    const r = Math.max(0, ctx.remainOf(t));
    if (!r || counts[t] >= 4) continue;
    const remain = (i) => ctx.remainOf(i) - (i === t ? 1 : 0);
    if (!spendWork(budget, 1)) return null;
    counts[t]++;
    if (shantenOfCounts(counts, meldCount) === 1) {
      let best = 0;
      for (let d = 0; d < 34; d++) {
        if (!counts[d] || d === t) continue;
        if (!spendWork(budget, 1)) { counts[t]--; return null; }
        counts[d]--;
        if (shantenOfCounts(counts, meldCount) === 1) {
          if (!spendWork(budget, WAITS_WORK)) { counts[d]++; counts[t]--; return null; }
          const u = policyWaits(ctx, counts, meldCount, remain).ukeire;
          if (u > best) best = u;
        }
        counts[d]++;
      }
      weight += r;
      total += r * best;
    }
    counts[t]--;
  }
  return weight ? total / weight : DEFAULT_UKEIRE[1];
}

function threatLossOf(engine, seat, danger) {
  if (!danger) return 0;
  let loss = 0;
  for (const player of engine.players) {
    if (player.seat === seat) continue;
    const dealer = player.seat === engine.dealerSeat;
    if (player.riichi) loss = Math.max(loss, dealer ? 8000 : 5600);
    else {
      const open = player.melds.filter((m) => m.type !== 'ankan' && m.type !== 'babei').length;
      if (open >= 2) loss = Math.max(loss, dealer ? 5800 : 3900);
    }
  }
  return loss;
}

function dealInProbability(ctx, kind) {
  if (!ctx.danger) return 0;
  const risk = ctx.danger.riskByKind?.get(kind);
  if (!Number.isFinite(risk)) return 0;
  return Math.min(0.25, risk * 0.0065 * Math.min(1.6, 1 + (ctx.danger.threats - 1) * 0.3));
}

// Each turn, opponents' discards may also deal in to us: each opponent counts as 0.25 effective chances.
// Each turn the hand may also end by an opponent's win (survival rate).
// ronUkeire: ron ukeire weighted by opponents' discard tendencies (advanced); 0 when furiten.
function turnWinChance(ctx, ukeire, ronUkeire = ukeire) {
  const h = Math.min(1, Math.max(0, ukeire) / ctx.unseen);
  const hr = Math.min(1, Math.max(0, ronUkeire) / ctx.unseen);
  return 1 - (1 - h) * Math.pow(1 - hr, RON_CHANCE_PER_OPPONENT * (ctx.n - 1));
}

// Probability of winning by tsumo within draws turns after tenpai.
function tenpaiWin(ctx, ukeire, draws, ronUkeire = null) {
  return winCurve(ctx, 0, ukeire, draws, DEFAULT_UKEIRE[0], null, ronUkeire);
}

// Refined wait quality (advanced): with the same count, honors/terminals and suji of our discards are more likely to be discarded by opponents,
// while middle tiles and dora are more often kept in hand. This only affects ron probability; tsumo still depends on count.
function ronWeight(ctx, idx) {
  if (!ctx.advanced) return 1;
  const kind = indexToKind(idx);
  let w;
  if (idx >= 27) w = 1.25;
  else {
    const rank = (idx % 9) + 1;
    const suit = Math.floor(idx / 9) + 1;
    w = rank === 1 || rank === 9 ? 1.2 : rank === 2 || rank === 8 ? 1.05 : rank === 5 ? 0.85 : 0.92;
    const own = ctx.p.discardKinds;
    if (own && [rank - 3, rank + 3].some((x) => x >= 1 && x <= 9 && own.has(suit * 10 + x))) w *= 1.3;
  }
  if (ctx.doraKinds.has(kind)) w *= 0.7;
  return w;
}

// Permanent missed-ron furiten and our own discard furiten; same-turn furiten is cleared at the next draw and does not extend into future search.
function isFuritenWait(ctx, waits) {
  const own = ctx.p.discardKinds;
  return !!ctx.p.riichiFuriten || !!own && waits.some((idx) => own.has(indexToKind(idx)));
}

// From the shanten and the current stage's ukeire, the probability of winning within draws turns.
// Advance the distribution across shanten stages turn by turn; when the ukeire after entering tenpai is unknown, use a default value (1-shanten may pass the measured average).
// nextUkeire: known ukeire of the next stage (2-shanten second-order ukeire).
function winCurve(ctx, shanten, ukeire, draws, tenpaiUkeire = DEFAULT_UKEIRE[0], nextUkeire = null, ronUkeire = null) {
  if (shanten < 0) return 1;
  if (draws <= 0 || ukeire <= 0) return 0;
  const hits = [];
  for (let k = shanten; k >= 1; k--) {
    const u = k === shanten ? ukeire
      : k === shanten - 1 && nextUkeire != null && k >= 1 ? nextUkeire
        : DEFAULT_UKEIRE[Math.min(k, DEFAULT_UKEIRE.length - 1)];
    hits[k] = Math.min(1, u / ctx.unseen);
  }
  const pw = shanten === 0 ? turnWinChance(ctx, ukeire, ronUkeire ?? ukeire) : turnWinChance(ctx, tenpaiUkeire);
  const dist = new Array(shanten + 1).fill(0);
  dist[shanten] = 1;
  let win = 0;
  for (let t = 0; t < draws; t++) {
    for (let k = 0; k <= shanten; k++) dist[k] *= ctx.survival;
    const w = dist[0] * pw;
    win += w;
    dist[0] -= w;
    for (let k = 1; k <= shanten; k++) {
      const moved = dist[k] * hits[k];
      dist[k] -= moved;
      dist[k - 1] += moved;
    }
  }
  return win;
}

function isYakuhaiIndex(ctx, idx) {
  if (idx < 27) return 0;
  const rank = idx - 26;
  let han = 0;
  if (rank >= 5) han++;
  if (rank === ctx.engine.roundWind) han++;
  if (rank === ctx.engine.seatWindOf(ctx.seat)) han++;
  return han;
}

// Estimate han and points for a win from the current 13-tile hand (after discarding). An open hand with no yaku scores 0.
function estimateValue(ctx, handIds, melds) {
  const open = realMelds(melds).filter((m) => m.type !== 'ankan');
  const menzen = open.length === 0;
  const meldTiles = realMelds(melds).flatMap((m) => m.tiles);
  const all = handIds.concat(meldTiles);
  let dora = 0;
  for (const id of all) {
    dora += ctx.doraTiles.filter((tile) => kindOf(tile) === kindOf(id)).length;
    if (ctx.akaSet && ctx.akaSet.has(id)) dora++;
  }
  const norths = melds.filter((m) => m.type === 'babei').flatMap((m) => m.tiles);
  dora += norths.length;
  dora += norths.reduce((sum, id) => sum + ctx.doraTiles.filter((tile) => kindOf(tile) === kindOf(id)).length, 0);
  const counts = countsOf(handIds);
  let yaku = 0;
  for (const m of realMelds(melds)) {
    const idx = tileIndex(m.tiles[0]);
    if (m.type !== 'chi') yaku += isYakuhaiIndex(ctx, idx);
  }
  for (let idx = 27; idx < 34; idx++) {
    const y = isYakuhaiIndex(ctx, idx);
    if (!y) continue;
    if (counts[idx] >= 3) yaku += y;
    else if (counts[idx] === 2) yaku += 0.45 * y;
  }
  const decoded = all.map(decodeId);
  const yaochu = decoded.filter(({ suit, rank }) => suit === 4 || rank === 1 || rank === 9).length;
  // Tanyao: an open hand must be all simples; a closed hand converts the count of terminals into the probability of forming the shape.
  if (yaochu === 0) yaku += 1;
  else if (menzen) yaku += Math.max(0, 1 - 0.3 * yaochu);
  const suits = new Set(decoded.filter(({ suit }) => suit !== 4).map(({ suit }) => suit));
  const honors = decoded.filter(({ suit }) => suit === 4).length;
  if (suits.size === 1) yaku += honors ? (menzen ? 3 : 2) : (menzen ? 6 : 5);
  if (menzen) yaku += 1.35; // Riichi + tsumo / ippatsu / ura dora expectation
  if (yaku < 0.5 && !menzen) return 0;
  return pointsForHan(yaku + dora, ctx.dealer) + ctx.tableBonus;
}

function tieBreak(ctx, id, handIds) {
  const { suit, rank } = decodeId(id);
  const kind = suit * 10 + rank;
  const cnt = handIds.filter((x) => kindOf(x) === kind).length;
  let s = 0;
  if (suit === 4 && cnt === 1) s += isYakuhaiIndex(ctx, tileIndex(id)) ? 6 : 12;
  if (suit !== 4 && (rank === 1 || rank === 9) && cnt === 1) s += 6;
  if (suit !== 4 && (rank === 2 || rank === 8) && cnt === 1) s += 2;
  if (ctx.p.drawnTile != null && id === ctx.p.drawnTile) s += 1;
  return s;
}

// At 1-shanten: the weighted average "tenpai ukeire" over all draws that enter tenpai (second-order ukeire used by the middle level).
// Middle/high levels pass { budget }: deduct the tile hypothetically drawn and meter by budget; returns null when exhausted.
function tenpaiQuality(ctx, counts, meldCount, opts = null) {
  const budget = opts?.budget || null;
  let weight = 0;
  let total = 0;
  for (let t = 0; t < 34; t++) {
    const r = Math.max(0, ctx.remainOf(t));
    if (!r || counts[t] >= 4) continue;
    const remain = budget ? (i) => ctx.remainOf(i) - (i === t ? 1 : 0) : ctx.remainOf;
    if (budget && !spendWork(budget, 1)) return null;
    counts[t]++;
    if (shantenOfCounts(counts, meldCount) === 0) {
      let best = 0;
      for (let d = 0; d < 34; d++) {
        if (!counts[d]) continue;
        if (budget && !spendWork(budget, 1)) { counts[t]--; return null; }
        counts[d]--;
        if (shantenOfCounts(counts, meldCount) === 0) {
          if (budget && !spendWork(budget, WAITS_WORK)) { counts[d]++; counts[t]--; return null; }
          const u = policyWaits(ctx, counts, meldCount, remain).ukeire;
          if (u > best) best = u;
        }
        counts[d]++;
      }
      weight += r;
      total += r * best;
    }
    counts[t]--;
  }
  return weight ? total / weight : DEFAULT_UKEIRE[0];
}

function futureExposure(ctx, shanten) {
  if (!ctx.danger) return 0;
  const turns = shanten <= 0 ? Math.min(ctx.ownDraws, 4) * 0.6 : (shanten + 1) * 1.5;
  return turns * 0.045 * ctx.threatLoss * ctx.lossScale;
}

// The library does not compute North pull; reuse the authoritative settlement's extra-han formula, keep fu/yakuman, and include the public North dora.
// Only the public indicator is used; ura dora is never read, and no new kan dora is assumed.
function advancedPoints(ctx, win, melds) {
  const norths = melds.filter((m) => m.type === 'babei').flatMap((m) => m.tiles);
  const extra = norths.length + norths.reduce((sum, id) => sum + ctx.doraTiles.filter((d) => kindOf(d) === kindOf(id)).length, 0);
  return ctx.engine.applyExtraFan(win, extra, ctx.dealer).ten || 0;
}

// ---------- Advanced: fixed-budget draw expectation search ----------
// A hypothetical draw on the path (drawn) has left the wall: the remaining counts of waits in later hands must subtract these tiles, and the cache key includes drawn.
// budget: the decision-wide budget object shared across the whole decision (see createDecisionBudget); when a number is passed, it limits only calcWin calls (for tests).
function makeSearch(ctx, melds, budgetArg = null) {
  const budget = typeof budgetArg === 'number'
    ? createDecisionBudget({ calc: budgetArg })
    : budgetArg || ctx.budget || (ctx.budget = createDecisionBudget());
  const meldCount = realMelds(melds).length;
  const menzen = realMelds(melds).every((m) => m.type === 'ankan');
  // Riichi counts only when legal: closed + points ≥ 1000 + enough tiles left (a hand already in riichi carries riichi by definition).
  const riichiValue = (draws) => menzen && (ctx.p.riichi || ctx.riichiOk && ctx.engine.remain - draws * ctx.n >= ctx.n);
  const seatWind = ctx.engine.seatWindOf(ctx.seat);
  const tenpaiMemo = new Map();
  const state = { budget, exhausted: false };
  const ctxAfterCache = new Map();
  // After drawing n tiles, the unseen count in the wall decreases accordingly.
  const ctxAfter = (n) => {
    if (!n) return ctx;
    let c = ctxAfterCache.get(n);
    if (!c) {
      c = Object.create(ctx);
      c.unseen = Math.max(1, ctx.unseen - n);
      ctxAfterCache.set(n, c);
    }
    return c;
  };
  const remainAfter = (drawn) => {
    if (!drawn.length) return ctx.remainOf;
    const taken = new Array(34).fill(0);
    for (const t of drawn) taken[t]++;
    return (i) => ctx.remainOf(i) - taken[i];
  };
  const synthId = (idx, used) => {
    for (let copy = 1; copy <= 4; copy++) {
      const id = indexToTileId(idx, copy);
      if (!used.has(id) && !(ctx.akaSet && ctx.akaSet.has(id))) return id;
    }
    for (let copy = 1; copy <= 4; copy++) {
      const id = indexToTileId(idx, copy);
      if (!used.has(id)) return id;
    }
    return indexToTileId(idx, 1);
  };
  const adjusted = (win) => advancedPoints(ctx, win, melds);
  // Three values for a winning tile: ron under legal riichi (including tsumo/ippatsu/ura expectation), dama ron, and closed tsumo.
  // Compute only what is needed: when riichi is illegal, dama ron is used; if dama has no yaku, only tsumo remains (this wait does not count as ron ukeire).
  // Returns null when the budget is insufficient.
  function waitValue(ids, melds0, tile, drawn) {
    const base = { doraTiles: ctx.doraTiles, roundWind: ctx.engine.roundWind, seatWind };
    if (riichiValue(drawn.length)) {
      if (!spendCalc(budget)) return null;
      const win = calcWin(ids, melds0, ctx.akaSet, { ...base, ronTile: tile, riichi: true });
      return win.hasYaku ? { ten: adjusted(win) * 1.3, ron: true } : { ten: 0, ron: false, none: true };
    }
    if (!spendCalc(budget)) return null;
    const dama = calcWin(ids, melds0, ctx.akaSet, { ...base, ronTile: tile });
    if (dama.hasYaku) return { ten: adjusted(dama) * 1.05, ron: true };
    if (!menzen) return { ten: 0, ron: false, none: true };
    if (!spendCalc(budget)) return null;
    const tsumo = calcWin(ids.concat([tile]), melds0, ctx.akaSet, base);
    return tsumo.hasYaku ? { ten: adjusted(tsumo), ron: false } : { ten: 0, ron: false, none: true };
  }
  // Each wait's point value and effective ukeire for a 13-tile tenpai hand (physical tiles).
  // extra: the tile (kind index) to be discarded on this search path; it also enters the river and may cause furiten.
  // drawn: the tile (kind index) hypothetically drawn on this search path; it has left the wall.
  // Returns null when the budget is exhausted (not cached).
  function tenpaiProfile(ids, extra = [], drawn = []) {
    const counts = countsOf(ids);
    const sorted = (arr) => arr.slice().sort((a, b) => a - b).join(',');
    const red = sorted(ids.filter((id) => ctx.akaSet.has(id)));
    const key = `${counts.join('')}|${red}|${ctx.advanced ? sorted(extra) : ''}|${sorted(drawn)}`;
    const cached = tenpaiMemo.get(key);
    if (cached) return cached;
    if (!spendWork(budget, WAITS_WORK)) { state.exhausted = true; return null; }
    const used = new Set(ids);
    const remain = remainAfter(drawn);
    const w = policyWaits(ctx, counts, meldCount, remain);
    const furiten = ctx.advanced && (isFuritenWait(ctx, w.waits) || w.waits.some((idx) => extra.includes(idx)));
    let ukeire = 0;
    let ronUkeire = 0;
    let points = 0;
    for (const idx of w.waits) {
      const r = Math.max(0, remain(idx));
      if (!r) continue;
      const value = waitValue(ids, melds, synthId(idx, used), drawn);
      if (!value) { state.exhausted = true; return null; }
      if (value.none) continue;
      // After riichi, the expectation of tsumo / ippatsu / ura within the remaining turns is about 0.35 han (already included in waitValue).
      const ten = ctx.gainUtil(value.ten + ctx.tableBonus);
      ukeire += r;
      if (value.ron && !furiten) ronUkeire += r * ronWeight(ctx, idx);
      points += r * ten;
    }
    const profile = { ukeire, ronUkeire, points: ukeire ? points / ukeire : 0 };
    tenpaiMemo.set(key, profile);
    return profile;
  }
  function tenpaiEV(ids, draws, extra = [], drawn = []) {
    const prof = tenpaiProfile(ids, extra, drawn);
    if (!prof) return null;
    return tenpaiWin(ctxAfter(drawn.length), prof.ukeire, draws, prof.ronUkeire) * prof.points;
  }
  // 1-shanten hand: enumerate draws that enter tenpai, choose the best tenpai play for each tile, weighted by the turn of first entering tenpai.
  function oneShantenEV(ids, draws, extra = []) {
    const counts = countsOf(ids);
    const used = new Set(ids);
    const outcomes = [];
    let hitTotal = 0;
    for (let t = 0; t < 34; t++) {
      const r = Math.max(0, ctx.remainOf(t));
      if (!r || counts[t] >= 4) continue;
      if (!spendWork(budget, 1)) { state.exhausted = true; return null; }
      counts[t]++;
      const improves = shantenOfCounts(counts, meldCount) === 0;
      counts[t]--;
      if (!improves) continue;
      const drawn = synthId(t, used);
      const hand14 = ids.concat([drawn]);
      let best = null;
      const tried = new Set();
      for (const id of hand14) {
        const idx = tileIndex(id);
        if (tried.has(idx)) continue;
        tried.add(idx);
        const rest = hand14.slice();
        rest.splice(rest.indexOf(pickIdFromHand(hand14, idx, ctx.akaSet)), 1);
        if (!spendWork(budget, 1)) { state.exhausted = true; return null; }
        if (shantenOfCounts(countsOf(rest), meldCount) !== 0) continue;
        const prof = tenpaiProfile(rest, extra.concat([idx]), [t]);
        if (!prof) return null;
        const score = (prof.ukeire + prof.ronUkeire) * prof.points;
        if (!best || score > best.score) best = { score, prof };
      }
      if (!best) continue;
      outcomes.push({ r, prof: best.prof });
      hitTotal += r;
    }
    if (!hitTotal) return 0;
    const h = Math.min(1, hitTotal / ctx.unseen);
    const after = ctxAfter(1);
    let alive = 1;
    let total = 0;
    for (let j = 1; j <= draws; j++) {
      alive *= ctx.survival;
      let stage = 0;
      for (const o of outcomes) stage += (o.r / hitTotal) * tenpaiWin(after, o.prof.ukeire, draws - j, o.prof.ronUkeire) * o.prof.points;
      total += alive * h * stage;
      alive *= 1 - h;
      if (alive < 1e-4) break;
    }
    return total;
  }
  return { state, tenpaiEV, oneShantenEV, tenpaiProfile };
}

// Number of search candidates (top 8 by rough estimate); search volume is limited by the whole-decision budget, with no separate calcWin cap.
const SEARCH_CANDIDATES = 8;
const QUALITY_CANDIDATES = 5;

// Unified evaluation of discard candidates. Returns { discardId, shanten, ukeire, ev, fold }.
// budget: the whole-decision budget shared by the three levels within one aiTurn/aiClaim.
function chooseDiscardByPolicy(engine, seat, { forbiddenKinds = null, level = 'intermediate', hypothetical = null, budget = null } = {}) {
  const ctx = publicContext(engine, seat, hypothetical, level, budget);
  return chooseDiscardCandidates(ctx, forbiddenKinds);
}

// Advanced discard: read-based deal-in rate + seat utility + fold route + second-order ukeire + draw expectation search.
function chooseDiscardCandidates(ctx, forbiddenKinds) {
  const { p, budget } = ctx;
  const meldCount = realMelds(p.melds).length;
  const counts = countsOf(p.hand);
  const candidates = [];
  for (let idx = 0; idx < 34; idx++) {
    if (!counts[idx]) continue;
    const id = pickIdFromHand(p.hand, idx, ctx.akaSet);
    if (id == null || forbiddenKinds?.has(kindOf(id))) continue;
    counts[idx]--;
    // The mandatory base scan is metered separately; a legal, deterministic fallback is guaranteed even at zero budget.
    budget.baseWork += WAITS_WORK;
    const w = policyWaits(ctx, counts, meldCount);
    const quality = (ctx.level !== 'basic' && w.shanten === 1 ? tenpaiQuality(ctx, counts, meldCount, { budget }) : null) ?? DEFAULT_UKEIRE[0];
    const fold = ctx.threatActive ? -foldLoss(ctx, counts) : -Infinity;
    counts[idx]++;
    const rest = p.hand.slice();
    rest.splice(rest.indexOf(id), 1);
    const value = styledValue(ctx, ctx.gainUtil(estimateValue(ctx, rest, p.melds)));
    const win = winCurve(ctx, w.shanten, w.ukeire, ctx.ownDraws, quality);
    candidates.push({
      id, idx, rest, value, quality,
      shanten: w.shanten,
      ukeire: w.ukeire,
      waits: w.waits,
      win,
      risk: discardRisk(ctx, idx, kindOf(id)),
      push: win * value + (w.shanten === 0 ? tenpaiBonus(ctx, win) : 0) - pushExposure(ctx, win, true, w.shanten),
      foldBase: fold,
      tie: tieBreak(ctx, id, p.hand),
    });
  }
  if (!candidates.length) throw new Error('No legal discard');
  const minShanten = Math.min(...candidates.map((c) => c.shanten));
  // At 2-shanten, use second-order ukeire to correct the win probability (only the top few by rough estimate, to control time).
  if (ctx.advanced && minShanten === 2) {
    const twos = candidates.filter((c) => c.shanten === 2).sort((a, b) => b.push - a.push || a.id - b.id);
    for (const c of twos.slice(0, QUALITY_CANDIDATES)) {
      const cc = countsOf(c.rest);
      const next = oneShantenQuality(ctx, cc, meldCount, budget);
      if (next == null) break; // Budget exhausted: the remaining candidates keep their rough estimate
      c.win = winCurve(ctx, 2, c.ukeire, ctx.ownDraws, DEFAULT_UKEIRE[0], next);
      c.push = c.win * c.value - pushExposure(ctx, c.win);
      c.refined = true;
    }
    const refined = twos.filter((c) => c.refined);
    if (refined.length) {
      const floor = Math.min(...refined.map((x) => x.push));
      for (const c of twos) if (!c.refined) c.push = Math.min(c.push, floor);
    }
  }
  // Within 1-shanten: draw expectation search by real yaku type and points.
  const ranked = candidates.filter((c) => c.shanten <= 1).sort((a, b) => b.push - a.push || a.id - b.id);
  if (ctx.advanced && ranked.length) {
    const search = makeSearch(ctx, p.melds, budget);
    for (const c of ranked.slice(0, SEARCH_CANDIDATES)) {
      const ev = c.shanten === 0 ? search.tenpaiEV(c.rest, ctx.ownDraws, [c.idx]) : search.oneShantenEV(c.rest, ctx.ownDraws, [c.idx]);
      if (ev == null || search.state.exhausted) break;
      c.push = ev + (c.shanten === 0 ? tenpaiBonus(ctx, c.win) : 0) - pushExposure(ctx, c.win);
      c.searched = true;
    }
    const searched = candidates.filter((c) => c.searched);
    if (searched.length) {
      const floor = Math.min(...searched.map((c) => c.push));
      for (const c of candidates) if (!c.searched && c.shanten <= 1) c.push = Math.min(c.push, floor);
    }
  }
  let best = null;
  const { style } = ctx;
  for (const c of candidates) {
    // With no threat, do not drop shanten for points (rough point estimates have large error); with a threat, any tile may be a fold candidate.
    if (!ctx.threatActive && c.shanten > minShanten) continue;
    // Dora-keeping style: giving up a dora while attacking feels expensive.
    const doraCost = style.keepDora && (ctx.doraKinds.has(kindOf(c.id)) || ctx.akaSet?.has(c.id)) ? 500 : 0;
    const pushEV = c.push - c.risk - doraCost;
    const foldEV = c.foldBase - c.risk;
    c.fold = foldEV > pushEV;
    // Seeded noise lets a styled NPC pick among near-equal moves; the neutral AI draws nothing from the RNG.
    const noise = style.jitter && style.rng ? (style.rng() * 2 - 1) * style.jitter : 0;
    c.ev = Math.max(pushEV, foldEV) + c.tie + noise;
    if (!best || c.ev > best.ev || (c.ev === best.ev && c.id < best.id)) best = c;
  }
  return {
    discardId: best.id,
    shanten: best.shanten,
    ukeire: best.ukeire,
    waits: best.waits.map((i) => indexToTileId(i)),
    ev: best.ev,
    fold: best.fold,
    score: best.ev,
    searched: candidates.filter((c) => c.searched).length,
    budget: { calcUsed: budget.calcUsed, workUsed: budget.workUsed, baseWork: budget.baseWork, exhausted: budget.exhausted },
  };
}

// Attack / fold expectation for an undiscarded hand (13 tiles equivalent); the attack side deducts the average deal-in of the next discard.
function handOutlook(ctx, hand, melds, valueScale = 1) {
  const meldCount = realMelds(melds).length;
  ctx.budget.baseWork += WAITS_WORK;
  const counts = countsOf(hand);
  const w = policyWaits(ctx, counts, meldCount);
  const value = styledValue(ctx, ctx.gainUtil(estimateValue(ctx, hand, melds) * valueScale));
  const quality = (ctx.level !== 'basic' && w.shanten === 1
    ? tenpaiQuality(ctx, counts, meldCount, { budget: ctx.budget }) : null) ?? DEFAULT_UKEIRE[0];
  const win = winCurve(ctx, w.shanten, w.ukeire, ctx.ownDraws, quality);
  let meanLoss = 0;
  for (const id of hand) meanLoss += discardRisk(ctx, tileIndex(id), kindOf(id));
  meanLoss /= Math.max(1, hand.length);
  const push = win * value + (w.shanten === 0 ? tenpaiBonus(ctx, win) : 0)
    - pushExposure(ctx, win, true, w.shanten) - meanLoss;
  const fold = ctx.threatActive ? -foldLoss(ctx, counts) : -Infinity;
  return { push, fold, ev: Math.max(push, fold) };
}

// Pot-odds judgement for a 13-tile hand: is the expectation of continuing to attack worse than folding?
function shouldFoldHand(engine, seat, level = 'intermediate', budget = null) {
  const ctx = publicContext(engine, seat, null, level, budget);
  if (!ctx.threatActive) return false;
  const outlook = handOutlook(ctx, ctx.p.hand, ctx.p.melds);
  return outlook.fold > outlook.push;
}

// Calls and skip are compared by the same expectation. options: [{ action, type: 'chi'|'pon'|'kan', used, forbiddenKinds }]
// Chi/pon use the best discard expectation right after the call; open kan uses the hand outlook before the rinshan draw, with the new kan dora expectation counted separately.
// Each call option within one level shares the whole-decision budget, split evenly across options, so the first-evaluated option does not monopolize it.
function claimPolicy(engine, seat, card, options, level = 'intermediate', budget = null) {
  if (!options.length) return null;
  const p = engine.players[seat];
  const shared = budget || createDecisionBudget();
  const passCtx = publicContext(engine, seat, null, level, shared);
  const pass = handOutlook(passCtx, p.hand, p.melds).ev;
  let best = null;
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const hand = p.hand.filter((tile) => !option.used.includes(tile));
    const meld = { type: option.type, tiles: [...option.used, card] };
    const player = { ...p, hand, melds: p.melds.concat([meld]), menzen: false, drawnTile: null };
    const hypothetical = { player, extraSeen: option.used };
    const part = shared ? sliceBudget(shared, options.length - i) : null;
    let ev;
    if (option.type === 'kan') {
      ev = handOutlook(publicContext(engine, seat, hypothetical, level, part), hand, player.melds, 1.2).ev;
    } else {
      try {
        ev = chooseDiscardByPolicy(engine, seat, { forbiddenKinds: option.forbiddenKinds, level, hypothetical, budget: part }).ev;
      } catch {
        if (part) settleBudget(shared, part);
        continue;
      }
    }
    if (part) settleBudget(shared, part);
    ev += passCtx.style.callBias;
    if (ev > pass && (!best || ev > best.ev)) best = { ...option, ev };
  }
  return best;
}

// Riichi / dama expectation comparison. Returns { action: 'riichi'|'dama'|null, card }.
// When the budget is exhausted, stop evaluating later discard kinds (in the order passed, deterministic); return null if none was fully evaluated.
function riichiPolicy(engine, seat, discardKinds, level = 'intermediate', budget = null) {
  const ctx = publicContext(engine, seat, null, level, budget);
  const { p } = ctx;
  const seatWind = engine.seatWindOf(seat);
  let best = null;
  for (const kind of discardKinds) {
    if (!spendWork(ctx.budget, WAITS_WORK)) break;
    const card = p.hand.find((t) => kindOf(t) === kind && !ctx.akaSet.has(t)) ?? p.hand.find((t) => kindOf(t) === kind);
    const hand = p.hand.slice();
    hand.splice(hand.indexOf(card), 1);
    const counts = countsOf(hand);
    const w = policyWaits(ctx, counts, realMelds(p.melds).length);
    const used = new Set(hand);
    let ukeire = 0;
    let ronUkeire = 0;
    let damaRonUkeire = 0;
    let riichiPts = 0;
    let damaPts = 0;
    let damaUkeire = 0;
    // The discarded tile also enters the river: containing a wait means furiten (advanced).
    const furiten = isFuritenWait(ctx, w.waits) || w.waits.some((idx) => indexToKind(idx) === kind);
    let complete = true;
    for (const idx of w.waits) {
      const r = Math.max(0, ctx.remainOf(idx));
      if (!r) continue;
      if (!spendCalc(ctx.budget, 2)) { complete = false; break; }
      const rw = furiten ? 0 : r * ronWeight(ctx, idx);
      let ron = indexToTileId(idx, 1);
      for (let copy = 1; copy <= 4 && used.has(ron); copy++) ron = indexToTileId(idx, copy);
      const base = { ronTile: ron, doraTiles: ctx.doraTiles, roundWind: engine.roundWind, seatWind };
      const r1 = calcWin(hand, p.melds, ctx.akaSet, { ...base, riichi: true });
      const r0 = calcWin(hand, p.melds, ctx.akaSet, base);
      ukeire += r;
      ronUkeire += rw;
      riichiPts += r * advancedPoints(ctx, r1, p.melds);
      if (r0.hasYaku) {
        damaUkeire += r; damaRonUkeire += rw;
        damaPts += r * advancedPoints(ctx, r0, p.melds);
      }
    }
    if (!complete) break;
    const candidate = {
      card,
      ukeire,
      ronUkeire,
      damaRonUkeire,
      waitCount: w.waits.length,
      riichiPts: ukeire ? riichiPts / ukeire : 0,
      damaPts: damaUkeire ? damaPts / damaUkeire : 0,
      damaUkeire,
      risk: discardRisk(ctx, tileIndex(card), kind),
    };
    const score = (candidate.ukeire + candidate.ronUkeire) * candidate.riichiPts - candidate.risk * 10;
    if (!best || score > best.score || (score === best.score && card < best.card)) best = { ...candidate, score };
  }
  if (!best) return null;
  return riichiDecisionByPolicy(ctx, best);
}

// Advanced riichi/dama: after riichi, all subsequent turns are tsumogiri and cannot fold (future threats are fully borne); dama keeps the fold option;
// if both are worse than folding, leave it to discard evaluation (which may break tenpai to fold).
function riichiDecisionByPolicy(ctx, best) {
  const { engine, p } = ctx;
  const draws = ctx.ownDraws;
  // After riichi, the opponents defend, so the ron ukeire is discounted.
  const winR = tenpaiWin(ctx, best.ukeire, draws, best.ronUkeire * 0.85);
  const riichiEV = winR * ctx.gainUtil(best.riichiPts * 1.25 + 1000 + ctx.tableBonus) - 1000
    + tenpaiBonus(ctx, winR) - pushExposure(ctx, winR, false) - best.risk;
  let damaEV = -Infinity;
  if (best.damaUkeire) {
    const winD = tenpaiWin(ctx, best.damaUkeire, draws, best.damaRonUkeire);
    damaEV = winD * ctx.gainUtil(best.damaPts + ctx.tableBonus)
      + tenpaiBonus(ctx, winD) - pushExposure(ctx, winD, true) - best.risk;
  }
  const scores = engine.players.map((pl) => pl.score);
  const lead = p.score - Math.max(...scores.filter((_, s) => s !== ctx.seat));
  if (ctx.level !== 'basic' && best.damaUkeire && engine.isAllLast() && lead >= 8000) return { action: 'dama', card: best.card };
  if (ctx.threatActive) {
    const counts = countsOf(p.hand);
    counts[tileIndex(best.card)]--;
    const foldEV = -foldLoss(ctx, counts) - best.risk;
    if (foldEV > Math.max(riichiEV, damaEV)) return null;
  }
  if (damaEV >= riichiEV + ctx.style.riichiBias) return { action: 'dama', card: best.card };
  return { action: 'riichi', card: best.card };
}

export {
  normalizeAiLevel,
  resolveStyle,
  readThreats,
  placementUtility,
  publicContext,
  winCurve,
  tenpaiWin,
  estimateValue,
  tenpaiQuality,
  tieBreak,
  DEFAULT_UKEIRE,
  chooseDiscardByPolicy,
  shouldFoldHand,
  claimPolicy,
  riichiPolicy,
  makeSearch,
  createDecisionBudget,
  SEARCH_CANDIDATES,
  DECISION_CALC_BUDGET,
  DECISION_WORK_BUDGET,
};
