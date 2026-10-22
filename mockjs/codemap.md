# mockjs/

## Responsibility
可维护的 ESM 后端源码：立直麻将权威引擎与 AI、商店、一局战和 protobuf 编解码。经 `build_browser.mjs` 打包成 `mock/riichi.js`。

## Key files
- `browser_entry.mjs` — bundle 入口；定义 `RiichiSession`（计时、AI 调度、消息桥接），把各模块导出到 `globalThis.__mj`。
- `riichi_ai_policy.mjs` — 立直三档 AI 共用期望值弃牌/鸣牌、押引与立直/默听框架；低级裁减待牌质量与顺位，中级保留但不搜索，高级加公开读牌和固定预算摸牌搜索（ADR 0006）。`engine.mjs` 的 `aiTurn/aiClaim` 按 `aiLevels` 控制能力，合法性与关键北保护三档共用。
- `riichi_ai_read.mjs` — 高级 AI 读牌模型：只用公开信息（牌河顺序/摸切/立直/副露/宝牌/余牌）估计各家听牌概率、逐张放铳率与威胁打点；公开牌河日志由 `engine.mjs` 的 `discardLog` 提供。
- `riichi_reload.mjs` — 重连快照：把本手已下发通知帧折叠为客户端可见局面，构造 `Offline2OnlineGameScene`（20163 `f100`）；不安全切点返回 `null` 退回整手重放。
- `engine.mjs` — 立直 `GameEngine`：牌山、动作窗口、鸣牌/立直/杠/拔北、和了与流局、计分、局序（东风/半庄/一局）。牌局唯一真相。
- `ai.mjs`、`shanten.mjs` — AI 决策与向听；`yaku_map.mjs` 役种映射（计分依赖 `riichi` 包）。
- `tiles.mjs` — 实体牌 ID ↔ 牌种转换，红宝依赖它。
- `pb.mjs` + `riichi_desc.mjs` + `proto_enum.mjs` — 立直协议（protobufjs）。
- `shop.mjs` — 杂货铺/雀币/招募/荣耀积分四类商店的购买、限购与刷新（DT 30）。
- `one_round.mjs` — 一局战报名费与番数奖励。
- `profile.mjs`、`economy.mjs`、`profile_host.mjs` — 档案规则、一次性经济补给、共享档案宿主（装载/会话回调/结算记账/存档修改器操作）。网页版经 bundle 的 `__mj.host` 使用，Node 版直接 import（ADR 0007）。
- `process_shim.mjs` — 构建时注入的 `process` 替身；缺它时 bundle 在浏览器里报 `process is not defined`。
- 生成数据：`economy_catalog.mjs`、`riichi_desc.mjs`，由 `tools/` 脚本生成，不要手改。

## Flow
服务端收到 20018 → `RiichiSession.handleClient` → 引擎按当前动作窗口校验实体牌 → 提交状态 → 生成通知帧 → `sess.push`。终局回调 `onFinalResult` 交给服务端结算段位/雀币/奖励。

## Integration
- Used by: `mock/server.js` 与 `web-host.js`（经 bundle）、`local/*.mjs`（直接 import）、`test/`
- Depends on: `protobufjs`、`riichi`

## Gotchas
- 所有动作先校验再改状态；非法动作后状态不变。
- AI 不得读取对手暗牌、未来牌山。
- 规则争议：以 ADR 0002（雀魂段位战）为准。
- 改完必须 `npm run build`，并把 `mock/riichi.js` 一起提交。
