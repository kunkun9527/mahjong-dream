// Settlement-title demo (tools/demo_settlement.mjs injects this into game.html; never part of the shipped game).
// The human seat is played by the AI at a quick pace, and every win is settled as a canned, self-consistent
// result for the chosen han level, so the client plays that level's settlement animation.
// ?demo=mangan|haneman|baiman|sanbaiman|yakuman|all  (all = each win takes the next level in turn)
(function () {
  'use strict';
  var LEVELS = {
    mangan: { han: 5, yaku: { '立直': '1飜', '門前清自摸和': '1飜', '平和': '1飜', '断么九': '1飜', '一盃口': '1飜' } },
    haneman: { han: 6, yaku: { '立直': '1飜', '門前清自摸和': '1飜', '平和': '1飜', '断么九': '1飜', '三色同順': '2飜' } },
    baiman: { han: 8, yaku: { '立直': '1飜', '一発': '1飜', '門前清自摸和': '1飜', '平和': '1飜', '断么九': '1飜', '一盃口': '1飜', '三色同順': '2飜' } },
    sanbaiman: { han: 11, yaku: { '立直': '1飜', '一発': '1飜', '門前清自摸和': '1飜', '平和': '1飜', '一盃口': '1飜', '清一色': '6飜' } },
    yakuman: { han: 13, yakuman: 1, yaku: { '四暗刻': '役満' } },
  };
  var ORDER = ['mangan', 'haneman', 'baiman', 'sanbaiman', 'yakuman'];
  var HUMAN_DELAY_MS = 400;
  var requested = new URLSearchParams(location.search).get('demo') || 'all';
  if (requested !== 'all' && !LEVELS[requested]) requested = 'all';
  var state = window.__mjDemo = { level: requested, started: 0, wins: [], patched: false };

  function nextLevel() {
    return requested === 'all' ? ORDER[state.wins.length % ORDER.length] : requested;
  }
  function canned(level, isDealerWin) {
    var spec = LEVELS[level];
    var base = spec.yakuman ? 8000 : spec.han >= 11 ? 6000 : spec.han >= 8 ? 4000 : spec.han >= 6 ? 3000 : 2000;
    var c = function (x) { return Math.ceil(x / 100) * 100; };
    // Same shape as the riichi library's calc(): a yakuman reports han 0 / fu 0 with the yakuman count and name.
    var dealerShare = c(base * 2), childShare = c(base);
    return { isAgari: true, han: spec.yakuman ? 0 : spec.han, fu: spec.yakuman ? 0 : 30, yakuman: spec.yakuman || 0,
      name: spec.yakuman ? '役満' : '', yaku: Object.assign({}, spec.yaku), ten: c(base * (isDealerWin ? 6 : 4)),
      oya: [dealerShare, dealerShare, dealerShare], ko: [dealerShare, childShare, childShare] };
  }

  var PASS = null;
  function patch(GameEngine) {
    var proto = GameEngine.prototype;
    var start = proto.start, endHand = proto.endHand;
    var countDora = proto.countDora, applyExtraFan = proto.applyExtraFan, arm = proto._armHumanTimer;
    var decideGameOver = proto.decideGameOver, finishHand = proto.finishHand;
    if (!start || !endHand || !countDora || !applyExtraFan || !arm || !proto.aiTurn || !proto.aiClaim ||
        !decideGameOver || !finishHand) {
      throw new Error('[demo] engine API changed; update tools/settlement-demo-page.js');
    }
    proto.start = function () { state.started++; return start.apply(this, arguments); };
    // endHand scores every winner synchronously (countDora → applyExtraFan) before its first await, so the flag is
    // raised only for that synchronous stretch: the AI's own hand evaluation never sees canned values.
    proto.endHand = function (res) {
      this.__demoSettling = !!res && res.type !== 'draw';
      try { return endHand.apply(this, arguments); } finally { this.__demoSettling = false; }
    };
    proto.countDora = function () {
      var result = countDora.apply(this, arguments);
      if (!this.__demoSettling) return result;
      for (var key in result) if (typeof result[key] === 'number') result[key] = 0;
      return result;
    };
    proto.applyExtraFan = function (w, extraFan, isDealerWin) {
      if (!this.__demoSettling) return applyExtraFan.apply(this, arguments);
      var level = nextLevel();
      state.wins.push(level);
      console.log('[demo] settling win #' + state.wins.length + ' as ' + level);
      return canned(level, isDealerWin);
    };
    // The match never ends, so every level can be shown in one sitting: East hands repeat, and when anyone runs low
    // the next hand starts from the original scores again.
    proto.decideGameOver = function () { return false; };
    proto.finishHand = function () {
      var engine = this;
      return Promise.resolve(finishHand.apply(this, arguments)).then(function () {
        if (engine.roundWind > 1) engine.roundWind = 1;
        if (Math.min.apply(null, engine.scores) < 1000) engine.scores = engine.scores.map(function () { return engine.startScore; });
      });
    };
    // Instead of a countdown, the AI decides for the human seat shortly after the client shows the turn.
    proto._armHumanTimer = function (pending) {
      var engine = this;
      pending.timer = setTimeout(function () {
        if (engine._pending !== pending) return;
        if (pending.kind === 'draw' && engine._expectedDraw) {
          var exp = engine._expectedDraw;
          var d = engine.aiTurn(0, exp.drew, exp.actions, exp.cantPlays);
          engine.submitDraw({ action: d.action, card: d.card });
        } else if (pending.kind === 'claim' && engine._expectedClaim) {
          var claim = engine._expectedClaim;
          var c = engine.aiClaim(0, claim.discarderSeat, claim.card, claim.actions);
          engine.submitClaim(c ? { action: c.action, otherCards: c.otherCards || [] } : { action: PASS, otherCards: [] });
        } else {
          arm.call(engine, pending);
        }
      }, HUMAN_DELAY_MS);
    };
    state.patched = true;
  }

  // The backend scripts load after Unity starts downloading; wait for them however long that takes.
  (function wait() {
    var riichi = window.__mj && window.__mj.riichi;
    if (riichi && riichi.GameEngine) {
      PASS = riichi.PlayAction.Guo;
      patch(riichi.GameEngine);
      console.log('[demo] settlement demo ready: ' + requested);
      return;
    }
    setTimeout(wait, 100);
  })();
})();
