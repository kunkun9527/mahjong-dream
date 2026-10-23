import test from 'node:test';
import assert from 'node:assert/strict';
import { calcWin } from '../mockjs/ai.mjs';
import { tiles, engineFixture } from './helpers/riichi-fixtures.mjs';

function score(text, { tsumo = false, melds = [], ...opts } = {}) {
  const reserved = new Set(melds.flatMap((meld) => meld.tiles));
  const hand = tiles(text).map((tile) => {
    while (reserved.has(tile)) tile++;
    assert.ok(tile % 10 <= 4, 'Test hand and melds must not share tiles or exceed four copies');
    reserved.add(tile);
    return tile;
  });
  const ronTile = tsumo ? null : hand.pop();
  return calcWin(hand, melds, new Set(), { roundWind: 1, seatWind: 2, ronTile, ...opts });
}

for (const [name, hand, opts, expected] of [
  ['Riichi', '123456m123p789s55p', { riichi: true }, { '立直': '1飜' }],
  ['Double riichi and ippatsu', '123456m123p55p789s', { doubleRiichi: true, ippatsu: true }, { 'ダブル立直': '2飜', '一発': '1飜' }],
  ['Menzen tsumo and pinfu', '123456m123p55p789s', { tsumo: true }, { '門前清自摸和': '1飜', '平和': '1飜' }],
  ['Tanyao', '234456m234p55p678s', {}, { '断么九': '1飜' }],
  ['Iipeikou', '123123m456p55p789s', {}, { '一盃口': '1飜' }],
  ['Ryanpeikou does not double-count iipeikou or chiitoitsu', '123123m789789s55p', {}, { '二盃口': '3飜' }],
  ['Sanshoku doujun', '123m123p123s55p789s', {}, { '三色同順': '2飜' }],
  ['Ittsu', '123456789m55p789s', {}, { '一気通貫': '2飜' }],
  ['Chanta and haku', '123m123p789s555z77z', {}, { '混全帯么九': '2飜', '役牌白': '1飜' }],
  ['Junchan', '123m123p789s999p11s', {}, { '純全帯么九': '3飜' }],
  ['Honitsu', '123456789m111z22z', {}, { '混一色': '3飜' }],
  ['Chinitsu', '123456789222m55m', {}, { '清一色': '6飜' }],
  ['Chiitoitsu fixed at two han', '1122m3344p5566s77z', {}, { '七対子': '2飜' }],
  ['Haitei raoyue', '123456m123p55p789s', { tsumo: true, haidi: true }, { '海底摸月': '1飜' }],
  ['Houtei raoyui', '123456m123p55p789s', { haidi: true }, { '河底撈魚': '1飜' }],
  ['Chankan', '123456m123p55p789s', { chankan: true }, { '搶槓': '1飜' }],
  ['Round wind and seat wind yakuhai combined', '123m456p789s111z22z', { seatWind: 1 }, { '場風東': '1飜', '自風東': '1飜' }],
  ['Toitoi and sanankou', '222p333s555z77z', { melds: [{ type: 'pon', tiles: tiles('111m') }] }, { '対々和': '2飜', '三暗刻': '2飜' }],
  ['Open tanyao', '456m234p55p678s', { melds: [{ type: 'chi', tiles: tiles('234m') }] }, { '断么九': '1飜' }],
  ['Open sanshoku doujun loses one han', '123p123s55p789s', { melds: [{ type: 'chi', tiles: tiles('123m') }] }, { '三色同順': '1飜' }],
]) {
  test(`Common yaku scoring: ${name} recognized from the actual tile shape`, () => {
    const result = score(hand, opts);
    assert.equal(result.isAgari, true);
    assert.equal(result.hasYaku, true);
    assert.equal(result.yakuman, 0);
    for (const [yaku, fan] of Object.entries(expected)) assert.equal(result.yaku[yaku], fan);
    if (name.startsWith('Ryanpeikou')) {
      assert.equal(result.yaku['一盃口'], undefined);
      assert.equal(result.yaku['七対子'], undefined);
    }
  });
}

for (const [name, hand, opts, han, fu, points] of [
  ['Pinfu tsumo 20 fu', '123456m123p55p789s', { tsumo: true }, 2, 20, 1500],
  ['Pinfu menzen ron 30 fu', '123456m123p55p789s', {}, 1, 30, 1000],
  ['Chiitoitsu 25 fu with no rounding up', '1122m3344p5566s77z', {}, 2, 25, 1600],
  ['Tanki wait adds 2 fu and rounds up', '123456m123p789s55p', { riichi: true }, 1, 40, 1300],
  ['Kanchan wait adds 2 fu and rounds up', '13m456m123p789s55p2m', { riichi: true }, 1, 40, 1300],
  ['Penchan 12 ron on 3m adds 2 fu', '12m456m123p789s55p3m', { riichi: true }, 1, 40, 1300],
  ['Penchan 89 ron on 7m adds 2 fu', '89m456m123p789s55p7m', { riichi: true }, 1, 40, 1300],
  ['Double-wind pair counts 4 fu', '111m456m789p23s11z4s', { seatWind: 1, riichi: true }, 1, 50, 2400],
  ['Open hand with no fu-generating shape is at least 30 fu', '456m234p55p789s', { melds: [{ type: 'chi', tiles: tiles('234m') }], haidi: true }, 1, 30, 1000],
  ['Open chi does not turn closed shanpon into penchan', '33m111p789s55p3m', { melds: [{ type: 'chi', tiles: tiles('123m') }], haidi: true }, 1, 30, 1000],
  ['Open chi present but closed penchan still adds 2 fu', '12s222p55z333p3s', { melds: [{ type: 'chi', tiles: tiles('123m') }], haidi: true }, 1, 40, 1300],
  ['Open middle-tile chi does not suppress 2 fu from a true closed penchan', '12s222p55z333p3s', { melds: [{ type: 'chi', tiles: tiles('234s') }], haidi: true }, 1, 40, 1300],
  ['Terminal closed kan 32 fu and menzen ron', '456m234p55p789s', { melds: [{ type: 'ankan', tiles: tiles('1111m') }], riichi: true }, 1, 70, 2300],
  ['Simple open kan 8 fu', '456m234p55p789s', { melds: [{ type: 'kan', tiles: tiles('2222m') }], haidi: true }, 1, 30, 1000],
  ['Open penchan and open kan triplets add up, then round up again', '12s55p3s', { haidi: true, melds: [
    { type: 'kan', tiles: tiles('1111m') }, { type: 'pon', tiles: tiles('222p') },
    { type: 'pon', tiles: tiles('333m') },
  ] }, 1, 50, 1600],
  ['Rinshan tsumo still adds 2 fu', '23s55p4s', { tsumo: true, rinshan: true, melds: [
    { type: 'kan', tiles: tiles('1111m') }, { type: 'pon', tiles: tiles('222p') },
    { type: 'pon', tiles: tiles('333m') },
  ] }, 1, 50, 1600],
]) {
  test(`Fu boundary: ${name}`, () => {
    const result = score(hand, opts);
    assert.equal(result.hasYaku, true);
    assert.equal(result.han, han);
    assert.equal(result.fu, fu);
    assert.equal(result.ten, points);
  });
}

test('Composite yakuman summed from actual tile shape: daisuushii (double) + tsuuiisou + suuankou tanki (double) = 5x', () => {
  const result = score('111222333444z55z');
  assert.deepEqual(result.yaku, { '四暗刻単騎待ち': 'ダブル役満', '大四喜': 'ダブル役満', '字一色': '役満' });
  assert.equal(result.yakuman, 5);
  assert.equal(result.ten, 160_000);
  assert.equal(result.han, 0);
});

test('Kokushi 13-sided wait (double) vs. regular kokushi (single) distinguished by winning tile', () => {
  const thirteen = score('19m19p19s1234567z1m');
  const ordinary = score('99m19p19s1234567z1m');
  assert.equal(thirteen.yakuman, 2);
  assert.equal(ordinary.yakuman, 1);
  assert.equal(thirteen.ten, 64_000);
  assert.equal(ordinary.ten, 32_000);
});

test('Sanma regular tsumo keeps the tsumo loss; dealer and non-dealer payments and honba correct item by item', async () => {
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

test('Nukidora dora stacks with omote/ura dora, and yakuman adds no regular han', () => {
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

test('Daisuushii double pao only covers the double portion of composite yakuman, and the liable player pays honba', async () => {
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

test('Penchan fix does not double-add tanki or kanchan fu, and does not pollute pinfu ryanmen wins or inputs', () => {
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
  assert.equal(overlap.isAgari, false, 'A 15-tile pseudo shape must not be affected by fu fitting');
});

test('After nukidora adds han, the fu/han cap does not round up to mangan, and correctly crosses mangan into cumulative yakuman', () => {
  const { engine } = engineFixture({ players: 3 });
  for (const [han, fu, points] of [[3, 60, 7700], [4, 30, 7700], [4, 40, 8000],
    [5, 20, 8000], [6, 30, 12_000], [8, 30, 16_000], [11, 30, 24_000], [13, 30, 32_000]]) {
    const base = { isAgari: true, hasYaku: true, han: han - 1, fu, yakuman: 0 };
    assert.equal(engine.applyExtraFan(base, 1, false).ten, points);
    assert.equal(engine.applyExtraFan(base, 1, true).ten, Math.ceil(points * 1.5 / 100) * 100);
  }
});
