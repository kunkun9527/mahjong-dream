# tools/

## Responsibility
只读提取脚本：从原 Unity bundle 和 IL2CPP 元数据还原配置与协议，生成 `mockjs/` 下的数据文件。运行时不使用。

## Key files
- `extract_economy_config.py` — 段位 PT 表、四类商店、一局战奖励 → `mockjs/economy_catalog.mjs`。
- `build_clock_client.mjs` + `compile_clock_wat.py` — `npm run build:clock`：核验原件哈希，插入 `mj.clock` 投影/可操作信号、原生单数字颜色分支及 `mj.sync` 消费/渲染/Reload 钩子，生成派生 WASM 和 v3 清单（ADR 0009）；原件或钩子不匹配直接失败。
- `build_settlement_titles.py` — 校验原包/清单/`versions.json` 的固定 MD5，用 `settlement-titles/*.png` 替换英文结算档位贴图（Mangan/Haneman/Baiman/Sanbaiman），生成哈希命名的派生包、派生清单和 `versions.mj.json`，记录写入 `settlement-titles/manifest.json`（ADR 0010）；`--render` 用游戏原有英文贴图里的字形重画贴图（不需外部字体）。
- `demo_settlement.mjs` + `settlement-demo-page.js` — `demo-settlement.bat`：只读静态服务（端口 8790，CDP 8791）向 `game.html` 注入演示脚本，用临时配置开 Edge/Chrome 并点进四麻排位；页内补丁让 AI 替人类座位操作、和牌按所选档位（mangan/haneman/baiman/sanbaiman/yakuman/all）套用固定结算、对局永不结束。依赖引擎方法名（`endHand`/`countDora`/`applyExtraFan`/`_armHumanTimer`/`decideGameOver`/`finishHand`），改名时页面会抛错提示；大厅点击坐标按 1280×720 视口。不属于正式游戏。
- `ai_benchmark.mjs` — 立直 AI 固定种子对战基准；三/四麻每种子 6 种均衡布局，按种子聚类并输出 JSON/CSV、分座位统计和慢决策上下文。`node tools/ai_benchmark.mjs advanced intermediate 40`；新旧对照用 `advanced old:advanced` 加 `--baseline=旧工作树`，入口和鸣牌 helper 同步分派。方法/复现见 ADR 0006，不是数据提取脚本。

## Flow
`StreamingAssets/` bundle（FlatBuffers）/ `Build_intl/` 元数据 → 脚本按核验过的字段顺序解析 → 写 `.mjs` 数据（附来源哈希）。

## Gotchas
- Python 脚本需要开发机已装 UnityPy、Brotli；用 `python -B` 运行。
- 字段顺序来自 IL2CPP v31 `Create*Cfg` 参数（MethodDefinition 36 字节）；遇到未知结构应失败，不要猜字段。
- 不修改原 Unity bundle（派生文件另存，见 ADR 0010）；改脚本后重新生成并跑 `npm test`。
- 计时派生需临时 `wabt@1.0.39`（npm exec）与 Python `wasmtime==50.0.1`、`brotlicffi==1.2.0.0`，不是项目依赖。
