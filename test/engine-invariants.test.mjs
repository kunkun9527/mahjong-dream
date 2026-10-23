import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../mockjs/engine.mjs';
import { buildWall } from '../mockjs/tiles.mjs';
import { RiichiMsg } from '../mockjs/proto_enum.mjs';

// Checked only at stable boundaries of match notifications; during the prepare phase remain is not yet synced, and during settlement
// the commits of scores and players.score do not happen at the same moment, so it should not be treated as in-match state.
const stableEvents = new Set([
  RiichiMsg.ENtfGameStart, RiichiMsg.ENtfSendCard, RiichiMsg.ENtfPlayCard,
  RiichiMsg.ENtfQiangCard, RiichiMsg.ENtfQiangCardEnd,
]);

test('four-mode multi-seed self-play keeps physical tiles unique and tile count and points conserved at notification boundaries', async () => {
  for (const players of [3, 4]) for (const matchLength of ['east', 'hanchan']) {
    for (const seed of [31, 32, 33, 34, 35]) {
      const sanma = players === 3;
      const startScore = sanma ? 35_000 : 25_000;
      const legalIds = new Set(buildWall({ sanma }).tiles);
      const replacementCount = sanma ? 8 : 4;
      let checked = 0;
      const engine = new GameEngine({
        players, matchLength, seed, startScore, speed: 0, autoHuman: true,
        maxHands: 64,
        emit(event) {
          if (!stableEvents.has(event)) return;
          const label = `${players}/${matchLength}/seed=${seed}/hand=${engine.handIndex}/event=${event}`;
          const owned = engine.players.flatMap((p) => [
            ...p.hand, ...p.discards, ...p.melds.flatMap((meld) => meld.tiles),
          ]);
          const live = [...owned, ...engine.wall, ...engine.replacements];
          assert.equal(new Set(live).size, live.length, `Duplicate physical tile: ${label}`);
          assert.ok(live.every((id) => legalIds.has(id)), `Illegal physical tile: ${label}`);
          // The engine keeps ten dora / ura-dora indicator tiles; each replacement draw seals one wall-tail tile.
          const sealedTail = replacementCount - engine.replacements.length;
          assert.equal(live.length + 10 + sealedTail, legalIds.size, `Physical tile count: ${label}`);
          assert.equal(engine.remain, engine.wall.length, `Remaining wall tiles: ${label}`);
          assert.equal(engine.players.reduce((sum, p) => sum + p.score, 0)
            + engine.riichiSticks * 1000, players * startScore, `Points plus riichi sticks: ${label}`);
          assert.ok(!(engine._expectedDraw && engine._expectedClaim), `Both action windows open at once: ${label}`);
          checked++;
        },
      });
      await engine.start();
      assert.ok(checked > 0);
      assert.ok(engine.matchOver);
      assert.ok(engine.handIndex < 64, 'must not end the official match by hitting the debug hand cap');
      assert.equal(engine.scores.reduce((sum, score) => sum + score, 0)
        + engine.riichiSticks * 1000, players * startScore);
    }
  }
});
