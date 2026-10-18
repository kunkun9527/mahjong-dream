"""修改 Unity AssetBundle 并同步整条清单链，使客户端校验通过。

客户端校验链（见 Oracle 调查结论）：
- 每个 bundle 文件 = 33 字节前缀（空格 + body 的 MD5）+ UnityFS body；整文件 MD5 必须等于
  文件名中的 hash，整文件大小必须等于 Arts 清单登记的 size。
- Arts 清单本身是一个 UnityFS bundle（内部为 MonoBehaviour "Arts"），无前缀；整文件 MD5/size
  登记在版本清单里。版本清单有根目录 versions.json 与 WebGL 下多个 versions_v*.json，需全部同步。

用法：M:/Temp/upy/Scripts/python tools/patch_ui_bundle.py tools/<patch脚本>.py
patch 脚本需提供 run(webgl_dir) -> [(旧bundle文件名, 新整文件bytes)]。
"""
import hashlib
import json
import re
import struct
import sys
from pathlib import Path

import UnityPy

ROOT = Path(__file__).resolve().parent.parent / "StreamingAssets" / "Bundles"
WEBGL = ROOT / "WebGL"


def load_env(raw: bytes):
    start = raw.find(b"UnityFS")
    return UnityPy.load(raw[start:]), raw[:start], raw[start:]


def save_bundle(env, prefix: bytes) -> bytes:
    return prefix + env.file.save(packer="lz4")


def bundle_prefix(body: bytes) -> bytes:
    return b" " + hashlib.md5(body).hexdigest().encode()


def whole_md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def truncate_fb_vector(data: bytes, keep: int):
    """把 FlatBuffers 根表的 vector 截为前 keep 项。"""
    data = bytearray(data)
    root = struct.unpack_from("<I", data, 0)[0]
    vt = root - struct.unpack_from("<i", data, root)[0]
    field0 = struct.unpack_from("<H", data, vt + 4)[0]
    vec = root + field0 + struct.unpack_from("<I", data, root + field0)[0]
    n = struct.unpack_from("<I", data, vec)[0]
    struct.pack_into("<I", data, vec, keep)
    return bytes(data), n


def select_fb_rows(data: bytes, indices):
    """FlatBuffers 根表的第 0 个字段是表向量；只保留 indices 指定的行（按给定顺序），返回 (新数据, 原行数)。

    向量元素是相对自身地址的 uoffset，重排后需重算；表体本身不动，多余的尾部槽位保留为未引用空洞。"""
    data = bytearray(data)
    root = struct.unpack_from("<I", data, 0)[0]
    vt = root - struct.unpack_from("<i", data, root)[0]
    field0 = struct.unpack_from("<H", data, vt + 4)[0]
    vec = root + field0 + struct.unpack_from("<I", data, root + field0)[0]
    n = struct.unpack_from("<I", data, vec)[0]
    targets = [vec + 4 + 4 * i + struct.unpack_from("<I", data, vec + 4 + 4 * i)[0] for i in range(n)]
    struct.pack_into("<I", data, vec, len(indices))
    for slot, idx in enumerate(indices):
        addr = vec + 4 + 4 * slot
        struct.pack_into("<I", data, addr, targets[idx] - addr)
    return bytes(data), n


def update_arts(renames: dict):
    """renames: {旧stem: 新stem}；更新 Arts 清单内 bundles 条目并重命名 Arts 文件。"""
    versions = json.loads((ROOT / "versions.json").read_text(encoding="utf-8"))
    arts_entry = next(e for e in versions["data"] if e["name"] == "Arts")
    arts_path = WEBGL / f"arts_{arts_entry['hash']}.json"
    env, prefix, body = load_env(arts_path.read_bytes())
    assert prefix == b"", "Arts 不应有前缀"
    obj = next(o for o in env.objects if o.type.name == "MonoBehaviour")
    tree = obj.read_typetree()
    # renames: {逻辑名(如 commonconfigs.bundle): (新整文件MD5, 新大小)}
    pending = dict(renames)
    for b in tree["bundles"]:
        if b["name"] in pending:
            b["hash"], b["size"] = pending.pop(b["name"])
    assert not pending, f"Arts 清单中找不到条目：{list(pending)}"
    obj.save_typetree(tree)
    content = env.file.save(packer="lz4")
    new_hash = whole_md5(content)
    # Arts 清单在 Bundles/ 与 Bundles/WebGL/ 各有一份相同副本，客户端取根目录那份，两处都要换
    for directory in (WEBGL, ROOT):
        (directory / arts_path.name).unlink()
        (directory / f"arts_{new_hash}.json").write_bytes(content)
    return new_hash, len(content)


def update_versions(arts_hash: int, arts_size: int):
    for vf in [ROOT / "versions.json", *sorted(WEBGL.glob("versions_v*.json"))]:
        text = vf.read_text(encoding="utf-8")

        def repl(m):
            return f'{{"name": "Arts", "hash": "{arts_hash}", "size": {arts_size}, "ver": {m.group(1)}}}'

        new_text, n = re.subn(
            r'\{\s*"name":\s*"Arts",\s*"hash":\s*"[0-9a-f]+",\s*"size":\s*\d+,\s*"ver":\s*(\d+)\s*\}',
            repl, text)
        assert n >= 1, f"{vf} 中未找到 Arts 条目"
        vf.write_text(new_text, encoding="utf-8", newline="\n")

    # updateinfo.json 登记了当前版本清单（versions_v316）的整文件 MD5 与大小
    info_path = ROOT / "updateinfo.json"
    info = info_path.read_text(encoding="utf-8")
    current = json.loads(info)["file"]
    data = (WEBGL / current).read_bytes()
    info = re.sub(r'("hash": ")[0-9a-f]+(", "size": )\d+', lambda m: f'{m.group(1)}{whole_md5(data)}{m.group(2)}{len(data)}', info, count=1)
    info_path.write_text(info, encoding="utf-8", newline="\n")


def main(patch_script: str):
    ns = {"__file__": patch_script}
    exec(compile(Path(patch_script).read_text(encoding="utf-8"), patch_script, "exec"), ns)
    outputs = ns["run"](WEBGL)

    renames = {}
    for old_name, content in outputs:
        old = WEBGL / old_name
        logical = old.stem.rsplit("_", 1)[0]
        new_name = f"{logical}_{whole_md5(content)}.bundle"
        old.unlink()
        (WEBGL / new_name).write_bytes(content)
        renames[f"{logical}.bundle"] = (whole_md5(content), len(content))
        print(f"bundle: {old_name} -> {new_name}")

    arts_hash, arts_size = update_arts(renames)
    print(f"arts -> arts_{arts_hash}.json ({arts_size})")
    update_versions(arts_hash, arts_size)
    print("versions 全部已同步")


if __name__ == "__main__":
    main(sys.argv[1])
