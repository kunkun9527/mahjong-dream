import test from 'node:test';
import assert from 'node:assert/strict';
import { calcWin } from '../mockjs/ai.mjs';
import { tiles, engineFixture } from './helpers/riichi-fixtures.mjs';

function score(text, { tsumo = false, melds = [], ...opts } = {}) {
  const reserved = new Set(melds.flatMap((meld) => meld.tiles));
  const hand = tiles(text).map((tile) => {
    while (reserved.has(tile)) tile++;
    assert.ok(tile % 10 <= 4, '测试手牌和副露不得共用实体或超过四张');
    reserved.add(tile);
    return tile;
  });
  const ronTile = tsumo ? null : hand.pop();
  return calcWin(hand, melds, new Set(), { roundWind: 1, seatWind: 2, ronTile, ...opts });
}

for (const [name, hand, opts, expected] of [
  ['立直', '123456m123p789s55p', { riichi: true }, { '立直': '1飜' }],
  ['双立直与一发', '123456m123p55p789s', { doubleRiichi: true, ippatsu: true }, { 'ダブル立直': '2飜', '一発': '1飜' }],
  ['门清自摸与平和', '123456m123p55p789s', { tsumo: true }, { '門前清自摸和': '1飜', '平和': '1飜' }],
  ['断幺九', '234456m234p55p678s', {}, { '断么九': '1飜' }],
  ['一杯口', '123123m456p55p789s', {}, { '一盃口': '1飜' }],
  ['二杯口不重复一杯口或七对子', '123123m789789s55p', {}, { '二盃口': '3飜' }],
  ['三色同顺', '123m123p123s55p789s', {}, { '三色同順': '2飜' }],
  ['一气通贯', '123456789m55p789s', {}, { '一気通貫': '2飜' }],
  ['混全带幺九与白', '123m123p789s555z77z', {}, { '混全帯么九': '2飜', '役牌白': '1飜' }],
  ['纯全带幺九', '123m123p789s999p11s', {}, { '純全帯么九': '3飜' }],
  ['混一色', '123456789m111z22z', {}, { '混一色': '3飜' }],
  ['清一色', '123456789222m55m', {}, { '清一色': '6飜' }],
  ['七对子固定二番', '1122m3344p5566s77z', {}, { '七対子': '2飜' }],
  ['海底摸月', '123456m123p55p789s', { tsumo: true, haidi: true }, { '海底摸月': '1飜' }],
  ['河底捞鱼', '123456m123p55p789s', { haidi: true }, { '河底撈魚': '1飜' }],
  ['抢加杠', '123456m123p55p789s', { chankan: true }, { '搶槓': '1飜' }],
  ['役牌场风与自风复合', '123m456p789s111z22z', { seatWind: 1 }, { '場風東': '1飜', '自風東': '1飜' }],
  ['对对和与三暗刻', '222p333s555z77z', { melds: [{ type: 'pon', tiles: tiles('111m') }] }, { '対々和': '2飜', '三暗刻': '2飜' }],
  ['开门断幺九', '456m234p55p678s', { melds: [{ type: 'chi', tiles: tiles('234m') }] }, { '断么九': '1飜' }],
  ['开门三色同顺减一番', '123p123s55p789s', { melds: [{ type: 'chi', tiles: tiles('123m') }] }, { '三色同順': '1飜' }],
]) {
  test(`常见役计分：${name}由实际牌形识别`, () => {
    const result = score(hand, opts);
    assert.equal(result.isAgari, true);
    assert.equal(result.hasYaku, true);
    assert.equal(result.yakuman, 0);
    for (const [yaku, fan] of Object.entries(expected)) assert.equal(result.yaku[yaku], fan);
    if (name.startsWith('二杯口')) {
      assert.equal(result.yaku['一盃口'], undefined);
      assert.equal(result.yaku['七対子'], undefined);
    }
  });
}

for (const [name, hand, opts, han, fu, points] of [
  ['平和自摸二十符', '123456m123p55p789s', { tsumo: true }, 2, 20, 1500],
  ['平和门清荣和三十符', '123456m123p55p789s', {}, 1, 30, 1000],
  ['七对子二十五符不进位', '1122m3344p5566s77z', {}, 2, 25, 1600],
  ['单骑加二符并进位', '123456m123p789s55p', { riichi: true }, 1, 40, 1300],
  ['嵌张加二符并进位', '13m456m123p789s55p2m', { riichi: true }, 1, 40, 1300],
  ['一二边张荣和三万加二符', '12m456m123p789s55p3m', { riichi: true }, 1, 40, 1300],
  ['八九边张荣和七万加二符', '89m456m123p789s55p7m', { riichi: true }, 1, 40, 1300],
  ['连风雀头计四符', '111m456m789p23s11z4s', { seatWind: 1, riichi: true }, 1, 50, 2400],
  ['开门无符形至少三十符', '456m234p55p789s', { melds: [{ type: 'chi', tiles: tiles('234m') }], haidi: true }, 1, 30, 1000],
  ['副露边张顺子不能把暗手双碰误判为边张', '33m111p789s55p3m', { melds: [{ type: 'chi', tiles: tiles('123m') }], haidi: true }, 1, 30, 1000],
  ['副露有边张顺子但暗手也确实边张时仍补两符', '12s222p55z333p3s', { melds: [{ type: 'chi', tiles: tiles('123m') }], haidi: true }, 1, 40, 1300],
  ['副露中间张不抑制暗手真正边张的两符', '12s222p55z333p3s', { melds: [{ type: 'chi', tiles: tiles('234s') }], haidi: true }, 1, 40, 1300],
  ['幺九暗杠三十二符与门清荣和', '456m234p55p789s', { melds: [{ type: 'ankan', tiles: tiles('1111m') }], riichi: true }, 1, 70, 2300],
  ['中张明杠八符', '456m234p55p789s', { melds: [{ type: 'kan', tiles: tiles('2222m') }], haidi: true }, 1, 30, 1000],
  ['开门边张与明杠刻子累加后重新进位', '12s55p3s', { haidi: true, melds: [
    { type: 'kan', tiles: tiles('1111m') }, { type: 'pon', tiles: tiles('222p') },
    { type: 'pon', tiles: tiles('333m') },
  ] }, 1, 50, 1600],
  ['岭上仍有自摸二符', '23s55p4s', { tsumo: true, rinshan: true, melds: [
    { type: 'kan', tiles: tiles('1111m') }, { type: 'pon', tiles: tiles('222p') },
    { type: 'pon', tiles: tiles('333m') },
  ] }, 1, 50, 1600],
]) {
  test(`符数边界：${name}`, () => {
    const result = score(hand, opts);
    assert.equal(result.hasYaku, true);
    assert.equal(result.han, han);
    assert.equal(result.fu, fu);
    assert.equal(result.ten, points);
  });
}

test('复合役满由真实牌形累计，大四喜双倍加字一色与四暗刻单骑共五倍', () => {
  const result = score('111222333444z55z');
  assert.deepEqual(result.yaku, { '四暗刻単騎待ち': 'ダブル役満', '大四喜': 'ダブル役満', '字一色': '役満' });
  assert.equal(result.yakuman, 5);
  assert.equal(result.ten, 160_000);
  assert.equal(result.han, 0);
});

test('国士十三面双倍与普通国士单倍按和牌张区分', () => {
  const thirteen = score('19m19p19s1234567z1m');
  const ordinary = score('99m19p19s1234567z1m');
  assert.equal(thirteen.yakuman, 2);
  assert.equal(ordinary.yakuman, 1);
  assert.equal(thirteen.ten, 64_000);
  assert.equal(ordinary.ten, 32_000);
});

test('三麻普通自摸保留自摸损，庄闲家支付与本场逐项正确', async () => {
  for (const winner of [0, 1]) {
    const { engine } = engineFixture({ players: 3, maxHands: 1 });
    const p = engine.players[winner];
    p.hand = tiles('123456p123s55s789s');
    p.drawnTile = p.hand.at(-1);
    engine.honba = 2;
    const result = calcWin(p.hand, [], new Set(), engine.winOpts(p, false));
    assert.equal(result.han, 2);
    assert.equal(result.fu, 20);
    await engine.winTsumo(winner);
    assert.deepEqual(engine.scores, winner === 0 ? [36_800, 34_100, 34_100] : [34_100, 36_500, 34_400]);
  }
});

test('拔北宝牌叠加表里北宝且役满不再增加普通番', () => {
  const { engine } = engineFixture({ players: 3 });
  const p = engine.players[0];
  p.hand = tiles('123456p123s55s789s');
  p.melds = [{ type: 'babei', tiles: [441] }];
  p.riichi = true;
  engine.doraIndicators = [431];
  engine.uraIndicators = [432];
  assert.deepEqual(engine.countDora(p), { omote: 1, ura: 1, aka: 0, babei: 1, babeiAsDora: 2 });
  const yakuman = score('111222333444z55z');
  assert.deepEqual(engine.applyExtraFan(yakuman, 3, false), yakuman);
});

test('大四喜双倍包牌只包复合役满的两倍部分且责任者支付本场', async () => {
  const melds = [1, 2, 3, 4].map((rank) => ({ type: 'pon', tiles: tiles(`${rank}${rank}${rank}z`), from: 3 }));
  for (const tsumo of [false, true]) {
    const { engine } = engineFixture({ maxHands: 1 });
    engine.honba = 2;
    const p = engine.players[1];
    p.melds = structuredClone(melds);
    p.pao = { daisuushi: 3 };
    const win = score('55z', { melds, tsumo });
    assert.equal(win.yakuman, 3);
    assert.equal(engine.paoYakumanUnits(p, win), 2);
    if (tsumo) await engine.endHand({ type: 'tsumo', winner: 1, card: 452, win });
    else await engine.endHand({ type: 'ron', winners: [1], loser: 2, card: 452, wins: new Map([[1, win]]) });
    assert.deepEqual(engine.scores, tsumo ? [9000, 121_600, 17_000, -47_600] : [25_000, 121_600, -39_000, -7600]);
  }
});

test('边张修复不重复添加单骑或嵌张符，也不污染平和两面和牌与输入', () => {
  const hand = tiles('123456m123p789s55p');
  const before = structuredClone(hand);
  const result = calcWin(hand.slice(0, -1), [], new Set(), { ronTile: hand.at(-1), riichi: true, seatWind: 2 });
  assert.equal(result.fu, 40);
  assert.deepEqual(hand, before);
  const ryanmen = score('23m456m123p789s55p1m', { riichi: true });
  assert.equal(ryanmen.yaku['平和'], '1飜');
  assert.equal(ryanmen.fu, 30);
  assert.equal(ryanmen.ten, 2000);
  const overlap = score('123m345m123p789s55p3m', { riichi: true });
  assert.equal(overlap.isAgari, false, '十五张伪牌形不能受符数适配影响');
});

test('拔北加番后的符番上限不切上满贯，并正确跨越满贯至累计役满', () => {
  const { engine } = engineFixture({ players: 3 });
  for (const [han, fu, points] of [[3, 60, 7700], [4, 30, 7700], [4, 40, 8000],
    [5, 20, 8000], [6, 30, 12_000], [8, 30, 16_000], [11, 30, 24_000], [13, 30, 32_000]]) {
    const base = { isAgari: true, hasYaku: true, han: han - 1, fu, yakuman: 0 };
    assert.equal(engine.applyExtraFan(base, 1, false).ten, points);
    assert.equal(engine.applyExtraFan(base, 1, true).ten, Math.ceil(points * 1.5 / 100) * 100);
  }
});
