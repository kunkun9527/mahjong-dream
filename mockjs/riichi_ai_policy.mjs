// 立直 AI 分级策略：中级 = 统一候选期望值评估（牌效、打点、放铳、押引、顺位），
// 高级 = 中级框架 + 读牌模型（riichi_ai_read.mjs：听牌概率、待牌形组合放铳率、对手打点）
// + 顺位效用 + 弃和路线估值 + 二向听二阶牌效 + 固定预算的摸牌期望搜索（一向听以内按真实役种/点数估值）。
// 只读取自家手牌与公开信息（牌河及顺序/摸切、副露、宝牌指示牌、分数、余牌数），
// 不读对手暗手、牌山或里宝；同一局面结果确定，可复现。
import { decodeId, doraFromIndicator } from './tiles.mjs';
import { tileIndex, indexToTileId, countsOf, shantenOfCounts, waitsOfCounts } from './shanten.mjs';
import { calcWin, realMelds, kindOf, pickIdFromHand } from './ai.mjs';
import { readThreats, indexToKind } from './riichi_ai_read.mjs';

const AI_LEVELS = ['basic', 'intermediate', 'advanced'];
function normalizeAiLevel(level) {
  return AI_LEVELS.includes(level) ? level : 'intermediate';
}

// 子家荣和点数（按番数近似，30~40 符）；庄家 ×1.5。
const KO_POINTS = [0, 1000, 2000, 3900, 7700, 8000, 12000, 12000, 16000, 16000, 16000, 24000, 24000, 32000];
function pointsForHan(han, dealer) {
  const h = Math.max(0, Math.min(13, han));
  const lo = Math.floor(h);
  const hi = Math.min(13, lo + 1);
  const base = KO_POINTS[lo] + (KO_POINTS[hi] - KO_POINTS[lo]) * (h - lo);
  return base * (dealer ? 1.5 : 1);
}

// 各向听阶段在不知道具体牌形时假定的受入枚数（下一阶段用）。
const DEFAULT_UKEIRE = [6, 18, 30, 40, 48, 54, 60, 60, 60];
// 每次摸牌之间他家打出的牌也可能荣和：每家按 0.35 次有效机会计。
const RON_CHANCE_PER_OPPONENT = 0.25;

// hypothetical：拟鸣牌后的假想手牌 { player, extraSeen }；extraSeen 为移入新副露、
// 尚未计入公开牌的自家实体牌（只影响剩余枚数）。
function publicContext(engine, seat, hypothetical = null, level = 'intermediate') {
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
  // 顺位修正：All Last 领先时放铳代价更高、打点价值更低；末位则相反。
  let gainScale = 1;
  let lossScale = 1;
  if (allLast) {
    const lead = p.score - Math.max(...others);
    if (placement === 0 && lead > 0) {
      lossScale = 1 + Math.min(1, lead / 8000);
      gainScale = 0.7;
    } else if (placement === n - 1) {
      gainScale = 1.25;
      lossScale = 0.8;
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
    gainUtil: (v) => v,
    advanced: false,
  };
  if (level === 'advanced') attachAdvanced(ctx);
  return ctx;
}

// ---------- 高级：读牌、顺位效用、弃和与推进的风险估值 ----------
// 顺位马（只在 All Last 参与效用）。
const PLACEMENT_UMA = { 3: [15000, 0, -15000], 4: [15000, 5000, -5000, -15000] };

function placementUtility(engine, seat) {
  if (!engine.isAllLast()) return null;
  const scores = engine.players.map((pl) => pl.score);
  const n = scores.length;
  const uma = PLACEMENT_UMA[n] || PLACEMENT_UMA[4];
  const rankOf = (arr) => arr.filter((v, j) => j !== seat && (v > arr[seat] || (v === arr[seat] && j < seat))).length;
  const base = uma[rankOf(scores)];
  // 自己得 d 点、other 失 d 点后的马差。
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
  // 至少有一家较可能听牌时才考虑弃和路线。
  ctx.threatActive = read.tenpaiMass >= 0.25;
  // 每巡牌局因他家和牌结束的概率随对手听牌概率上升。
  ctx.survival = 1 - Math.min(0.25, 0.015 * (ctx.n - 1) + 0.08 * read.tenpaiMass);
  ctx.gainScale = 1;
  ctx.lossScale = 1;
}

// 打出某种牌的期望放铳损失（已含顺位修正）。
function discardRisk(ctx, idx, kind) {
  if (ctx.advanced) return ctx.read.lossOf[idx];
  return dealInProbability(ctx, kind) * ctx.threatLoss * ctx.lossScale;
}

// 继续进攻时今后各巡打牌的累计放铳损失：当前威胁按随机摸到牌的平均风险，
// 未来威胁（他家陆续听牌）逐巡增长；未立直时可中途转弃和，折算。
function pushExposure(ctx, win, foldable = true) {
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

// 弃和路线：依次打出手中最安全的牌；之后摸到的牌和新增现物会降低风险，折算 0.75。
function foldLoss(ctx, counts) {
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

// 末盘听牌的流局听牌料期望（只在最后几巡计入）。
function tenpaiBonus(ctx, win) {
  if (ctx.ownDraws > 4) return 0;
  return Math.pow(ctx.survival, ctx.ownDraws) * Math.max(0, 1 - win) * (ctx.n === 4 ? 1500 : 1000);
}

// 二向听（13 张）的二阶牌效：所有进入一向听的摸牌加权平均“一向听受入”。
function oneShantenQuality(ctx, counts, meldCount) {
  let weight = 0;
  let total = 0;
  for (let t = 0; t < 34; t++) {
    const r = Math.max(0, ctx.remainOf(t));
    if (!r || counts[t] >= 4) continue;
    counts[t]++;
    if (shantenOfCounts(counts, meldCount) === 1) {
      let best = 0;
      for (let d = 0; d < 34; d++) {
        if (!counts[d] || d === t) continue;
        counts[d]--;
        if (shantenOfCounts(counts, meldCount) === 1) {
          const u = waitsOfCounts(counts, meldCount, ctx.remainOf).ukeire;
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

// 每巡他家打出的牌也可能放铳给自己：每家按 0.25 次有效机会计。
// 每巡牌局还可能因他家和牌而结束（存活率 survival）。
// ronUkeire：按他家打出倾向加权的荣和受入（高级）；振听时为 0。
function turnWinChance(ctx, ukeire, ronUkeire = ukeire) {
  const h = Math.min(1, Math.max(0, ukeire) / ctx.unseen);
  const hr = Math.min(1, Math.max(0, ronUkeire) / ctx.unseen);
  return 1 - (1 - h) * Math.pow(1 - hr, RON_CHANCE_PER_OPPONENT * (ctx.n - 1));
}

// 听牌后 draws 巡内和牌的概率。
function tenpaiWin(ctx, ukeire, draws, ronUkeire = null) {
  return winCurve(ctx, 0, ukeire, draws, DEFAULT_UKEIRE[0], null, ronUkeire);
}

// 待牌质量细分（高级）：同样枚数下，字牌/幺九、自家舍牌的筋牌更容易被他家打出，
// 中张与宝牌更常被留在手里。只影响荣和概率，自摸仍按枚数。
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

// 自家舍牌含任一待牌即振听：只能自摸。
function isFuritenWait(ctx, waits) {
  const own = ctx.p.discardKinds;
  return !!own && waits.some((idx) => own.has(indexToKind(idx)));
}

// 从 shanten 向听、本阶段受入 ukeire 出发，draws 巡内和牌的概率。
// 逐巡推进各向听阶段的分布；进听后的受入未知时用默认值（一向听可传入实测平均值）。
// nextUkeire：已知的下一阶段受入（二向听的二阶牌效）。
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

// 根据当前（打出后 13 张）手牌粗估和牌时的番数与点数。开门且没有役的路线视为 0 分。
function estimateValue(ctx, handIds, melds) {
  const open = realMelds(melds).filter((m) => m.type !== 'ankan');
  const menzen = open.length === 0;
  const meldTiles = realMelds(melds).flatMap((m) => m.tiles);
  const all = handIds.concat(meldTiles);
  let dora = 0;
  for (const id of all) {
    if (ctx.doraKinds.has(kindOf(id))) dora++;
    if (ctx.akaSet && ctx.akaSet.has(id)) dora++;
  }
  dora += melds.filter((m) => m.type === 'babei').length;
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
  // 断幺九：开门必须已全中张；门清按幺九张数折算成型概率。
  if (yaochu === 0) yaku += 1;
  else if (menzen) yaku += Math.max(0, 1 - 0.3 * yaochu);
  const suits = new Set(decoded.filter(({ suit }) => suit !== 4).map(({ suit }) => suit));
  const honors = decoded.filter(({ suit }) => suit === 4).length;
  if (suits.size === 1) yaku += honors ? (menzen ? 3 : 2) : (menzen ? 6 : 5);
  if (menzen) yaku += 1.35; // 立直 + 自摸/一发/里宝的期望
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

// 一向听时：所有进听牌的加权平均“听牌受入”（中级用的二阶牌效）。
function tenpaiQuality(ctx, counts, meldCount) {
  let weight = 0;
  let total = 0;
  for (let t = 0; t < 34; t++) {
    const r = Math.max(0, ctx.remainOf(t));
    if (!r || counts[t] >= 4) continue;
    counts[t]++;
    if (shantenOfCounts(counts, meldCount) === 0) {
      let best = 0;
      for (let d = 0; d < 34; d++) {
        if (!counts[d]) continue;
        counts[d]--;
        if (shantenOfCounts(counts, meldCount) === 0) {
          const u = waitsOfCounts(counts, meldCount, ctx.remainOf).ukeire;
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

// ---------- 高级：固定预算的摸牌期望搜索 ----------
function makeSearch(ctx, melds, budget) {
  const meldCount = realMelds(melds).length;
  const menzen = realMelds(melds).every((m) => m.type === 'ankan');
  const seatWind = ctx.engine.seatWindOf(ctx.seat);
  // 拔北（三麻北抜き）不进 calcWin，按额外宝牌番数补算。
  const nukiDora = melds.filter((m) => m.type === 'babei').length;
  const tenpaiMemo = new Map();
  const state = { calls: 0, budget, exhausted: false };
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
  // 听牌手（13 张实体）的各待牌点数与有效受入。
  // extra：本次搜索路径上将要打出的牌（牌种下标），也会进入牌河而导致振听。
  function tenpaiProfile(ids, extra = []) {
    const counts = countsOf(ids);
    const key = ctx.advanced ? `${counts.join('')}|${extra.slice().sort((a, b) => a - b).join(',')}` : counts.join('');
    const cached = tenpaiMemo.get(key);
    if (cached) return cached;
    const used = new Set(ids);
    const w = waitsOfCounts(counts, meldCount, ctx.remainOf);
    const furiten = ctx.advanced && (isFuritenWait(ctx, w.waits) || w.waits.some((idx) => extra.includes(idx)));
    let ukeire = 0;
    let ronUkeire = 0;
    let points = 0;
    for (const idx of w.waits) {
      const r = Math.max(0, ctx.remainOf(idx));
      if (!r) continue;
      if (state.calls >= state.budget) { state.exhausted = true; break; }
      state.calls++;
      const win = calcWin(ids, melds, ctx.akaSet, {
        ronTile: synthId(idx, used),
        riichi: menzen,
        doraTiles: ctx.doraTiles,
        roundWind: ctx.engine.roundWind,
        seatWind,
      });
      if (!win.hasYaku) continue;
      const base = nukiDora ? Math.max(win.ten, pointsForHan(win.han + nukiDora, ctx.dealer)) : win.ten;
      // 立直时再计自摸/一发/里宝的期望约 0.35 番。
      const ten = ctx.gainUtil(base * (menzen ? 1.3 : 1.05) + ctx.tableBonus);
      ukeire += r;
      if (!furiten) ronUkeire += r * ronWeight(ctx, idx);
      points += r * ten;
    }
    const profile = { ukeire, ronUkeire, points: ukeire ? points / ukeire : 0 };
    tenpaiMemo.set(key, profile);
    return profile;
  }
  function tenpaiEV(ids, draws, extra = []) {
    const prof = tenpaiProfile(ids, extra);
    return tenpaiWin(ctx, prof.ukeire, draws, prof.ronUkeire) * prof.points;
  }
  // 一向听手：枚举进听摸牌，每张选最佳听牌打法，按首次进听时刻加权。
  function oneShantenEV(ids, draws, extra = []) {
    const counts = countsOf(ids);
    const used = new Set(ids);
    const outcomes = [];
    let hitTotal = 0;
    for (let t = 0; t < 34; t++) {
      const r = Math.max(0, ctx.remainOf(t));
      if (!r || counts[t] >= 4) continue;
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
        if (shantenOfCounts(countsOf(rest), meldCount) !== 0) continue;
        const prof = tenpaiProfile(rest, extra.concat([idx]));
        const score = (prof.ukeire + prof.ronUkeire) * prof.points;
        if (!best || score > best.score) best = { score, prof };
        if (state.exhausted) return null;
      }
      if (!best) continue;
      outcomes.push({ r, prof: best.prof });
      hitTotal += r;
    }
    if (!hitTotal) return 0;
    const h = Math.min(1, hitTotal / ctx.unseen);
    let alive = 1;
    let total = 0;
    for (let j = 1; j <= draws; j++) {
      alive *= ctx.survival;
      let stage = 0;
      for (const o of outcomes) stage += (o.r / hitTotal) * tenpaiWin(ctx, o.prof.ukeire, draws - j, o.prof.ronUkeire) * o.prof.points;
      total += alive * h * stage;
      alive *= 1 - h;
      if (alive < 1e-4) break;
    }
    return total;
  }
  return { state, tenpaiEV, oneShantenEV, tenpaiProfile };
}

const SEARCH_BUDGET = 1200;
const SEARCH_CANDIDATES = 8;
const QUALITY_CANDIDATES = 5;

// 打牌候选统一评估。返回 { discardId, shanten, ukeire, ev, fold }。
function chooseDiscardByPolicy(engine, seat, { forbiddenKinds = null, level = 'intermediate', hypothetical = null } = {}) {
  const ctx = publicContext(engine, seat, hypothetical, level);
  if (ctx.advanced) return chooseDiscardAdvanced(ctx, forbiddenKinds);
  const { p } = ctx;
  const meldCount = realMelds(p.melds).length;
  const counts = countsOf(p.hand);
  const candidates = [];
  for (let idx = 0; idx < 34; idx++) {
    if (!counts[idx]) continue;
    const id = pickIdFromHand(p.hand, idx, ctx.akaSet);
    if (id == null || forbiddenKinds?.has(kindOf(id))) continue;
    counts[idx]--;
    const w = waitsOfCounts(counts, meldCount, ctx.remainOf);
    const quality = w.shanten === 1 ? tenpaiQuality(ctx, counts, meldCount) : DEFAULT_UKEIRE[0];
    counts[idx]++;
    const rest = p.hand.slice();
    rest.splice(rest.indexOf(id), 1);
    const value = estimateValue(ctx, rest, p.melds) * ctx.gainScale;
    const win = winCurve(ctx, w.shanten, w.ukeire, ctx.ownDraws, quality);
    const risk = dealInProbability(ctx, kindOf(id)) * ctx.threatLoss * ctx.lossScale;
    const push = win * value - futureExposure(ctx, w.shanten);
    const foldBase = ctx.danger ? -0.012 * ctx.threatLoss * ctx.lossScale * Math.min(ctx.ownDraws, 6) : -Infinity;
    candidates.push({
      id, idx, rest,
      shanten: w.shanten,
      ukeire: w.ukeire,
      waits: w.waits,
      win, value, risk, push, foldBase,
      tie: tieBreak(ctx, id, p.hand),
    });
  }
  if (!candidates.length) throw new Error('没有合法的可打牌');
  if (level === 'advanced') {
    const ranked = candidates.slice().sort((a, b) => b.push - a.push || a.id - b.id);
    const search = makeSearch(ctx, p.melds, SEARCH_BUDGET);
    for (const c of ranked.slice(0, SEARCH_CANDIDATES)) {
      if (c.shanten > 1) continue;
      const ev = c.shanten === 0 ? search.tenpaiEV(c.rest, ctx.ownDraws) : search.oneShantenEV(c.rest, ctx.ownDraws);
      if (ev == null || search.state.exhausted) break;
      c.push = ev * ctx.gainScale - futureExposure(ctx, c.shanten);
      c.searched = true;
    }
    // 搜索值与粗估值量纲不同：未搜索到的一向听以内候选不得凭粗估反超已搜索候选。
    const searched = candidates.filter((c) => c.searched);
    if (searched.length) {
      const floor = Math.min(...searched.map((c) => c.push));
      for (const c of candidates) if (!c.searched && c.shanten <= 1) c.push = Math.min(c.push, floor);
    }
  }
  // 无威胁时不为打点退向听；有威胁时最多退两向听（弃和用）。
  const minShanten = Math.min(...candidates.map((c) => c.shanten));
  const maxLoss = ctx.danger ? 2 : 0;
  let best = null;
  for (const c of candidates) {
    if (c.shanten > minShanten + maxLoss && !(ctx.danger && c.risk === 0)) continue;
    const pushEV = c.push - c.risk;
    const foldEV = c.foldBase - c.risk;
    c.fold = foldEV > pushEV;
    c.ev = Math.max(pushEV, foldEV) + c.tie;
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
  };
}

// 高级弃牌：读牌放铳率 + 顺位效用 + 弃和路线 + 二阶牌效 + 摸牌期望搜索。
function chooseDiscardAdvanced(ctx, forbiddenKinds) {
  const { p } = ctx;
  const meldCount = realMelds(p.melds).length;
  const counts = countsOf(p.hand);
  const candidates = [];
  for (let idx = 0; idx < 34; idx++) {
    if (!counts[idx]) continue;
    const id = pickIdFromHand(p.hand, idx, ctx.akaSet);
    if (id == null || forbiddenKinds?.has(kindOf(id))) continue;
    counts[idx]--;
    const w = waitsOfCounts(counts, meldCount, ctx.remainOf);
    const quality = w.shanten === 1 ? tenpaiQuality(ctx, counts, meldCount) : DEFAULT_UKEIRE[0];
    const fold = ctx.threatActive ? -foldLoss(ctx, counts) : -Infinity;
    counts[idx]++;
    const rest = p.hand.slice();
    rest.splice(rest.indexOf(id), 1);
    const value = ctx.gainUtil(estimateValue(ctx, rest, p.melds));
    const win = winCurve(ctx, w.shanten, w.ukeire, ctx.ownDraws, quality);
    candidates.push({
      id, idx, rest, value, quality,
      shanten: w.shanten,
      ukeire: w.ukeire,
      waits: w.waits,
      win,
      risk: discardRisk(ctx, idx, kindOf(id)),
      push: win * value + (w.shanten === 0 ? tenpaiBonus(ctx, win) : 0) - pushExposure(ctx, win),
      foldBase: fold,
      tie: tieBreak(ctx, id, p.hand),
    });
  }
  if (!candidates.length) throw new Error('没有合法的可打牌');
  const minShanten = Math.min(...candidates.map((c) => c.shanten));
  // 二向听时用二阶牌效修正和牌概率（只算粗估最好的几张，控制耗时）。
  if (minShanten === 2) {
    const twos = candidates.filter((c) => c.shanten === 2).sort((a, b) => b.push - a.push || a.id - b.id);
    for (const c of twos.slice(0, QUALITY_CANDIDATES)) {
      const cc = countsOf(c.rest);
      const next = oneShantenQuality(ctx, cc, meldCount);
      c.win = winCurve(ctx, 2, c.ukeire, ctx.ownDraws, DEFAULT_UKEIRE[0], next);
      c.push = c.win * c.value - pushExposure(ctx, c.win);
      c.refined = true;
    }
    for (const c of twos.slice(QUALITY_CANDIDATES)) {
      const floor = Math.min(...twos.slice(0, QUALITY_CANDIDATES).map((x) => x.push));
      c.push = Math.min(c.push, floor);
    }
  }
  // 一向听以内：按真实役种/点数做摸牌期望搜索。
  const ranked = candidates.filter((c) => c.shanten <= 1).sort((a, b) => b.push - a.push || a.id - b.id);
  if (ranked.length) {
    const search = makeSearch(ctx, p.melds, SEARCH_BUDGET);
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
  for (const c of candidates) {
    // 没有威胁时不为打点退向听（粗估打点误差大）；有威胁时任何牌都可作弃和候选。
    if (!ctx.threatActive && c.shanten > minShanten) continue;
    const pushEV = c.push - c.risk;
    const foldEV = c.foldBase - c.risk;
    c.fold = foldEV > pushEV;
    c.ev = Math.max(pushEV, foldEV) + c.tie;
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
  };
}

// 未打牌（13 张当量）手牌的进攻/弃和期望；进攻侧扣除下一打的平均放铳。
function handOutlook(ctx, hand, melds, valueScale = 1) {
  const meldCount = realMelds(melds).length;
  const w = waitsOfCounts(countsOf(hand), meldCount, ctx.remainOf);
  if (ctx.advanced) {
    const counts = countsOf(hand);
    const value = ctx.gainUtil(estimateValue(ctx, hand, melds) * valueScale);
    const quality = w.shanten === 1 ? tenpaiQuality(ctx, counts, meldCount) : DEFAULT_UKEIRE[0];
    const win = winCurve(ctx, w.shanten, w.ukeire, ctx.ownDraws, quality);
    let meanLoss = 0;
    for (const id of hand) meanLoss += ctx.read.lossOf[tileIndex(id)];
    meanLoss /= Math.max(1, hand.length);
    const push = win * value + (w.shanten === 0 ? tenpaiBonus(ctx, win) : 0) - pushExposure(ctx, win) - meanLoss;
    const fold = ctx.threatActive ? -foldLoss(ctx, counts) : -Infinity;
    return { push, fold, ev: Math.max(push, fold) };
  }
  const value = estimateValue(ctx, hand, melds) * ctx.gainScale * valueScale;
  const win = winCurve(ctx, w.shanten, w.ukeire, ctx.ownDraws);
  const nextRisk = ctx.danger ? 0.06 * ctx.threatLoss * ctx.lossScale : 0;
  const push = win * value - futureExposure(ctx, w.shanten) - nextRisk;
  const fold = ctx.danger ? -0.012 * ctx.threatLoss * ctx.lossScale * Math.min(ctx.ownDraws, 6) : -Infinity;
  return { push, fold, ev: Math.max(push, fold) };
}

// 13 张手牌下的押引判断：继续进攻的期望是否不如弃和。
function shouldFoldHand(engine, seat, level = 'intermediate') {
  const ctx = publicContext(engine, seat, null, level);
  if (ctx.advanced ? !ctx.threatActive : !ctx.danger) return false;
  const outlook = handOutlook(ctx, ctx.p.hand, ctx.p.melds);
  return outlook.fold > outlook.push;
}

// 鸣牌与跳过用同一期望值比较。options：[{ action, type: 'chi'|'pon'|'kan', used, forbiddenKinds }]。
// 吃/碰按鸣后立即打出的最佳弃牌期望；大明杠按岭上补牌前的手牌展望，另计新杠宝期望。
function claimPolicy(engine, seat, card, options, level = 'intermediate') {
  if (!options.length) return null;
  const p = engine.players[seat];
  const passCtx = publicContext(engine, seat, null, level);
  const pass = handOutlook(passCtx, p.hand, p.melds).ev;
  let best = null;
  for (const option of options) {
    const hand = p.hand.filter((tile) => !option.used.includes(tile));
    const meld = { type: option.type, tiles: [...option.used, card] };
    const player = { ...p, hand, melds: p.melds.concat([meld]), menzen: false, drawnTile: null };
    const hypothetical = { player, extraSeen: option.used };
    let ev;
    if (option.type === 'kan') {
      ev = handOutlook(publicContext(engine, seat, hypothetical, level), hand, player.melds, 1.2).ev;
    } else {
      try {
        ev = chooseDiscardByPolicy(engine, seat, { forbiddenKinds: option.forbiddenKinds, level, hypothetical }).ev;
      } catch {
        continue;
      }
    }
    if (ev > pass && (!best || ev > best.ev)) best = { ...option, ev };
  }
  return best;
}

// 立直/默听期望比较。返回 { action: 'riichi'|'dama'|null, card }。
function riichiPolicy(engine, seat, discardKinds, level = 'intermediate') {
  const ctx = publicContext(engine, seat, null, level);
  const { p } = ctx;
  const seatWind = engine.seatWindOf(seat);
  let best = null;
  for (const kind of discardKinds) {
    const card = p.hand.find((t) => kindOf(t) === kind && !ctx.akaSet.has(t)) ?? p.hand.find((t) => kindOf(t) === kind);
    const hand = p.hand.slice();
    hand.splice(hand.indexOf(card), 1);
    const counts = countsOf(hand);
    const w = waitsOfCounts(counts, realMelds(p.melds).length, ctx.remainOf);
    const used = new Set(hand);
    let ukeire = 0;
    let ronUkeire = 0;
    let damaRonUkeire = 0;
    let riichiPts = 0;
    let damaPts = 0;
    let damaUkeire = 0;
    // 打出的这张也进入牌河：含待牌即振听（高级）。
    const furiten = ctx.advanced && (isFuritenWait(ctx, w.waits) || w.waits.some((idx) => indexToKind(idx) === kind));
    for (const idx of w.waits) {
      const r = Math.max(0, ctx.remainOf(idx));
      if (!r) continue;
      const rw = furiten ? 0 : r * ronWeight(ctx, idx);
      let ron = indexToTileId(idx, 1);
      for (let copy = 1; copy <= 4 && used.has(ron); copy++) ron = indexToTileId(idx, copy);
      const base = { ronTile: ron, doraTiles: ctx.doraTiles, roundWind: engine.roundWind, seatWind };
      const r1 = calcWin(hand, p.melds, ctx.akaSet, { ...base, riichi: true });
      const r0 = calcWin(hand, p.melds, ctx.akaSet, base);
      ukeire += r;
      ronUkeire += rw;
      riichiPts += r * (r1.ten || 0);
      if (r0.hasYaku) { damaUkeire += r; damaRonUkeire += rw; damaPts += r * r0.ten; }
    }
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
    const score = ctx.advanced
      ? (candidate.ukeire + candidate.ronUkeire) * candidate.riichiPts - candidate.risk * 10
      : candidate.ukeire * candidate.riichiPts - candidate.risk * 10;
    if (!best || score > best.score || (score === best.score && card < best.card)) best = { ...candidate, score };
  }
  if (!best) return null;
  const draws = ctx.ownDraws;
  const winR = tenpaiWin(ctx, best.ukeire, draws);
  if (ctx.advanced) return riichiAdvanced(ctx, best);
  // 立直：多 1 番期望、对手更易弃和，但放弃押引（全程摸切）并支付立直棒。
  const riichiEV = winR * (best.riichiPts * 1.25 + 1000 + ctx.tableBonus) * ctx.gainScale - 1000
    - (ctx.danger ? Math.min(draws, 6) * 0.06 * ctx.threatLoss * ctx.lossScale : 0) - best.risk;
  const damaEV = best.damaUkeire
    ? tenpaiWin(ctx, best.damaUkeire, draws) * 0.92 * (best.damaPts + ctx.tableBonus) * ctx.gainScale
      - futureExposure(ctx, 0) - best.risk
    : -Infinity;
  // All Last 领先且默听有役：锁定顺位，不再加注。
  const scores = engine.players.map((pl) => pl.score);
  const lead = p.score - Math.max(...scores.filter((_, s) => s !== seat));
  if (best.damaUkeire && engine.isAllLast() && lead >= 8000) return { action: 'dama', card: best.card };
  if (damaEV >= riichiEV) return { action: 'dama', card: best.card };
  if (riichiEV < -1000 && ctx.danger) return null;
  return { action: 'riichi', card: best.card };
}

// 高级立直/默听：立直后全程摸切不能弃和（未来威胁全额承担），默听保留弃和选项；
// 两者都不如弃和时交给弃牌评估（可能拆听弃和）。
function riichiAdvanced(ctx, best) {
  const { engine, p } = ctx;
  const draws = ctx.ownDraws;
  // 立直后他家会防守，荣和受入打折。
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
  if (best.damaUkeire && engine.isAllLast() && lead >= 8000) return { action: 'dama', card: best.card };
  if (ctx.threatActive) {
    const counts = countsOf(p.hand);
    counts[tileIndex(best.card)]--;
    const foldEV = -foldLoss(ctx, counts) - best.risk;
    if (foldEV > Math.max(riichiEV, damaEV)) return null;
  }
  if (damaEV >= riichiEV) return { action: 'dama', card: best.card };
  return { action: 'riichi', card: best.card };
}

export {
  normalizeAiLevel,
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
};
