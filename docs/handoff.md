# 项目交接说明（Handoff）

> 面向下一位开发者或 AI agent。本文只记录接手工作所需的当前状态、约束和行动顺序；系统原理详见 [`technical-architecture.md`](technical-architecture.md)，功能完成度详见 [`repair-backlog.md`](repair-backlog.md)。
>
> 最后核对日期：2026-10-22（UTC+8）。本轮三档 AI、大厅弹窗修复与英文注释全量 402/402 通过，自动 Spec 审查 1 项低风险误译已修正；维护者已授权提交并推送。实际提交与同步状态以 `git status` / `git log` 为准。
>
> **产品范围（2026-10-18 起）：只做单机立直麻将（四麻/三麻）。** 四川麻将后端已删除（最后完整版本见提交 `a469df1`），四川、斗地主、掼蛋及好友/抽卡/邮件等外围入口一律返回原生“离线模式下此功能不可用”提示。

## 1. 先看结论

项目已经从不可维护的浏览器快照恢复为可以构建、测试和本地运行的 Windows 离线麻将游戏：

- Unity WebGL 原客户端继续负责界面；
- Node.js 回环服务负责静态资源、WebSocket、会话和本地档案；
- `mockjs/` 内的可维护源码负责权威牌局、规则、AI、计分和协议；
- 支持四麻/三麻的东风战与半庄；
- 正常运行不应访问外部服务；
- 本轮全量 **402/402**；AI 专项 **62/62**、大厅内容 **30/30**，生成 bundle 已重建；
- 立直：逐动作不变量与规则/计分边界回归、四杠散了与振听细则、同进程 `Offline2OnlineGameScene` 重连快照、低/中/高级共用框架（启航/逐梦低级、乘风中级、御龙高级；一局战默认中级，见 ADR 0006）、结算界面好感度回显均已完成；
- 2026-10-22：高级 AI 的剩余枚数、合法立直、振听、赤宝缓存、国士风险、共享预算与三麻拔北估值/保牌已补回归；牌形缓存减少重复计算。新旧对照四组 30 种子均未证明强度提升，旧数字撤回；方法与结果见 [ADR 0006](adr/0006-riichi-ai-levels.md)。此前中文/英文浏览器验收及结算同步、改名修复保留；大厅保持原版资源；本轮另在隔离档案中文浏览器复现并消除登录后的空奖励窗/签到页，直接进入主界面；
- 先前额外执行过四种模式共 **100 场多 seed 自战**；本轮另将四模式 × 5 种子共 20 场的通知边界不变量检查固化为测试；
- 本轮修复 AI 非法明杠/拔北、食替、流局本场和终局判定、托管竞态、拔北岭上、暗杠红宝及包牌本场，详见 [`backend-audit.md`](backend-audit.md)。
- 后续修复历史“不鸣”设置与当前界面不同步造成的立即过牌；新页面不自动激活历史自动操作，明确提交的开关仍生效。新增会话级吃/碰/杠与 5+20 秒回归，浏览器显示仍需人工复测。
- 新旧档案一次性初始化三四麻七段（17级/2300PT），雀币现有余额×100，其余指定商店货币999999；消费/升降段以后不再补满。用户确认保留原房间上下限，因此七段开放乘风/御龙，不开放低级启航/逐梦。
- 雀币、招募、杂货、荣耀四商店已接入真实扣款/发货/限购/刷新与存档，26项新增回归含真实WS停服重启；修复Windows文件占用导致的原子替换失败。浏览器仍需人工点选验收。
- 维护入口：`local/economy.mjs`、`mockjs/shop.mjs`、`mockjs/economy_catalog.mjs`及`tools/extract_economy_config.py`。生成器需UnityPy/Brotli，游戏运行不需要Python；不直接编辑生成目录或Unity文件。架构及边界见第12章和ADR 0003。

剩余工作见第 5 节；下一步方向由维护者另行确定。

## 2. 接手后的前 10 分钟

按顺序执行，不要先修改代码。

### 2.1 确认环境

要求 Windows 11、Node.js 22 或更高版本。在项目根目录执行：

```bash
node --version
npm install
npm run check
npm test
```

预期结果：

- Node 主版本不低于 22；
- JavaScript 语法检查通过；
- 全部测试通过；最新数量和命令见第 5 节（本轮 402 项）。

如果测试数发生变化，以当前测试输出为准，但任何失败都必须先解释，不能通过删除或跳过测试来获得绿色结果。

### 2.2 查看工作区，不要清理

```bash
git status --short
git diff --stat
git diff --check
```

本轮 AI 修复、测试和文档改动已验证（见第 6 节），维护者已授权提交。接手时仍应检查工作区；其他未提交改动不是可随意清理的临时文件。

**禁止执行：**

```bash
git reset --hard
git clean -fd
git checkout -- .
```

也不要擅自 stash、提交或拆分现有改动。正式整理提交前，应先由维护者确认提交边界。

### 2.3 建立阅读上下文

依次阅读：

1. [`../GLOSSARY.md`](../GLOSSARY.md)：产品术语与明确边界；
2. [`adr/0001-filesystem-owned-local-save.md`](adr/0001-filesystem-owned-local-save.md)：本地存档决策；
3. [`adr/0002-use-mahjong-soul-ranked-rules.md`](adr/0002-use-mahjong-soul-ranked-rules.md)：唯一规则基线；
4. [`technical-architecture.md`](technical-architecture.md)：完整技术架构和文件索引；
5. [`repair-backlog.md`](repair-backlog.md)：完成状态与剩余验收项；
6. [`../codemap.md`](../codemap.md)：代码地图、开发命令和修改规则（各目录另有 `codemap.md`）。

四川、斗地主、掼蛋不在范围内。若将来要恢复，从 git 历史（`a469df1` 及之前）取回四川代码、ADR 0004/0005 和多玩法计划，不要在当前代码上从零重写。

完成标准：能够回答“谁拥有权威状态”“浏览器能否直接改牌局”“档案保存什么”“重连能否跨进程”这四个问题。

## 3. 当前架构边界

### 3.1 单一事实来源

| 领域 | 权威来源 |
| --- | --- |
| 产品定义与术语 | `GLOSSARY.md` |
| 规则争议 | `docs/adr/0002-use-mahjong-soul-ranked-rules.md` |
| 存档设计 | `docs/adr/0001-filesystem-owned-local-save.md` |
| 功能完成状态 | `docs/repair-backlog.md` |
| 运行时牌局状态 | `mockjs/engine.mjs` 的 `GameEngine` |
| 持久化状态 | `userdata/profile.json`，由 `local/profile.mjs` 管理 |
| 浏览器 bundle 源码 | `mockjs/`，不是 `mock/riichi.js` |

### 3.2 依赖方向

```text
start-game.bat
  -> local/launcher.mjs
      -> local/server.mjs
          -> local/profile.mjs
          -> mock/*.js
          -> mockjs/browser_entry.mjs
              -> mockjs/engine.mjs
                  -> tiles.mjs / shanten.mjs / ai.mjs / yaku_map.mjs
```

Unity 客户端和浏览器消息都不是牌局真相。所有动作必须由引擎根据当前动作窗口和实体牌进行合法性校验，再提交状态变化。

### 3.3 运行边界

- 服务只监听 `127.0.0.1`；不要改成局域网或公网服务。
- 单进程、单本地档案、单活动页面。
- 页面关闭后由公平 AI 接管并完成比赛。
- 立直重连在同进程内下发 `Offline2OnlineGameScene` 快照（不安全切点退回整手重放）；服务重启后不能恢复未完成比赛。
- 不保存完整牌谱、单场历史或未完成比赛。
- `Build_intl/` 和移动端不属于当前验收范围。
- 原 Unity 构建产物不可维护，不应为修复 JS 逻辑而改写二进制资源。

## 4. 已完成工作的关键内容

当前工作区中的主要修复包括：

### 工程与服务

- Node.js loopback HTTP/WebSocket 服务和 Windows 一键启动；
- 静态资源 MIME、Brotli、Range、HEAD 与路径穿越防护；
- 单活动 WebSocket 租约和 2 MiB 消息限制；
- 端口占用、资源缺失、浏览器启动失败和损坏存档的中文诊断；
- 外部 WebSocket、fetch、XHR 和 script 请求的离线拦截。

### 会话与协议

- 大厅、匹配、组桌、取消和对局桥接；
- 修复“组桌完成后取消仍幽灵开局”的两级 timer 竞态；
- 未实现请求返回明确非零失败，不再伪装为空成功；
- schema-less Protobuf 的 BigInt、fixed64 和重复字段修复；
- 页面关闭后的公平 AI 接管以及当前进程内重连。

### 麻将规则与比赛

- 四麻/三麻东风战与半庄；
- 权威动作校验、原子动作提交与 5+20 秒操作时限；
- 振听、立直后暗杠、抢杠、抢拔北、多人荣和、包牌、流局满贯；
- 杠宝时机、四杠散了、四家立直、四风连打；
- 三麻牌池、禁吃、拔北、自摸损与宝牌循环；
- 东风南入、半庄西入、飞人、必要点、和了止/听牌止；
- 三四麻独立段位、终局成绩、金币与累计战绩。
- 立直一局战（1-Round）：按原配置收报名费、只打一手、按番数发奖并弹原奖励窗，不改段位与战绩（见技术架构第 23 节）。

### 稳定性与复现

- 显式比赛 seed 驱动牌山、AI、机器人外观和牌桌标识；
- 存档串行写入、唯一临时文件、原子替换和损坏备份；
- 固定 seed 四模式终局测试；
- 额外 100 场多 seed 自战通过。

精确实现位置和调用链不要在本文重复维护，请查阅 [`technical-architecture.md`](technical-architecture.md)。

## 5. 当前状态与未完成事项

完成度以 [`repair-backlog.md`](repair-backlog.md) 为准，这里只列交接要点。

### 已验证（2026-10-22）

- 本轮 `npm run build && npm run check && npm test && git diff --check`：402/402 通过，0 失败/跳过；bundle 已重建。AI 专项、分级冒烟与自动 Spec 审查状态见第 6 节与 ADR 0006。
- 无头 Chrome + Edge 浏览器验收（隔离存档 `M:/Temp/acc/ud`）：中文与英文（`?mjLang=en`）登录、大厅、首签、四麻御龙东风/半庄、三麻乘风半庄完整比赛（含自动拔北）与原结算、结算后段位条/金币即时刷新、中途刷新重连、第二标签页被拒、商店购买、斗地主/掼蛋快速开始离线提示、改名（需改名卡）、换装、对局设置；停服重启后昵称/造型/设置/段位保留。详见 `repair-backlog.md`“端到端手测”。

### 已验证（2026-10-18）

- 浏览器（隔离无头 Chrome + CDP，端口 8790，隔离存档 `M:/Temp/mj-ud`）：
  - 立直四麻中途刷新：20163 附局面快照后可继续出牌；
  - 立直三麻一局战与（删除前的）四川血流结算界面均显示好感度 Lv.6 / MAX；
  - 四川快速开始：服务端回 20404 `f1=10` 并推 20106，客户端弹出 `Server Debug：{"log":"离线模式下此功能不可用"}`，停留在选房页，不卡匹配。

### 未验证 / 已知问题

- 一键启动器拉起真实桌面浏览器、匹配中取消未在本轮验收。
- 问候语修改离线不支持（返回离线不可用提示），客户端字段落点未知。
- 离线提示带客户端自带的 `Server Debug：` 前缀、只显示约 0.5 秒，原客户端没有更友好的通用飘字通道。
- 立直重连快照的抢杠/抢北窗口、若干期限字段语义未实机核验（这些切点退回整手重放）。
- 三档均保留直接影响向听的北，但未完整比较保北/拔北收益或抢北风险。高级真实点数搜索只覆盖一向听以内，对手仍为静态读牌估计；本轮强度差异未获统计支持，尤其三麻放铳倾向需独立样本验证（见 ADR 0006）。
- `mockjs/ai.mjs` 边张两符修正依赖 `riichi` 1.2.0 的内部表示，升级该依赖时需重新验证。
- 无头 Chrome 中 Unity 渲染比服务端慢几十秒到几分钟，截图要等待并以服务端日志为准。

## 6. 下一步

文档中的待办已基本完成，下一阶段目标由维护者确定。候选方向：三麻 AI 专项调参（拔北估值、三麻牌效与读牌参数）、高级搜索扩展到二向听与鸣牌/杠、真实桌面浏览器下的一键启动手测。开工前先与维护者对齐方向和完成标准。

### 本轮：三档统一、安静大厅、英文注释

- 用户确认按高级能力逐层裁减，不故意做错；启航/逐梦低级、乘风中级、御龙高级，一局战/默认中级。保留高级现有能力；三档共享合法性、关键北保护、押引框架和隐藏信息隔离。详见 [ADR 0006](adr/0006-riichi-ai-levels.md)。
- `node --test test/ai-*.test.mjs`：62/62；`node --test test/offline-content.test.mjs`：30/30。两种子 × 六座次 × 两种人数 × 两组等级，共 48 场分级冒烟正常终局；样本只检验运行与耗时，不证明强度排序。
- `mock/userdata.js` 的 `normalizeOfflineLobby()` 在登录和查询前更新 UTC+8 日期与强弹标记，模块版本至少 `day * 1024`，兼容昨日缓存；不改余额/月卡权益/已有领取记录，保留正常结算、一局战和有效商店回包。
- 浏览器：隔离临时存档、端口 8766，从 `/` 启动原中文 Unity；改前有空“获得奖励”窗，随后有签到页；改后直接出现大厅，未自动弹奖励/月卡/活动页。手动点推广入口、英文客户端及跨日实机未重新验收（跨日逻辑有单测）。直接打开 `game.html` 不带启动参数会触发原 Unity 的 URL 解析异常，需走 `/` 入口。
- Writer（Haiku）已完成自有源码/测试/工具注释英文化，排除字符串、测试名、文档、生成/第三方、Unity 和存档。主会话独立核验全部 74 个候选文件：38 个文件仅有注释变化，其余不变；JS、HTML 内联脚本/CSS、Python 与批处理的非注释内容一致。受版本控制的自有源码残留中文注释扫描为 0；忽略的历史临时脚本不在范围。译文未逐条人工审读。
- 完整构建/语法检查/回归 402/402 通过；自动 Spec 审查无缺失/越界，确认 1 项低风险：`mock/server.js:828` 将“不能先认定服务端无问题”译反，现已改为“do not assume the server is fault-free”。修正后重跑构建、语法、402 项测试、差异检查及 74 文件非注释等价核验，全部通过；无忽略的审查项。主会话另校正 honba、押引及三档共用鸣牌注释。
- 本轮临时快照/脚本/隔离存档已清理，8766 测试服务与测试标签页已关闭；仅保留 `M:/Temp/mj-tier-work/bench/` 的分级冒烟 JSON/CSV，不触碰真实 `userdata/`。上一轮基准 JSON/CSV 仍在 `M:/Temp/mj-ai-current/`。

### 上轮已验证：四麻/三麻高级 AI 修复

- 在原未完成补丁上继续修复，保留既有架构、房间难度路由与中级策略；不新增依赖，不改 Unity、协议、存档格式或真实 `userdata/`，不提交/推送。
- 源码涉及 `mockjs/engine.mjs`、`mockjs/riichi_ai_policy.mjs`、`mockjs/riichi_ai_read.mjs`；基准为 `tools/ai_benchmark.mjs`，生成物 `mock/riichi.js` 已重新构建。新增 `test/ai-decision-budget.test.mjs`、`test/ai-benchmark.test.mjs`，并保留已有能力测试的公平性加强。
- `node --test test/ai-*.test.mjs`：52/52 通过；全量命令与结果见第 5 节。覆盖搜索耗牌、赤宝身份、永久振听、未来立直余牌、国士单面/十三面、零预算/分片预算、拔北符数/北宝/国士与雀头保牌、首次调用前隐藏字段陷阱。
- 基准已修正三麻/四麻每种子 6 种均衡布局、按种子聚类、分座位统计及最慢决策记录。Spec 审查唯一中风险：旧 `aiClaim` 动态调用了新 `aiClaimByPolicy`；已同步路由入口/helper，3/3 分派与统计测试通过，旧标签对照已重跑。
- 对 `502b376` 旧高级：四麻配对得失 +522±319，95% CI [−104, 1147]；三麻 −1081±1178，CI [−3390, 1227]。对中级两组区间也跨 0；均为 30 种子（4301–4330），不能证明提升或不劣。按本轮对齐保留探索性策略，但不宣称已证实增强。完整命令、样本与耗时见 [ADR 0006](adr/0006-riichi-ai-levels.md)。
- 性能：修复后旧高级对照中，新高级均值约 4 ms；慢路径定位为鸣牌选项的反复向听计算，seed 4321 单进程加 profile 仍达 676 ms；四进程并行曾达 1088 ms，未证明全局 1 秒上限。
- 原始 JSON/CSV 保留在 `M:/Temp/mj-ai-current/`（仓库外，不随补丁分发）；污染的旧对照与中间 CPU profile/调试脚本已清理。基线工作树 `M:/Temp/general/base` 已移除；复现时依 ADR 重建。未清理用户其他历史临时目录。

### 建议使用的 skill

- `grilling`：确认下一轮强度验收样本、允许回退的边界；
- `diagnosing-bugs`：继续定位慢鸣牌与三麻回归；
- `code-review`：需要 Standards 维度时另行调用（本轮自动 Spec 已结束）。

## 7. 修改规则

### 必须遵守

- 修改 `mockjs/` 后执行 `npm run build`，把生成的 `mock/riichi.js` 一并纳入验证；
- 动作必须先校验，再修改权威状态；
- 协议改动同时检查描述、编码/解码、调用方和回归测试；
- 存档 schema 改动必须提升版本并提供兼容迁移；
- AI 不得读取对手暗牌或未来牌山；
- 新功能不得重新接入任何生产域名、远端 WSS 或日志服务；
- 测试存档只能写临时目录，不能污染 `userdata/`；
- 保持补丁最小，不做无关格式化或重写。

### 禁止直接修改

- `node_modules/`；
- `userdata/` 中的真实运行时档案；
- `Build/`、`Build_intl/`、`StreamingAssets/` 中的 Unity 二进制或压缩资源；
- 自动生成的 `mock/riichi.js`（应修改 `mockjs/` 后重新构建）；
- `package-lock.json`，除非确实通过 npm 增删或升级依赖。

## 8. 常用命令

```bash
# 完整验证；改过 mockjs/ 时按此顺序
npm run build
npm run check
npm test
git diff --check

# 运行单个测试文件
node --test test/engine-smoke.test.mjs

# 按测试名筛选
node --test --test-name-pattern="固定种子" test/engine-smoke.test.mjs

# 正式启动
npm start

# Windows 一键启动并指定模式
start-game.bat --players=4 --length=east
start-game.bat --players=4 --length=hanchan
start-game.bat --players=3 --length=east
start-game.bat --players=3 --length=hanchan

# 隔离调试档案（Git Bash）
MJ_DEBUG=1 MJ_USERDATA_DIR=.tmp-userdata npm start
```

可用 URL/环境参数和诊断接口详见架构文档第 17 节。

## 9. 故障定位顺序

| 症状 | 先检查 |
| --- | --- |
| 页面打不开或资源加载失败 | `start-game.bat`、`local/launcher.mjs`、`local/server.mjs` |
| 外网请求、WebSocket 地址异常 | `offline-patch.js`、`game.html` |
| 大厅按钮无响应或响应字段错误 | `mock/server.js`、`mock/proto.js`、`mock/userdata.js` |
| 进桌、重连或取消匹配异常 | `mock/server.js` 的 timer/token/table 状态、`local/server.mjs` 的 WS 生命周期 |
| 非法出牌、鸣牌或状态错乱 | `mockjs/engine.mjs` 的动作窗口和实体牌校验 |
| 向听、等待牌或 AI 弃牌异常 | `mockjs/shanten.mjs`、`mockjs/ai.mjs`、`mockjs/tiles.mjs` |
| 役种、符数或点数异常 | `mockjs/ai.mjs` 的计分适配、`mockjs/yaku_map.mjs`、底层 `riichi` 输入 |
| 重启后资料丢失 | `local/profile.mjs`、`local/server.mjs` 的 `saveChain` |
| 浏览器行为与 Node 测试不同 | 是否忘记执行 `npm run build` 更新 `mock/riichi.js` |

## 10. 交付前检查清单

每个后续任务结束时，应报告实际执行结果，而不是只说“理论上通过”。

- [ ] 改动只覆盖当前任务；
- [ ] 新行为有成功路径和失败路径测试；
- [ ] 非法动作后的状态不变量有断言；
- [ ] 修改 `mockjs/` 后已重新构建 bundle；
- [ ] `npm run check` 通过；
- [ ] `npm test` 全部通过；
- [ ] `git diff --check` 通过；
- [ ] 未改 Unity 二进制、真实存档或依赖目录；
- [ ] 未新增外部网络访问；
- [ ] 更新了 `repair-backlog.md` 中对应项，但没有把部分完成写成全部完成；
- [ ] 报告中说明存档兼容性、协议影响和生成物是否变化。

## 11. 交接完成条件

下一位接手者完成以下动作后，即可认为已正确接管：

1. 阅读第 2.3 节列出的文档；
2. 确认当前测试基线；
3. 确认没有清理或覆盖未提交工作区；
4. 从 backlog 选择一个边界清晰的事项；
5. 对涉及产品、协议或架构的关键方案先完成需求对齐；
6. 为该事项写出可验证的完成标准，再开始编码。

**下一步（单一行动）**：用 `npm start` 从正常启动入口复核本机中文大厅；完成标准是无奖励/月卡/活动推广自动弹窗且匹配入口仍可用。英文客户端与跨日实机仍未重新验收；新三档强度排序需独立样本验证，不以历史 30 种子或本轮两种子冒烟宣称提升。
