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

test('不变量辅助自检：复制实体牌即使总数不变也必须报错', () => {
  const engine = completeFixture();
  assertInvariants(engine);
  engine.wall[1] = engine.wall[0];
  assert.throws(() => assertInvariants(engine), /实体牌重复/);
});

test('不变量辅助自检：同时打开摸打和鸣牌窗口必须报错', () => {
  const engine = completeFixture();
  engine._expectedDraw = { seat: 0, actions: [PlayAction.Normal] };
  engine._expectedClaim = { seat: 0, discarderSeat: 1, actions: [PlayAction.Guo] };
  assert.throws(() => assertInvariants(engine), /动作窗口并存/);
});

test('不变量辅助自检：两个可弃牌座位或动作执行座位错误必须报错', () => {
  const engine = completeFixture();
  engine.players[0].hand = engine.wall.splice(0, 14);
  assertInvariants(engine, { expectedActor: 0 });
  assert.throws(() => assertInvariants(engine, { expectedActor: 1 }), /当前行动者错误/);
  engine.players[1].hand = engine.wall.splice(0, 14);
  assert.throws(() => assertInvariants(engine), /当前行动者不唯一/);
});

test('不变量辅助自检：非法动作返回错误却只提交一半必须报错', () => {
  const engine = completeFixture();
  // 人为模拟旧实现先改手牌再返回错误；辅助必须识别部分提交。
  engine.submitDraw = () => {
    engine.players[0].hand.push(engine.wall.shift());
    return Result.Fail_CardNotInHand;
  };
  assert.throws(() => assertRejectedUnchanged(engine, 'submitDraw', { card: 999 }), /非法动作部分提交/);
});

test('不变量辅助自检：宝牌区、封存尾牌和点数也在检查范围内', () => {
  const engine = completeFixture();
  engine.deadWall[5] = engine.wall[0];
  assert.throws(() => assertInvariants(engine), /实体牌重复/);
  const scores = completeFixture();
  scores.players[0].score--;
  assert.throws(() => assertInvariants(scores), /点数加供托/);
  const missing = completeFixture();
  missing.wall.pop();
  assert.throws(() => assertInvariants(missing), /实体牌总数/);
});

for (const players of [3, 4]) for (const matchLength of ['east', 'hanchan']) {
  test(`${players}人${matchLength === 'east' ? '东风' : '半庄'}多种子自战逐提交检查全局不变量与非法输入不变性`, async () => {
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
      // 驱动正常真人入口提交 AI 建议，不更改引擎判定/行动执行/返回值。
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
          // 同牌种的伪实体或对手实体不能冒充自己的牌。
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
        // 同窗已消费，重放必须失败，连缓冲/供托/计时状态也不得改变。
        assertRejectedUnchanged(this, method, payload, Result.Fail_InvalidSequence);
        return pending;
      };
      await engine.start();
      observer.check();
      assert.ok(engine.matchOver && engine.handIndex < 64, '必须按正式规则结束');
      assert.ok(draws > 0 && claims > 0);
      for (const boundary of ['discard:入口提交', 'expectDraw:返回提交', 'submitDraw:返回提交',
        'submitClaim:返回提交', 'prepareFinalResult:入口提交', 'finishHand:入口提交']) {
        assert.ok(observer.counts.get(boundary) > 0, `未检查 ${boundary}`);
      }
    }
  });
}

test('错误座位无法建立真人窗口，经两个提交入口均拒绝且状态不变', () => {
  const engine = completeFixture();
  // ReqPlayCard/ReqQiangCard 协议没有客户端 seat；座位来自可信窗口。
  for (const seat of [1, 2, 3, -1, 4]) {
    engine.expectDraw(seat, true, [PlayAction.Normal]);
    assertRejectedUnchanged(engine, 'submitDraw', { action: PlayAction.Normal, card: 111 }, Result.Fail_InvalidSequence);
    engine.expectClaim(seat, 0, 111, [PlayAction.Guo]);
    assertRejectedUnchanged(engine, 'submitClaim', { action: PlayAction.Guo }, Result.Fail_InvalidSequence);
  }
});
