"""Build the derived settlement-title bundle: replace the mistranslated English han-level art (ADR 0010).

The original English textures read "Full Han / Jump Full Han / Double Full Han / Triple Full Han"; the standard
terms are Mangan / Haneman / Baiman / Sanbaiman. Only those four Texture2D objects change. The original bundle,
asset manifest and versions.json stay untouched; the build writes hash-named copies next to them plus
StreamingAssets/Bundles/versions.mj.json, which offline-patch.js serves in place of versions.json.

Bundle format (verified on this snapshot): 33-byte header = b" " + md5(UnityFS body) in hex; the file name hash is
md5(whole file). The client checks each download against the hash/size in arts_<md5>.json and retries forever
(stuck at 0%) on mismatch, so the manifest entry and versions.json must point at the derived files.

Run:   python -B tools/build_settlement_titles.py
Art:   python -B tools/build_settlement_titles.py --render path/to/CaveatBrush-Regular.ttf
       (redraws tools/settlement-titles/*.png; Caveat Brush, SIL OFL 1.1, Impallari Type, from google/fonts)
Needs UnityPy==1.25.4 (brings the ASTC encoder) and Pillow on the dev machine; they are not project dependencies.
"""
import hashlib
import json
import sys
from pathlib import Path

import UnityPy
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUNDLES = ROOT / 'StreamingAssets/Bundles'
ART = ROOT / 'tools/settlement-titles'
BUNDLE_NAME = 'mjab_jp_ui_ingame.bundle'
SOURCE_BUNDLE = 'mjab_jp_ui_ingame_bae168ce5cac36fd332ea44d80071cb5.bundle'
SOURCE_VERSIONS_MD5 = '875c11cdce11b14d9fc0bffc8596f87d'
SOURCE_ARTS_MD5 = 'a9ec274b1600e9ab96079f8d586b0c99'
TITLES = {
    'ui_settlement_img_mg_en': 'Mangan',
    'ui_settlement_img_tm_en': 'Haneman',
    'ui_settlement_img_bm_en': 'Baiman',
    'ui_settlement_img_sbm_en': 'Sanbaiman',
}


def md5(data):
    return hashlib.md5(data).hexdigest()


def pinned(path, digest):
    data = path.read_bytes()
    if md5(data) != digest:
        raise SystemExit(f'{path.name}: md5 {md5(data)} != pinned {digest}; the Unity snapshot changed, re-audit first')
    return data


# ---------------- art ----------------
# Colours sampled from the original textures: per-line gradient, dark red rim, soft drop shadow.
TOP, BOTTOM, RIM, SHADOW = (188, 45, 43), (255, 223, 124), (116, 24, 24), (70, 16, 16)
SCALE = 4


def render(text, size, font_path):
    width, height = size
    cw, ch = width * SCALE, height * SCALE
    pad = 14 * SCALE
    limit = min(140, height) * SCALE - 2 * pad
    for points in range(260, 10, -2):
        font = ImageFont.truetype(font_path, points * SCALE)
        box = font.getbbox(text)
        if box[2] - box[0] <= cw - 2 * pad and box[3] - box[1] <= limit:
            break
    x = (cw - (box[2] - box[0])) // 2 - box[0]
    y = (ch - (box[3] - box[1])) // 2 - box[1]
    mask = Image.new('L', (cw, ch), 0)
    ImageDraw.Draw(mask).text((x, y), text, font=font, fill=255)
    # Caveat Brush is lighter than the original lettering: thicken the strokes slightly.
    mask = mask.filter(ImageFilter.MaxFilter(int(1.2 * SCALE) * 2 + 1)).filter(ImageFilter.GaussianBlur(SCALE * 0.4))
    top, span = y + box[1], max(1, (box[3] - box[1]) * 0.82)
    gradient = Image.new('RGB', (cw, ch))
    draw = ImageDraw.Draw(gradient)
    for row in range(ch):
        t = min(max((row - top) / span, 0.0), 1.0)
        draw.line([(0, row), (cw, row)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    rim = mask.filter(ImageFilter.MaxFilter(4 * SCALE * 2 + 1)).filter(ImageFilter.GaussianBlur(SCALE * 0.6))
    image = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    for colour, alpha, offset in ((SHADOW, rim.filter(ImageFilter.GaussianBlur(3 * SCALE)).point(lambda v: v // 2),
                                   (6, 12)), (RIM, rim, (0, 0))):
        layer = Image.new('RGBA', (cw, ch), colour + (0,))
        layer.putalpha(alpha)
        image.alpha_composite(layer, offset)
    fill = gradient.convert('RGBA')
    fill.putalpha(mask)
    image.alpha_composite(fill)
    return image.resize(size, Image.LANCZOS)


def redraw(font_path):
    env = UnityPy.load(pinned(BUNDLES / 'WebGL' / SOURCE_BUNDLE, SOURCE_BUNDLE[-39:-7])[33:])
    ART.mkdir(exist_ok=True)
    for obj in env.objects:
        if obj.type.name == 'Texture2D' and obj.peek_name() in TITLES:
            texture = obj.read()
            render(TITLES[texture.m_Name], (texture.m_Width, texture.m_Height), font_path).save(ART / f'{texture.m_Name}.png')
            print('drew', texture.m_Name)


# ---------------- bundle ----------------
def raw_objects(env):
    return {obj.path_id: (obj.type.name, obj.get_raw_data()) for obj in env.objects}


def build_bundle():
    source = pinned(BUNDLES / 'WebGL' / SOURCE_BUNDLE, SOURCE_BUNDLE[-39:-7])
    assert source[:1] == b' ' and source[1:33].decode() == md5(source[33:]), 'unexpected bundle header'
    before = raw_objects(UnityPy.load(source[33:]))
    env = UnityPy.load(source[33:])
    changed = set()
    for obj in env.objects:
        if obj.type.name != 'Texture2D' or obj.peek_name() not in TITLES:
            continue
        texture = obj.read()
        art = Image.open(ART / f'{texture.m_Name}.png').convert('RGBA')
        assert art.size == (texture.m_Width, texture.m_Height), f'{texture.m_Name}: art size {art.size}'
        texture.set_image(art, target_format=texture.m_TextureFormat)
        texture.save()
        changed.add(obj.path_id)
    assert len(changed) == len(TITLES), 'a settlement title texture is missing'
    body = env.file.save(packer='original')
    data = b' ' + md5(body).encode() + body
    after = raw_objects(UnityPy.load(body))
    assert before.keys() == after.keys()
    drift = [path for path in before if (before[path] != after[path]) != (path in changed)]
    assert not drift, f'objects changed unexpectedly: {drift}'
    return data


def build_manifest(bundle):
    versions_bytes = pinned(BUNDLES / 'versions.json', SOURCE_VERSIONS_MD5)
    versions = json.loads(versions_bytes)
    arts = next(item for item in versions['data'] if item['name'] == 'Arts')
    assert arts['hash'] == SOURCE_ARTS_MD5
    env = UnityPy.load(pinned(BUNDLES / f'arts_{SOURCE_ARTS_MD5}.json', SOURCE_ARTS_MD5))
    edited = 0
    for obj in env.objects:
        if obj.type.name != 'MonoBehaviour':
            continue
        tree = obj.read_typetree()
        entries = [entry for entry in tree['bundles'] if entry['name'] == BUNDLE_NAME]
        assert len(entries) == 1 and entries[0]['hash'] == SOURCE_BUNDLE[-39:-7]
        entries[0]['hash'], entries[0]['size'] = md5(bundle), len(bundle)
        obj.save_typetree(tree)
        edited += 1
    assert edited == 1
    manifest = env.file.save(packer='original')
    arts['hash'], arts['size'] = md5(manifest), len(manifest)
    # Same separators as the original file, so only the Arts hash/size differ.
    derived_versions = json.dumps(versions).encode()
    return manifest, derived_versions


def main():
    if sys.argv[1:2] == ['--render']:
        redraw(sys.argv[2])
    bundle = build_bundle()
    manifest, versions = build_manifest(bundle)
    outputs = {
        BUNDLES / 'WebGL' / f'mjab_jp_ui_ingame_{md5(bundle)}.bundle': bundle,
        BUNDLES / f'arts_{md5(manifest)}.json': manifest,
        BUNDLES / 'versions.mj.json': versions,
    }
    record = {
        'adr': 'docs/adr/0010-derived-settlement-titles.md',
        'source': {'bundle': SOURCE_BUNDLE, 'arts': f'arts_{SOURCE_ARTS_MD5}.json', 'versionsMd5': SOURCE_VERSIONS_MD5},
        'titles': TITLES,
        'outputs': {str(path.relative_to(ROOT)).replace('\\', '/'): {'md5': md5(data), 'size': len(data)}
                    for path, data in outputs.items()},
    }
    stale = [path for path in BUNDLES.glob('arts_*.json') if path.name != f'arts_{SOURCE_ARTS_MD5}.json'] + \
            [path for path in (BUNDLES / 'WebGL').glob('mjab_jp_ui_ingame_*.bundle') if path.name != SOURCE_BUNDLE]
    for path in stale:
        if path not in outputs:
            path.unlink()
    for path, data in outputs.items():
        path.write_bytes(data)
        print(path.relative_to(ROOT), md5(data), len(data))
    (ART / 'manifest.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
