"""Build the derived settlement bundles: English han-level art (ADR 0010) and the silent yaku-reveal cue (ADR 0011).

The original English textures read "Full Han / Jump Full Han / Double Full Han / Triple Full Han"; the standard
terms are Mangan / Haneman / Baiman / Sanbaiman. Only those four Texture2D objects change. The original bundle,
asset manifest and versions.json stay untouched; the build writes hash-named copies next to them plus
StreamingAssets/Bundles/versions.mj.json, which offline-patch.js serves in place of versions.json.

Each yaku line on the win settlement is paced by the winner's voice sequence NPCxx_000_{JP,CN}, which plays the
game's silent Empty clip. NPC06's and NPC09's copies lost that clip reference, so their yaku all appeared at once;
the build gives them NPC04's sequence (identical layout, same clip) under their own name.

Bundle format (verified on this snapshot): 33-byte header = b" " + md5(UnityFS body) in hex; the file name hash is
md5(whole file). The client checks each download against the hash/size in arts_<md5>.json and retries forever
(stuck at 0%) on mismatch, so the manifest entry and versions.json must point at the derived files.

Run:   python -B tools/build_settlement_titles.py
Art:   python -B tools/build_settlement_titles.py --render
       (redraws tools/settlement-titles/*.png from the game's own glyphs; no external font)
Needs UnityPy==1.25.4 (brings the ASTC encoder), Pillow and numpy on the dev machine; not project dependencies.
"""
import hashlib
import json
import sys
from pathlib import Path

import UnityPy
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUNDLES = ROOT / 'StreamingAssets/Bundles'
ART = ROOT / 'tools/settlement-titles'
BUNDLE_NAME = 'mjab_jp_ui_ingame.bundle'
SOURCE_BUNDLE = 'mjab_jp_ui_ingame_bae168ce5cac36fd332ea44d80071cb5.bundle'
SOURCE_VERSIONS_MD5 = '875c11cdce11b14d9fc0bffc8596f87d'
SOURCE_ARTS_MD5 = 'a9ec274b1600e9ab96079f8d586b0c99'
# Voice-sequence bundles whose NPCxx_000 sequence lacks the Empty clip -> the working template (same layout).
VOICE_FIXES = {
    'npc06_aud_jp_82b771859873d7a69d26e27bfea8d0e8.bundle': 'npc04_aud_jp_56ecbde7093277670c3eddbab42d2487.bundle',
    'npc06_aud_cn_f75bd77d57309770433708b6ab818957.bundle': 'npc04_aud_cn_912e398c6b0945c3a01806842ce1f876.bundle',
    'npc09_aud_jp_e7492e5a86c984545d54349b0bff2d82.bundle': 'npc04_aud_jp_56ecbde7093277670c3eddbab42d2487.bundle',
    'npc09_aud_cn_dba7f3629010eabf87e3cbea1678bb94.bundle': 'npc04_aud_cn_912e398c6b0945c3a01806842ce1f876.bundle',
}
EMPTY_CLIP = b'Assets/ArtAB/globbyab/co/aud/common_01/Empty_s.asset'
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
# The lettering is built from the game's own brush glyphs: fill masks are cut from original English title art in
# the same bundles (Yakuman, Double/Sextuple/Cumulative Yakuman, Full Han, Mega Win), laid on one baseline, then the
# whole word gets one gradient fill, dark rim and drop shadow (colours and widths fitted to the original "Yakuman").
SHARE_BUNDLE = 'globbyab_co_ui_share_3c924a8f5c4148a72e9df7a5dc5ed76c.bundle'
SS = 4  # supersampling
REF_CAP, REF_BASE = 8, 86  # cap top and baseline of "Yakuman" (ui_settlement_img_ym_en): the size reference
RIM, SHADOW = (116, 24, 24), (60, 12, 12)
RIM_PX, SHADOW_OFFSET, SHADOW_BLUR, SHADOW_ALPHA = 3.1, (2.5, 3.5), 3.0, 0.4
# glyph -> (texture, x0, x1, y0, y1, baseline, cap top): fill components centred in the box form the glyph.
GLYPHS = {
    'a': ('ui_settlement_img_ym_en', 74, 129, 0, 104, 86, 8),
    'm': ('ui_settlement_img_ym_en', 236, 304, 0, 104, 86, 8),
    'n': ('ui_settlement_img_ym_en', 358, 421, 0, 104, 86, 8),
    'D': ('ui_settlement_img_ebym_en', 93, 166, 0, 101, 99, 22),
    'b': ('ui_settlement_img_ebym_en', 267, 319, 0, 101, 99, 22),
    'e': ('ui_settlement_img_ebym_en', 346, 399, 0, 101, 99, 22),
    'H': ('ui_settlement_img_mg_en', 236, 306, 0, 140, 102, 26),
    'S': ('ui_settlement_img_lbym_en', 23, 89, 0, 101, 99, 22),
    'i': ('ui_settlement_img_sym_en', 388, 407, 0, 101, 100, 22),
    'M': ('ui_share_dhqs_en', 6, 99, 0, 140, 106, 21),
    'g': ('ui_share_dhqs_en', 99, 268, 0, 140, 106, 21),  # "ega" is one stroke; g is cut out at columns 155..209
}
CUTS = {'g': (155, 209)}
B_STEM, B_BOWLS = 27, (0.58, 0.60)  # B = D's stem + D's bowl stacked twice; bowls overlap so they meet


def source_textures():
    textures = {}
    for name in (SOURCE_BUNDLE, SHARE_BUNDLE):
        env = UnityPy.load(pinned(BUNDLES / 'WebGL' / name, name[-39:-7])[33:])
        for obj in env.objects:
            if obj.type.name == 'Texture2D' and obj.peek_name() in {g[0] for g in GLYPHS.values()} | set(TITLES):
                textures[obj.peek_name()] = obj.read().image.convert('RGBA')
    return textures


def fill_of(image):
    rgba = np.asarray(image).astype(float)
    # the dark rim is ~R116, the fill starts at ~R188 and brightens towards yellow
    return np.clip((rgba[..., 0] - 135) / 40, 0, 1) * rgba[..., 3] / 255


def components(binary):
    labels = np.zeros(binary.shape, int)
    boxes = []
    for seed in zip(*np.nonzero(binary)):
        if labels[seed]:
            continue
        boxes.append([seed[0], seed[0], seed[1], seed[1]])
        labels[seed] = len(boxes)
        stack = [seed]
        while stack:
            y, x = stack.pop()
            box = boxes[-1]
            box[0], box[1], box[2], box[3] = min(box[0], y), max(box[1], y), min(box[2], x), max(box[3], x)
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < binary.shape[0] and 0 <= nx < binary.shape[1] and binary[ny, nx] and not labels[ny, nx]:
                    labels[ny, nx] = len(boxes)
                    stack.append((ny, nx))
    return labels, boxes


def to_image(mask):
    return Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8))


def glyph(textures, ch):
    name, x0, x1, y0, y1, base, cap = GLYPHS[ch]
    fill = fill_of(textures[name])
    labels, boxes = components(fill > 0.3)
    keep = np.zeros(fill.shape, bool)
    for index, (top, bottom, left, right) in enumerate(boxes, 1):
        if x0 <= (left + right + 1) / 2 < x1 and y0 <= (top + bottom + 1) / 2 < y1:
            keep |= labels == index
    keep = np.asarray(to_image(keep.astype(float)).filter(ImageFilter.MaxFilter(5))) > 0  # 2-px anti-aliasing fringe
    mask = np.where(keep, fill, 0)
    if ch in CUTS:
        mask[:, :CUTS[ch][0]] = 0
        mask[:, CUTS[ch][1]:] = 0
    rows, cols = np.nonzero(mask.max(1) > 0.02)[0], np.nonzero(mask.max(0) > 0.02)[0]
    mask = mask[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    return mask, base - rows[0], (REF_BASE - REF_CAP) / (base - cap)


def glyph_b(textures):
    """No capital B exists in the English art, so it is built from D: D's stem plus D's bowl, stacked twice."""
    mask, base, scale = glyph(textures, 'D')
    rows = np.nonzero(mask.max(1) > 0.02)[0]
    top, bottom = rows[0], rows[-1] + 1
    bowl = to_image(mask[top:bottom, B_STEM - 6:])
    upper_h, lower_h = int((bottom - top) * B_BOWLS[0]), int((bottom - top) * B_BOWLS[1])
    upper = np.asarray(bowl.resize((int(bowl.width * 0.86), upper_h), Image.LANCZOS)) / 255
    lower = np.asarray(bowl.resize((bowl.width, lower_h), Image.LANCZOS)) / 255
    out = np.zeros((mask.shape[0], B_STEM - 6 + bowl.width))
    out[:, :B_STEM] = mask[:, :B_STEM]
    region = out[top:top + upper_h, B_STEM - 6:B_STEM - 6 + upper.shape[1]]
    region[:] = np.maximum(region, upper)
    region = out[bottom - lower_h:bottom, B_STEM - 6:]
    region[:] = np.maximum(region, lower)
    return out, base, scale


def word_mask(textures, word, gap=2.0):
    """The word's fill mask in reference units, with its cap-top and baseline rows."""
    parts = []
    for ch in word:
        mask, base, scale = glyph_b(textures) if ch == 'B' else glyph(textures, ch)
        if abs(scale - 1) > 0.01:
            image = to_image(mask)
            image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
            mask, base = np.asarray(image) / 255, base * scale
        parts.append((mask, base))
    above = max(base for _, base in parts)
    below = max(mask.shape[0] - base for mask, base in parts)
    out = np.zeros((int(np.ceil(above + below)) + 2, int(sum(m.shape[1] + gap for m, _ in parts)) + 2))
    x = 0.0
    for mask, base in parts:
        y, left = int(round(above - base)), int(round(x))
        region = out[y:y + mask.shape[0], left:left + mask.shape[1]]
        region[:] = np.maximum(region, mask)
        x += np.nonzero(mask.max(0) > 0.5)[0][-1] + 1 + gap
    return out, above - (REF_BASE - REF_CAP), above


def gradient(textures):
    """Fill colour by height, sampled from "Yakuman": t = 0 at the cap top, 1 at the baseline."""
    rgba = np.asarray(textures['ui_settlement_img_ym_en']).astype(float)
    fill = fill_of(textures['ui_settlement_img_ym_en'])
    ts, colours = [], []
    for y in range(rgba.shape[0]):
        solid = fill[y] > 0.9
        t = (y - REF_CAP) / (REF_BASE - REF_CAP)
        if solid.sum() > 3 and t <= 0.9:  # lower rows mix with the rim; descenders stay yellow like the originals
            ts.append(t)
            colours.append(rgba[y][solid][:, :3].mean(0))
    return np.array(ts), np.array(colours)


def lettering_box(image):
    alpha = image.getchannel('A').point(lambda v: 255 if v > 24 else 0)
    return alpha.getbbox()


def render(textures, name, word):
    """Fit the word inside the original lettering's horizontal extent (the in-game title node clips outside it)."""
    original = textures[name]
    width, height = original.size
    left, _, right, _ = lettering_box(original)
    mask, cap, base = word_mask(textures, word)
    rows, cols = np.nonzero(mask.max(1) > 0.02)[0], np.nonzero(mask.max(0) > 0.02)[0]
    mask = mask[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    scale = min(1.2, (right - left - 2 * RIM_PX - 4) / mask.shape[1]) * SS
    image = to_image(mask).resize((round(mask.shape[1] * scale), round(mask.shape[0] * scale)), Image.BICUBIC)
    cap, base = (cap - rows[0]) * scale, (base - rows[0]) * scale
    cw, ch = width * SS, height * SS
    canvas = Image.new('L', (cw, ch), 0)
    x = round((left + right) / 2 * SS - image.width / 2)
    y = round(ch / 2 - (cap + base) / 2 - 0.12 * (base - cap))  # caps a little above centre, like the originals
    canvas.paste(image, (x, y))
    fill = canvas.filter(ImageFilter.GaussianBlur(SS * 0.35)).point(lambda v: 0 if v < 70 else min(255, (v - 70) * 255 // 110))
    ts, colours = gradient(textures)
    t = (np.arange(ch) - (y + cap)) / (base - cap)
    rows_rgb = np.stack([np.interp(t, ts, colours[:, k]) for k in range(3)], 1)
    paint = Image.fromarray(np.repeat(rows_rgb[:, None, :], cw, 1).astype(np.uint8), 'RGB').convert('RGBA')
    paint.putalpha(fill)
    rim = fill.filter(ImageFilter.MaxFilter(int(RIM_PX * SS) * 2 + 1)).filter(ImageFilter.GaussianBlur(SS * 0.5))
    shadow = rim.filter(ImageFilter.GaussianBlur(SHADOW_BLUR * SS)).point(lambda v: int(v * SHADOW_ALPHA))
    out = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    for colour, alpha, offset in ((SHADOW, shadow, tuple(round(v * SS) for v in SHADOW_OFFSET)), (RIM, rim, (0, 0))):
        layer = Image.new('RGBA', (cw, ch), colour + (0,))
        layer.putalpha(alpha)
        out.alpha_composite(layer, offset)
    out.alpha_composite(paint)
    return out.resize((width, height), Image.LANCZOS)


def redraw():
    textures = source_textures()
    ART.mkdir(exist_ok=True)
    for name, word in TITLES.items():
        render(textures, name, word).save(ART / f'{name}.png')
        print('drew', name, word)


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


def bundle_name(file_name):
    """npc09_aud_jp_<md5>.bundle -> npc09_aud_jp.bundle (the manifest key)."""
    return file_name[:-40] + '.bundle'


def sequence_000(env, npc, lang):
    name = f'{npc.upper()}_000_{lang.upper()}'
    found = [obj for obj in env.objects if obj.type.name == 'TextAsset' and obj.peek_name() == name]
    assert len(found) == 1, f'{name}: expected one sequence, found {len(found)}'
    tree = found[0].read_typetree()
    return found[0], tree, tree['m_Script'].encode('utf-8', 'surrogateescape')


def build_voice_bundle(source_name, template_name):
    npc, _, lang = source_name.split('_')[:3]
    template_npc = template_name.split('_')[0]
    _, _, template = sequence_000(UnityPy.load(pinned(BUNDLES / 'WebGL' / template_name, template_name[-39:-7])[33:]),
                                  template_npc, lang)
    assert EMPTY_CLIP in template and template.count(template_npc.upper().encode()) == 1, f'{template_name}: unexpected template'
    source = pinned(BUNDLES / 'WebGL' / source_name, source_name[-39:-7])
    assert source[:1] == b' ' and source[1:33].decode() == md5(source[33:]), 'unexpected bundle header'
    before = raw_objects(UnityPy.load(source[33:]))
    env = UnityPy.load(source[33:])
    obj, tree, script = sequence_000(env, npc, lang)
    assert EMPTY_CLIP not in script, f'{source_name}: the sequence already plays the Empty clip; re-audit'
    fixed = template.replace(template_npc.upper().encode(), npc.upper().encode())
    tree['m_Script'] = fixed.decode('utf-8', 'surrogateescape')
    obj.save_typetree(tree)
    body = env.file.save(packer='original')
    after = raw_objects(UnityPy.load(body))
    assert before.keys() == after.keys()
    drift = [path for path in before if (before[path] != after[path]) != (path == obj.path_id)]
    assert not drift, f'objects changed unexpectedly: {drift}'
    assert sequence_000(UnityPy.load(body), npc, lang)[2] == fixed
    return b' ' + md5(body).encode() + body


def build_manifest(derived):
    """derived: manifest bundle name -> (source file name, derived bytes)."""
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
        for name, (source_name, data) in derived.items():
            entries = [entry for entry in tree['bundles'] if entry['name'] == name]
            assert len(entries) == 1 and entries[0]['hash'] == source_name[-39:-7], name
            entries[0]['hash'], entries[0]['size'] = md5(data), len(data)
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
        redraw()
    derived = {BUNDLE_NAME: (SOURCE_BUNDLE, build_bundle())}
    for source_name, template_name in VOICE_FIXES.items():
        derived[bundle_name(source_name)] = (source_name, build_voice_bundle(source_name, template_name))
    manifest, versions = build_manifest(derived)
    outputs = {BUNDLES / 'WebGL' / f'{name[:-7]}_{md5(data)}.bundle': data for name, (_, data) in derived.items()}
    outputs.update({
        BUNDLES / f'arts_{md5(manifest)}.json': manifest,
        BUNDLES / 'versions.mj.json': versions,
    })
    record = {
        'adr': ['docs/adr/0010-derived-settlement-titles.md', 'docs/adr/0011-silent-yaku-reveal-cue.md'],
        'source': {'bundle': SOURCE_BUNDLE, 'arts': f'arts_{SOURCE_ARTS_MD5}.json', 'versionsMd5': SOURCE_VERSIONS_MD5,
                   'voiceBundles': VOICE_FIXES},
        'titles': TITLES,
        'outputs': {str(path.relative_to(ROOT)).replace('\\', '/'): {'md5': md5(data), 'size': len(data)}
                    for path, data in outputs.items()},
    }
    sources = {source for source, _ in derived.values()}
    stale = [path for path in BUNDLES.glob('arts_*.json') if path.name != f'arts_{SOURCE_ARTS_MD5}.json'] + \
            [path for name in derived for path in (BUNDLES / 'WebGL').glob(f'{name[:-7]}_*.bundle')
             if path.name not in sources]
    for path in stale:
        if path not in outputs:
            path.unlink()
    for path, data in outputs.items():
        path.write_bytes(data)
        print(path.relative_to(ROOT), md5(data), len(data))
    (ART / 'manifest.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
