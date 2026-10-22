import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GameEngine } from '../mockjs/engine.mjs';
import { PlayAction } from '../mockjs/proto_enum.mjs';
import { chooseDiscardByPolicy, riichiPolicy, createDecisionBudget, resolveStyle } from '../mockjs/riichi_ai_policy.mjs';
import { NPCS, NPC_UID_BASE, pickNpcs } from '../mockjs/npc_roster.mjs';
import { mulberry32 } from '../mockjs/engine.mjs';

// Real character → [skin, avatar] pairs from the client config (MjWTbMahjongWarrior / MjWTbSkin / PlayerInfoTbHead).
const REAL_SKINS = {
  1: [[1001, 1001], [3701002, 1009]], 2: [[2001, 1002], [3702002, 1007]], 3: [[3001, 1003], [3703002, 1008]],
  4: [[4001, 1004], [3704002, 1010]], 5: [[5001, 1005], [3705002, 1012]], 6: [[6001, 1006], [3706002, 1013]],
  7: [[7001, 1015], [3707002, 1016]], 8: [[8001, 1017], [3708002, 1018]], 9: [[9001, 1011], [3709002, 1014]],
  10: [[10001, 1019]],
};
const styleOf = (nick) => NPCS.find((npc) => npc.nick === nick).style;

test('19 名 NPC 各占一套真实皮肤，风格轴都在 1..5', () => {
  assert.equal(NPCS.length, 19);
  assert.equal(new Set(NPCS.map((npc) => npc.id)).size, 19);
  assert.equal(new Set(NPCS.map((npc) => npc.nick)).size, 19);
  const allSkins = Object.values(REAL_SKINS).flat();
  assert.equal(allSkins.length, 19);
  assert.deepEqual(NPCS.map((npc) => npc.skin).sort(), allSkins.map(([skin]) => skin).sort());
  for (const npc of NPCS) {
    assert.ok(REAL_SKINS[npc.warrior].some(([skin, head]) => skin === npc.skin && head === npc.head), npc.nick);
    for (const axis of ['attack', 'call', 'riichi', 'value']) {
      assert.ok(npc.style[axis] >= 1 && npc.style[axis] <= 5, `${npc.nick}.${axis}`);
    }
  }
});

test('配桌不撞玩家角色、同桌角色不重复，同种子结果一致', () => {
  for (let human = 1; human <= 10; human++) for (let seed = 1; seed <= 30; seed++) for (const count of [2, 3]) {
    const a = pickNpcs(mulberry32(seed), { count, humanWarrior: human, roomId: 4 });
    const b = pickNpcs(mulberry32(seed), { count, humanWarrior: human, roomId: 4 });
    assert.deepEqual(a, b);
    assert.equal(a.length, count);
    assert.ok(a.every((r) => r.warrior !== human));
    assert.equal(new Set(a.map((r) => r.warrior)).size, count);
    assert.ok(a.every((r) => r.uid === NPC_UID_BASE + r.npc && r.level >= 17 && r.level <= 22));
  }
});

test('NPC 显示段位在玩家段位附近，且不低于段位房间的准入下限', () => {
  const rooms = { 1: [1, 13], 2: [11, 16], 3: [14, 22], 4: [17, 22] };
  for (const [roomId, [min, max]] of Object.entries(rooms)) for (let level = min; level <= max; level++) {
    for (let seed = 1; seed <= 20; seed++) {
      for (const r of pickNpcs(mulberry32(seed), { count: 3, humanWarrior: 1, roomId: Number(roomId), humanLevel: level })) {
        assert.ok(r.level >= min && r.level <= max, `room ${roomId} level ${r.level}`);
        assert.ok(Math.abs(r.level - level) <= 2, `room ${roomId} human ${level} npc ${r.level}`);
      }
    }
  }
});

test('情景特性在满值基础上仍然生效（后半更敢押、追立直）', () => {
  const style = (nick) => NPCS.find((npc) => npc.nick === nick).style;
  const engineWith = (s, extra) => ({ aiStyles: [null, s], dealerSeat: 0, remain: 60, sanma: false, roundWind: 2, players: [], ...extra });
  const koromo = style('Koromo');
  assert.ok(resolveStyle(engineWith(koromo, { remain: 20 }), 1).risk < resolveStyle(engineWith(koromo), 1).risk);
  const toyone = style('Toyone');
  const chased = { players: [{ seat: 0, riichi: true }, { seat: 1, riichi: false }] };
  assert.ok(resolveStyle(engineWith(toyone, chased), 1).riichiBias > resolveStyle(engineWith(toyone), 1).riichiBias);
});

async function playMatch({ seed, styles, level = 'intermediate', players = 4, onEngine }) {
  const hash = createHash('sha256');
  const startScore = players === 3 ? 35_000 : 25_000;
  const engine = new GameEngine({
    players, seed, startScore, speed: 0, autoHuman: true, matchLength: 'east', maxHands: 64,
    aiLevel: level, aiStyles: styles,
    // gameID carries a wall-clock timestamp; everything else must replay identically.
    emit(event, payload) { hash.update(`${event}:${JSON.stringify(payload, (k, v) => (k === 'gameID' ? undefined : v))}\n`); },
  });
  onEngine?.(engine);
  await engine.start();
  assert.ok(engine.matchOver);
  assert.equal(engine.scores.reduce((sum, s) => sum + s, 0) + engine.riichiSticks * 1000, players * startScore);
  return { engine, digest: hash.digest('hex') };
}

test('每名 NPC 的风格都能打完整场且点棒守恒，同种子重放完全一致', async () => {
  for (let i = 0; i < NPCS.length; i += 3) {
    const styles = [null, ...[0, 1, 2].map((k) => NPCS[(i + k) % NPCS.length].style)];
    const seed = 500 + i;
    const first = await playMatch({ seed, styles });
    const again = await playMatch({ seed, styles });
    assert.equal(first.digest, again.digest, `seed ${seed}`);
  }
  // Styles actually change play compared with the neutral table.
  const styled = await playMatch({ seed: 77, styles: [null, styleOf('Kana'), styleOf('Awai'), styleOf('Hisa')] });
  const neutral = await playMatch({ seed: 77, styles: null });
  assert.notEqual(styled.digest, neutral.digest);
});

// Paired comparison: play neutral matches and, at every decision point, ask what each style would choose in the very same position.
// Probes drop jitter so the comparison measures the style axes only; the neutral game itself is never changed by the probes.
const PROBES = ['Yuuki', 'Awai', 'Hisa', 'Momo', 'Kana', 'Mihoko'];
async function probeStats(seeds) {
  const stats = Object.fromEntries(PROBES.map((nick) => [nick, { calls: 0, claims: 0, riichi: 0, dama: 0, folds: 0, threatened: 0 }]));
  const asStyle = (engine, seat, nick, fn) => {
    const saved = engine.aiStyles[seat];
    engine.aiStyles[seat] = { ...styleOf(nick), jitter: undefined };
    try { return fn(); } finally { engine.aiStyles[seat] = saved; }
  };
  for (const seed of seeds) {
    await playMatch({
      seed, styles: null,
      onEngine(engine) {
        const aiTurn = engine.aiTurn.bind(engine);
        engine.aiTurn = (seat, drew, can, cantPlays) => {
          const p = engine.players[seat];
          const level = engine.aiLevelOf(seat);
          for (const nick of PROBES) asStyle(engine, seat, nick, () => {
            const s = stats[nick];
            // Hopeless hands fold under any style; the attack axis matters when the hand is close (1-shanten or better).
            if (!p.riichi && engine.dangerKinds(seat) && engine.currentShanten(p) <= 1) {
              s.threatened++;
              if (chooseDiscardByPolicy(engine, seat, { level, budget: createDecisionBudget() }).fold) s.folds++;
            }
            if (can.includes(PlayAction.Riichi)) {
              const decision = riichiPolicy(engine, seat, engine.formalTenpaiDiscards(p), level, createDecisionBudget());
              if (decision?.action === 'riichi') s.riichi++;
              if (decision?.action === 'dama') s.dama++;
            }
          });
          return aiTurn(seat, drew, can, cantPlays);
        };
        const aiClaim = engine.aiClaim.bind(engine);
        engine.aiClaim = (seat, from, card, can) => {
          if (!can.includes(PlayAction.Hu) && (can.includes(PlayAction.Chi) || can.includes(PlayAction.Peng))) {
            for (const nick of PROBES) asStyle(engine, seat, nick, () => {
              const choice = engine.aiClaimByPolicy(seat, card, can, engine.aiLevelOf(seat));
              stats[nick].claims++;
              if (choice && (choice.action === PlayAction.Chi || choice.action === PlayAction.Peng)) stats[nick].calls++;
            });
          }
          return aiClaim(seat, from, card, can);
        };
      },
    });
  }
  return stats;
}

test('风格差异明显：同一局面下副露、立直、押引三项方向正确', async () => {
  const s = await probeStats([11, 12, 13, 14, 15, 16]);
  const rate = (a, b) => (b ? a / b : 0);
  const call = (n) => rate(s[n].calls, s[n].claims);
  const riichi = (n) => rate(s[n].riichi, s[n].riichi + s[n].dama);
  const fold = (n) => rate(s[n].folds, s[n].threatened);
  assert.ok(call('Yuuki') > call('Awai') * 2, `call ${call('Yuuki')} vs ${call('Awai')}`);
  // Many tenpai hands have no yaku for dama (riichi is forced), so compare how often each style chooses dama.
  assert.ok(1 - riichi('Momo') > (1 - riichi('Hisa')) * 1.8, `riichi ${riichi('Hisa')} vs ${riichi('Momo')}`);
  assert.ok(fold('Mihoko') > fold('Kana') * 1.3, `fold ${fold('Mihoko')} vs ${fold('Kana')}`);
  // "Noticeable but not absurd": even the most closed style still calls sometimes, the dama lover still riichis, the pusher still folds.
  assert.ok(call('Awai') > 0 || s.Awai.claims < 50, 'Awai never calls');
  assert.ok(riichi('Momo') > 0.1, `Momo riichi ${riichi('Momo')}`);
  assert.ok(fold('Kana') > 0.2, `Kana fold ${fold('Kana')}`);
  console.log(JSON.stringify(Object.fromEntries(PROBES.map((n) => [n, { call: call(n).toFixed(2), riichi: riichi(n).toFixed(2), fold: fold(n).toFixed(2) }]))));
});
