// AI 难度对战基准：两种难度各占两席（三麻时 2:1 轮换），固定种子批量自战，
// 每个种子把座位轮换一遍以抵消座次和牌山差异，输出平均分差、平均顺位和耗时。
// 用法：node tools/ai_benchmark.mjs [A=intermediate] [B=basic] [种子数=40] [players=4] [east|hanchan] [起始种子=1000]
import { performance } from 'node:perf_hooks';
import { GameEngine } from '../mockjs/engine.mjs';

const [levelA = 'intermediate', levelB = 'basic', seedArg = '40', playersArg = '4', length = 'east', seedStartArg = '1000'] = process.argv.slice(2);
const seeds = Number(seedArg);
const players = Number(playersArg);

async function playOne(seed, levels) {
  let finalScores = null;
  const engine = new GameEngine({
    players,
    startScore: players === 3 ? 35000 : 25000,
    speed: 0,
    seed,
    matchLength: length,
    autoHuman: true,
    aiLevels: levels,
    emit: () => {},
    onFinish: (scores) => { finalScores = scores.slice(); },
  });
  await engine.start();
  return finalScores || engine.players.map((p) => p.score);
}

const stats = { [levelA]: { delta: 0, place: 0, n: 0 }, [levelB]: { delta: 0, place: 0, n: 0 } };
const start = performance.now();
for (let s = 0; s < seeds; s++) {
  const seed = Number(seedStartArg) + s;
  for (let rot = 0; rot < players; rot++) {
    const levels = Array.from({ length: players }, (_, seat) => ((seat + rot) % 2 === 0 ? levelA : levelB));
    const scores = await playOne(seed, levels);
    const order = scores.map((score, seat) => ({ score, seat })).sort((a, b) => b.score - a.score || a.seat - b.seat);
    const start0 = players === 3 ? 35000 : 25000;
    scores.forEach((score, seat) => {
      const st = stats[levels[seat]];
      st.delta += score - start0;
      st.place += order.findIndex((o) => o.seat === seat) + 1;
      st.n++;
    });
  }
}
const elapsed = performance.now() - start;
for (const [level, st] of Object.entries(stats)) {
  console.log(`${level.padEnd(13)} 局数=${st.n} 平均得失=${(st.delta / st.n).toFixed(0)} 平均顺位=${(st.place / st.n).toFixed(3)}`);
}
console.log(`耗时 ${(elapsed / 1000).toFixed(1)}s`);
