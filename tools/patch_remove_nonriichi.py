"""GamePlayHudPanelCfgTb 只保留指定行（环境变量 HUD_KEEP，逗号分隔的行号；默认 0-7 即立直相关）。

必须从原版 bundle 出发：本脚本读取 git HEAD 中的原 commonconfigs，避免在已改过的包上重复叠加。
"""
import os
import subprocess

from patch_ui_bundle import ROOT, bundle_prefix, load_env, save_bundle, select_fb_rows

ORIGINAL = "StreamingAssets/Bundles/WebGL/commonconfigs_d005e1531b1cf360239da815293e48c6.bundle"


def run(webgl):
    keep = [int(x) for x in os.environ.get("HUD_KEEP", "0,1,2,3,4,5,6,7").split(",")]
    path = next(webgl.glob("commonconfigs_*.bundle"))
    raw = path.read_bytes()
    env, prefix, body = load_env(raw)
    assert prefix == bundle_prefix(body)
    for obj in env.objects:
        if obj.type.name != "TextAsset" or obj.read().m_Name != "GamePlayHudPanelCfgTb":
            continue
        ta = obj.read()
        script = ta.m_Script
        data = script.encode("utf-8", "surrogateescape") if isinstance(script, str) else script
        data, n = select_fb_rows(data, keep)
        print(f"rows {n} -> {keep}")
        ta.m_Script = data.decode("utf-8", "surrogateescape")
        ta.save()
        break
    else:
        raise SystemExit("GamePlayHudPanelCfgTb not found")
    return [(path.name, save_bundle(env, prefix))]
