import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../mockjs/engine.mjs';
import { buildWall } from '../mockjs/tiles.mjs';
import { PlayAction, Result, RiichiMsg } from '../mockjs/proto_enum.mjs';
import { assertInvariants, assertRejectedUnchanged, observeCommits } from './helpers/invariants.mjs';

function completeFixture() {
  const engine = new GameEngine({ players: 4 });
  const tiles = buildWall().tiles;
  engine.deadWall = tiles.slice(-14);
  engine.replacements = engine.deadWall.slice(0, 4);
  engine.wall = tiles.slice(0, -14);
  engine.remain = engine.wall.length;
  engine.players = Array.from({ length: 4 }, (_, seat) => ({
    seat, isHuman: seat === 0, score: 25_000, hand: [], discards: [], melds: [],
  }));
  return engine;
}

test('invariant helper self-check: a duplicated physical tile must be reported even when the total is unchanged', () => {
  const engine = completeFixture();
  assertInvariants(engine);
  engine.wall[1] = engine.wall[0];
  assert.throws(() => assertInvariants(engine), /Duplicate physical tile/);
});

test('invariant helper self-check: an open draw window and claim window at the same time must be reported', () => {
  const engine = completeFixture();
  engine._expectedDraw = { seat: 0, actions: [PlayAction.Normal] };
  engine._expectedClaim = { seat: 0, discarderSeat: 1, actions: [PlayAction.Guo] };
  assert.throws(() => assertInvariants(engine), /Action windows overlap/);
});

test('invariant helper self-check: two discardable seats, or an action executed from the wrong seat, must be reported', () => {
  const engine = completeFixture();
  engine.players[0].hand = engine.wall.splice(0, 14);
  assertInvariants(engine, { expectedActor: 0 });
  assert.throws(() => assertInvariants(engine, { expectedActor: 1 }), /Wrong current actor/);
  engine.players[1].hand = engine.wall.splice(0, 14);
  assert.throws(() => assertInvariants(engine), /Multiple current actors/);
});

test('invariant helper self-check: an illegal action that returns an error but commits half its changes must be reported', () => {
  const engine = completeFixture();
  // Deliberately simulates an old implementation that changed the hand before returning an error; the helper must recognize partial commits.
  engine.submitDraw = () => {
    engine.players[0].hand.push(engine.wall.shift());
    return Result.Fail_CardNotInHand;
  };
  assert.throws(() => assertRejectedUnchanged(engine, 'submitDraw', { card: 999 }), /partially committed an illegal action/);
});

test('invariant helper self-check: the dead wall, sealed tail tiles and scores are also within the checked scope', () => {
  const engine = completeFixture();
  engine.deadWall[5] = engine.wall[0];
  assert.throws(() => assertInvariants(engine), /Duplicate physical tile/);
  const scores = completeFixture();
  scores.players[0].score--;
  assert.throws(() => assertInvariants(scores), /Points plus riichi sticks/);
  const missing = completeFixture();
  missing.wall.pop();
  assert.throws(() => assertInvariants(missing), /Physical tile count mismatch/);
});

for (const players of [3, 4]) for (const matchLength of ['east', 'hanchan']) {
  test(`${players}-player ${matchLength === 'east' ? 'east-only' : 'hanchan'} multi-seed self-play: check global invariants on every commit and immutability on illegal input`, async () => {
    for (const seed of [31, 32, 33]) {
      const engine = new GameEngine({
        players, matchLength, seed, startScore: players === 3 ? 35_000 : 25_000,
        speed: 0, maxHands: 64,
        emit(event) { if (event === RiichiMsg.ENtfToPrepare) engine.submitPrepare(); },
      });
      const observer = observeCommits(engine);
      const wait = engine.waitHuman;
      let draws = 0;
      let claims = 0;
      // Drives the normal human entry to submit the AI suggestion, without changing the engine's judgement / action execution / return values.
      engine.waitHuman = function (kind) {
        const pending = wait.call(this, kind);
        const method = kind === 'draw' ? 'submitDraw' : 'submitClaim';
        const otherMethod = kind === 'draw' ? 'submitClaim' : 'submitDraw';
        const window = kind === 'draw' ? this._expectedDraw : this._expectedClaim;
        assertRejectedUnchanged(this, otherMethod, { action: PlayAction.Guo }, Result.Fail_InvalidSequence);
        assertRejectedUnchanged(this, method, { action: 999 }, kind === 'draw'
          ? Result.Fail_ActionNotInCanPlayActions : Result.Fail_ActionNotInCanQiangActions);
        let payload;
        if (kind === 'draw') {
          draws++;
          assertRejectedUnchanged(this, method, { action: PlayAction.Normal, card: 999 }, Result.Fail_CardNotInHand);
          // A fake or opponent physical tile of the same kind cannot pass as one's own tile.
          const foreign = this.players[1].hand.find((id) => !this.players[0].hand.includes(id));
          assertRejectedUnchanged(this, method, { action: PlayAction.Normal, card: foreign }, Result.Fail_CardNotInHand);
          payload = this.aiTurn(window.seat, window.drew, window.actions, window.cantPlays);
        } else {
          claims++;
          const action = window.actions.find((value) => [PlayAction.Chi, PlayAction.Peng, PlayAction.MingGang].includes(value));
          if (action != null) {
            assertRejectedUnchanged(this, method, { action, otherCards: [999, 999] }, Result.Fail_InvalidOtherCards);
          }
          payload = this.aiClaim(window.seat, window.discarderSeat, window.card, window.actions)
            || { action: PlayAction.Guo, otherCards: [] };
        }
        assert.equal(this[method](payload), Result.Succ);
        // The same window has already been consumed; replay must fail, and even the buffer / reserve / timer state must not change.
        assertRejectedUnchanged(this, method, payload, Result.Fail_InvalidSequence);
        return pending;
      };
      await engine.start();
      observer.check();
      assert.ok(engine.matchOver && engine.handIndex < 64, 'must end under the official rules');
      assert.ok(draws > 0 && claims > 0);
      for (const boundary of ['discard:entry commit', 'expectDraw:return commit', 'submitDraw:return commit',
        'submitClaim:return commit', 'prepareFinalResult:entry commit', 'finishHand:entry commit']) {
        assert.ok(observer.counts.get(boundary) > 0, `not checked ${boundary}`);
      }
    }
  });
}

test('a wrong seat cannot open a human window; both submit entries reject it and the state is unchanged', () => {
  const engine = completeFixture();
  // ReqPlayCard / ReqQiangCard protocols have no client seat; the seat comes from the trusted window.
  for (const seat of [1, 2, 3, -1, 4]) {
    engine.expectDraw(seat, true, [PlayAction.Normal]);
    assertRejectedUnchanged(engine, 'submitDraw', { action: PlayAction.Normal, card: 111 }, Result.Fail_InvalidSequence);
    engine.expectClaim(seat, 0, 111, [PlayAction.Guo]);
    assertRejectedUnchanged(engine, 'submitClaim', { action: PlayAction.Guo }, Result.Fail_InvalidSequence);
  }
});
