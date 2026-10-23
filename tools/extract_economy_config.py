"""Read-only extraction of this snapshot's rank/shop config to generate the backend catalog; requires UnityPy on the dev machine.
Field order verified against the Create*Cfg parameters in IL2CPP v31 metadata (MethodDefinition, 36 bytes).
Run: python tools/extract_economy_config.py; does not modify the Unity bundle.
"""
import hashlib
import json
from pathlib import Path
import struct
import UnityPy
import brotli

ROOT = Path(__file__).resolve().parent.parent
SOURCE = 'StreamingAssets/Bundles/WebGL/commonconfigs_d005e1531b1cf360239da815293e48c6.bundle'


class Table:
    def __init__(self, data, position):
        self.data, self.position = data, position
        vtable = position - struct.unpack_from('<i', data, position)[0]
        size = struct.unpack_from('<H', data, vtable)[0]
        self.offsets = struct.unpack_from('<' + 'H' * ((size - 4) // 2), data, vtable + 4)

    def field(self, index):
        offset = self.offsets[index] if index < len(self.offsets) else 0
        return self.position + offset if offset else None

    def integer(self, index):
        at = self.field(index)
        return struct.unpack_from('<i', self.data, at)[0] if at is not None else 0

    def tables(self, index):
        at = self.field(index)
        if at is None:
            return []
        vector = at + struct.unpack_from('<I', self.data, at)[0]
        length = struct.unpack_from('<I', self.data, vector)[0]
        result = []
        for i in range(length):
            at = vector + 4 + i * 4
            result.append(Table(self.data, at + struct.unpack_from('<I', self.data, at)[0]))
        return result


def shop_types():
    source = 'Build_intl/mj-h5.data.unityweb'
    packed = (ROOT / source).read_bytes()
    raw = brotli.decompress(packed)
    offset = raw.find(bytes.fromhex('af1bb1fa1f000000'))
    if offset < 0:
        raise ValueError('expected IL2CPP v31 metadata is missing')
    data = raw[offset:]
    header = struct.unpack_from('<64I', data)

    def text(index):
        start = header[6] + index
        return data[start:data.index(b'\0', start)].decode('utf-8')

    defaults = {}
    for at in range(header[16], header[16] + header[17], 12):
        field, _, index = struct.unpack_from('<iii', data, at)
        if index >= 0:
            defaults[field] = index
    for at in range(header[40], header[40] + header[41], 88):
        if text(struct.unpack_from('<I', data, at)[0]) != 'ShopType':
            continue
        start = struct.unpack_from('<i', data, at + 32)[0]
        count = struct.unpack_from('<H', data, at + 68)[0]
        values = {}
        for field in range(start, start + count):
            if field not in defaults:
                continue
            name = text(struct.unpack_from('<I', data, header[24] + field * 12)[0])
            # All values in this enum are 0..10; v31 default integers use compressed ZigZag rather than fixed four bytes.
            value = data[header[18] + defaults[field]]
            assert value < 128 and value % 2 == 0
            values[name] = value // 2
        mapping = {'GROCERY': 'GroceryCfg', 'COIN': 'CoinShopCfg', 'RECRUIT': 'RecruitShopCfg', 'HONOR': 'MatchRankShop'}
        return {key: values[name] for key, name in mapping.items()}, source, hashlib.sha256(packed).hexdigest()
    raise ValueError('ShopType enum is missing')


# CreateOneMatchRewardCfg(ID, Cost, OneHan, TwoHan, ThreeHan, FourHan, Mangan, JumpFullHan,
# DoubleFullHan, TripleFullHan, Yakuman, DoubleYakuman); the last 10 items correspond to riichi.EnumItemRewardLevel 1..10 in order.
# Each item is a [item ID, count] sub-table; both fields are floats in the original table.
def one_round_rewards(assets):
    data = assets['DailyCompetitionOneMatchRewardTb']

    def items(table, index):
        result = []
        for item in table.tables(index):
            item_id, count = (struct.unpack('<f', struct.pack('<i', item.integer(i)))[0] for i in range(2))
            assert item_id.is_integer() and count.is_integer()
            result.append({'id': int(item_id), 'count': int(count)})
        return result

    rows = []
    for table in Table(data, struct.unpack_from('<I', data)[0]).tables(0):
        rows.append({
            'id': table.integer(0),
            'cost': items(table, 1),
            'rewards': [items(table, index) for index in range(2, 12)],
        })
    return rows


def main():
    bundle = (ROOT / SOURCE).read_bytes()
    assert bundle[33:41] == b'UnityFS\0'
    assets = {}
    for obj in UnityPy.load(bundle[33:]).objects:
        if obj.type.name != 'TextAsset':
            continue
        reader = obj.reader
        reader.Position = obj.byte_start
        name = reader.read_aligned_string()
        assets[name] = reader.read_bytes(reader.read_int())

    def rows(name, names, vectors=()):
        data = assets[name]
        tables = Table(data, struct.unpack_from('<I', data)[0]).tables(0)
        result = []
        for table in tables:
            row = {name: table.integer(i) for i, name in enumerate(names) if name}
            for field, name in vectors:
                values = table.tables(field)
                # This build is all empty; when future configs have tiers, their semantics must be filled in first, and offset must not be treated as a price.
                if values:
                    raise ValueError(f'{name}: non-empty tier config is not supported yet')
                row[name] = []
            result.append(row)
        return result

    shop_type_map, protocol_source, protocol_sha = shop_types()
    catalog = {
        'source': SOURCE,
        'sha256': hashlib.sha256(bundle).hexdigest(),
        'shopTypes': shop_type_map,
        'protocolSource': protocol_source,
        'protocolSha256': protocol_sha,
        'defaults': {
            'coinId': 60001,
            'currencyIds': [60001, 60002, 60008, 60009, 60010, 60011, 60012],
            'rank': {'level': 17, 'point': 2300},
        },
        'grocery': rows('ShopGroceryTb', ['id', 'type', 'tokenType', 'price', 'buyType', 'limit', 'sort']),
        'recruit': rows('ShopRecruitShopTb', ['id', 'type', 'price', 'sort'], [(4, 'gears')]),
        'honor': rows('ShopHonorPointsShopTb', ['id', 'type', 'price', 'buyType', 'limit', 'sort'], [(6, 'gears')]),
        'coinSlots': rows('ShopCoinShopTb', ['id', 'type', 'rarity', 'count']),
        'refresh': rows('ShopCoinShopRefreshTb', ['count', 'tokenType', 'price']),
        'gifts': rows('BagGiftTable', ['id', 'type', None, 'name', None, 'rarity', None, None, 'price']),
        'materials': rows('BagMaterialTable', ['id', 'type', None, 'name', None, 'rarity', None, None, None, 'price']),
        'dojos': rows('Rank2DojoCfgTb', ['id', 'name', None, None, None, None, 'minRank', 'maxRank', 'entryCurrency', 'entryBalance', 'feeCurrency', 'fee', 'rewardCurrency', 'rewardRate']),
    }
    for mode, table in [('yonma', 'Rank2RankFourCfgTb'), ('sanma', 'Rank2RankThreeCfgTb')]:
        catalog[mode + 'Ranks'] = rows(table, ['id', 'room', 'name', None, 'initial', 'up', 'canDecrease', 'inherit', 'special', 'down'])
    catalog['rankPoints'] = rows('Rank2DojoRankCfgTb', ['id', 'room', 'rank', 'name', 'east1_4', 'east2_4', 'east3_4', 'east4_4', 'half1_4', 'half2_4', 'half3_4', 'half4_4', 'east1_3', 'east2_3', 'east3_3', 'half1_3', 'half2_3', 'half3_3'])
    catalog['oneRound'] = one_round_rewards(assets)
    body = '// Generated by tools/extract_economy_config.py from the original client config; do not edit by hand.\n'
    body += 'export const ECONOMY_CATALOG = ' + json.dumps(catalog, ensure_ascii=False, indent=2) + ';\n'
    (ROOT / 'mockjs/economy_catalog.mjs').write_text(body, encoding='utf-8', newline='\n')
    print('Generated mockjs/economy_catalog.mjs (source SHA-256 ' + catalog['sha256'] + ')')


if __name__ == '__main__':
    main()
