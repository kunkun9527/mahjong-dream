# 激情麻将 / 雀梦麻将 本地单机版

## Purpose
关服前的 Unity WebGL 客户端快照，修复为单机版。原客户端只负责界面；本地后端负责协议、权威牌局、AI、商店和档案，运行时不访问外网。后端两种宿主（ADR 0007）：静态托管（GitHub Pages）时在页面内运行、存 `localStorage`；Node.js 回环服务（127.0.0.1）存 `userdata/profile.json`。
范围：只做单机立直麻将——四麻/三麻东风、半庄、一局战，四类商店。四川、斗地主、掼蛋及好友/抽卡等外围入口一律提示“This feature is unavailable in offline mode”（离线不可用）（四川后端已于 2026-10-18 删除，见 git 历史 `a469df1`）。

## Entry points
- `start-game.bat` / `local/launcher.mjs` — 启动服务并打开浏览器。
- `demo-settlement.bat` / `tools/demo_settlement.mjs` — 结算动画演示（开发/展示用，不属于正式游戏，见 `tools/codemap.md`）。
- `local/server.mjs` — HTTP + WebSocket 服务，装载 `mock/` 兼容层。
- `host-mode.js` + `web-host.js` — 宿主判定；浏览器内加载后端与 `localStorage` 存档，或转发 Node 的 `/api/profile`。`modifier.js` — 右侧 ⚙ 存档修改器。
- `clock-bridge.js` — 校验加载哈希固定的 v3 派生 WASM，投影权威时间、确认原生手牌可操作后起表，并在 Unity 消费/渲染/Reload 完成后确认当前连接的恢复批次（ADR 0009）。
- `game.html` + `offline-patch.js` — Unity 入口与离线补丁（WebSocket 指向本机或页内 `FakeWebSocket`、拦截外网请求、资源按子路径解析）；始终加载 `Build_intl/`，启动前修复旧 PlayerPrefs 错误配额、默认同意条款，仅在未选语言时设为英文；把 `versions.json` 指向派生的 `versions.mj.json`（ADR 0010）。
- `mock/server.js` — 全部消息处理器。
- `mockjs/engine.mjs` — 立直权威引擎。

## Commands
| 目的 | 命令 |
| --- | --- |
| 启动 | `npm start` / `start-game.bat --players=3 --length=hanchan`（默认端口 8765） |
| 网页版 | Cloudflare Pages 关联仓库发布根目录（`_headers` 声明 Brotli 编码与资源包长缓存）；任意静态服务器也可 |
| 构建 bundle | `npm run build`（`mockjs/` → `mock/riichi.js`） |
| 重新派生计时客户端 | `npm run build:clock`（仅 Unity 构建变化或钩子调整时；需临时 wabt + Python wasmtime/brotlicffi，见 ADR 0009） |
| 重新派生结算档位贴图 | `python -B tools/build_settlement_titles.py`（需临时 UnityPy==1.25.4 + Pillow + numpy，见 ADR 0010） |
| 语法检查 | `npm run check`（新增源码要加进 `package.json` 的 check 列表） |
| 测试 | `npm test`；单个：`node --test test/engine-smoke.test.mjs` |
| 调试 | `MJ_DEBUG=1 MJ_USERDATA_DIR=<临时目录> npm start`；URL 参数 `mjPlayers/mjLength/mjSeed/mjSpeed` |

修改 `mockjs/` 后：`npm run build` → `npm run check` → `npm test`，源码与 `mock/riichi.js` 一起提交。

## Directory map
| 目录 | 职责 | 地图 |
| --- | --- | --- |
| `local/` | Node 进程：启动器、静态/WS 服务、`/api/profile`、档案文件读写 | [local/codemap.md](local/codemap.md) |
| `mock/` | 原客户端兼容层：wrapper 协议、大厅数据、消息处理器、匹配 | [mock/codemap.md](mock/codemap.md) |
| `mockjs/` | ESM 后端源码：立直引擎与 AI、商店、协议、共享档案宿主 | [mockjs/codemap.md](mockjs/codemap.md) |
| `tools/` | 从原 bundle 提取配置与协议的只读脚本 | [tools/codemap.md](tools/codemap.md) |

其他目录：`test/`（node:test，名称用中文描述行为）、`docs/`（`handoff.md`、`technical-architecture.md`、`repair-backlog.md`、`adr/`）、`archive/zh-client/`（归档的中文 Unity 构建）、`Build_intl/`、`StreamingAssets/`、`TemplateData/`（Unity 产物，不要修改）、`userdata/`（运行时存档，Git 忽略）。

## Rules
- 不手改：`mock/riichi.js`、`mock/data.js`、`mockjs/*_catalog.mjs`、`*_desc.mjs`、Unity 构建产物（含派生的 `Build_intl/mj-h5.clock*`，只由 `npm run build:clock` 生成）、`userdata/`、`package-lock.json`（只随 npm 依赖变更）。
- 不重新接入生产域名、远端 WSS 或任何联网流程。
- 浏览器状态不是牌局真相；AI 不得读对手暗牌、未来牌山。
- 协议字段名、消息名、枚举值沿用原协议；改协议同时查 `mockjs/riichi_desc.mjs`、编解码调用方、`mock/server.js` 和测试。
- 规则基线：立直 ADR 0002（雀魂段位战）；存档 ADR 0001、双宿主 ADR 0007（档案规则只改 `mockjs/profile*.mjs`，两边自动同步）；商店经济 ADR 0003；立直 AI 分级 ADR 0006；NPC 名单/风格与对局记录恢复 ADR 0008；派生计时客户端 ADR 0009；派生结算档位贴图 ADR 0010。
- 规则、协议、存档、服务行为的改动必须带回归测试；不提交 `.tmp-*`、截图等调试文件。
- 提交信息用 Conventional Commits（中文描述），例如 `fix(engine): 修正三麻拔北抢和`。
