# Mahjong Dream Snapshot / 雀梦麻将离线单机版

《激情麻将 / 雀梦麻将》（Mahjong Dream）离线单机立直麻将版（Windows + Node.js 本地微服务 + WebGL 客户端）。

- **纯正单机**：完全在本地回环网络运行，无需访问外网，不上传任何隐私或游戏数据。
- **双语支持**：内置原版中文客户端（《激情麻将》）与国际版英文客户端（《Mahjong Dream》）。
- **专注日麻**：专注正统立直麻将（四人麻将 / 三人麻将 / 一局战），大厅已移除非立直玩法入口（四川麻将、斗地主、掼蛋）。
- **全量收集解锁**：所有角色、专属皮肤、最高好感度、全套装扮与收集品开局即享。

---

## 目录 / Table of Contents

- [中文说明](#中文说明)
  - [核心特性与全解锁内容](#核心特性与全解锁内容)
  - [游戏模式与立直规则](#游戏模式与立直规则)
  - [AI 智能体系](#ai-智能体系)
  - [同进程断线恢复快照](#同进程断线恢复快照)
  - [快速启动游戏](#快速启动游戏)
  - [存档与本地数据](#存档与本地数据)
  - [开发者指南](#开发者指南)
- [English Documentation](#english-documentation)
  - [Overview](#overview)
  - [Unlocked Offline Content](#unlocked-offline-content)
  - [Game Modes & Riichi Rules](#game-modes--riichi-rules)
  - [AI Engine & Fair Play](#ai-engine--fair-play)
  - [Reconnection & Session Recovery](#reconnection--session-recovery)
  - [Getting Started](#getting-started)
  - [Save Data & Profiles](#save-data--profiles)
  - [Development & Testing](#development--testing)

---

## 中文说明

### 核心特性与全解锁内容

- **全角色解锁**：原版全部 10 位雀士全部解锁，可任意切换上阵。
- **全皮肤解锁**：全部 23 套专属服装、泳装与立绘皮肤全部解锁。
- **全好感度满级**：全雀士好感度恒定最高级（Lv.6 MAX）并已完成契约觉醒；对局结算面板正常回显 Lv.6 MAX，无 Lv.0 异常。
- **全套个性装扮**：全部 19 款头像（DT11 全系列）、称号、立直棒、桌布、牌面、牌背、立直音乐、和牌特效及大厅背景全部拥有，可在仓库自由搭配。
- **离线经济与商店**：初始拥有充裕雀币与梦石；杂货铺、招募商店、荣耀积分商店、每日 8 槽位雀币商店均已接通本地购买与发货，购买记录与背包道具原子落盘。
- **离线交互防护**：大厅已移除非立直入口；好友、招募、公会等必须联网的外围功能点击时弹出原生提示：“离线模式下此功能不可用”，不会假开局或卡死。

### 游戏模式与立直规则

1. **四人立直麻将（4-Player Riichi）**：
   - 支持**东风战**与**半庄战**。
   - 段位战四级房间：**启航间**、**逐梦间**、**乘风间**、**御龙间**。
2. **三人立直麻将（3-Player Riichi）**：
   - 支持**东风战**与**半庄战**。
   - 完整支持拔北宝牌、无二至八万、北风役牌与自摸损规则。
3. **一局战（One-Round Quick Match）**：
   - 一局决胜负；支持铜、银、金、玉四档，按得点与番数奖励结算。
4. **规则与计分严密性**：
   - **役种齐全**：门清立直、双立直、一发、门清自摸、断幺、平和、一杯口、三色同顺、一气通贯、混全/纯全、混一色/清一色、七对子、对对和、三暗刻、役满及复合役满（国士无双/十三面、大四喜、大三元、字一色、四暗刻单骑等）。
   - **特殊流局**：九种九牌、四风连打、四家立直、四杠散了（精准实现第四杠后摸岭上弃牌无人荣和才流局）、流局满贯。
   - **严格振听**：舍牌振听、同巡振听（含无役见逃振听，直到摸牌解除）、立直后见逃永久振听。
   - **精确符数与边界**：正确处理连风雀头 4 符、单骑/嵌张/边张 2 符（含副露与暗手边张顺子的严谨判定）、平和自摸 20 符、七对子 25 符。
   - **责任赔付与供托**：大三元/大四喜包牌责任包付、立直棒归属、同分起亲顺位打破、和了止与延长场判定。

### AI 智能体系

- **中级 AI（Intermediate）**：用于启航、逐梦、乘风间及一局战。
  - 采用统一期望值（EV）评估模型，综合牌效向听、有效受入枚数、打点期望、公共信息放铳防守（现物/筋/壁外侧）及顺位押引。
  - 吃、碰、大明杠与跳过同用期望值比拼，杜绝盲目开门导致无役。
- **高级 AI（Advanced）**：用于御龙间。
  - 在中级策略基础上，引入固定计算预算的一向听/听牌有限深度搜索，结合真实役种估值规划和牌路线。
- **绝对公平**：AI 仅读取自身手牌与公开牌河/副露信息，绝不偷看牌山、暗牌或里宝牌；固定种子对局完全可复现。

### 同进程断线恢复快照

- 服务端支持协议级断线重连（`Offline2OnlineGameScene` 局面快照）。
- 对局中若误刷新网页或不小心关闭标签页，重新打开页面即可无缝恢复手牌、牌河、副露、分棒与行动等待窗口，无需重新回放整局。
- 断线后内置 60 秒正常托管宽限，防止后台快速结束对局。

---

### 快速启动游戏

#### 运行环境
- 操作系统：Windows 10 / 11
- 运行环境：**Node.js 22 或更高版本**（从 [nodejs.org](https://nodejs.org/) 下载安装）

#### 启动方式

- **中文版（推荐）**：双击根目录下的 [`start-game.bat`](start-game.bat)。
- **英文版**：双击根目录下的 [`start-game-en.bat`](start-game-en.bat)。

启动后会自动在本机启动服务，并优先通过 Microsoft Edge 或 Google Chrome 打开游戏。**关闭启动器黑色命令行窗口即可停止服务**。

#### 命令行启动参数（可选）

如需跳过大厅直接快速开始指定模式，可在命令行中传参启动：

```bat
:: 四麻东风战（中文）
start-game.bat --players=4 --length=east

:: 四麻半庄战（中文）
start-game.bat --players=4 --length=hanchan

:: 三麻东风战（中文）
start-game.bat --players=3 --length=east

:: 三麻半庄战（中文）
start-game.bat --players=3 --length=hanchan

:: 英文版四麻半庄
start-game-en.bat --players=4 --length=hanchan
```

也可以在浏览器访问地址后直接附加参数：
- 切换英文客户端：`http://127.0.0.1:8790/game.html?mjLang=en`

---

### 存档与本地数据

- 玩家的所有数据保存在单文件：`userdata/profile.json`。
- 包含：角色选择、服装装备、装扮搭配、昵称、三麻与四麻段位 PT、雀币/梦石余额及历史战绩。
- 存档保存采用安全原子写入机制；若遇文件损坏会自动备份并重置，防止进度丢失。
- 备份或迁移存档只需复制 `userdata/profile.json` 即可。

---

### 开发者指南

本地开发与测试命令：

```bash
# 安装依赖
npm install

# 静态语法与模块检查
npm run check

# 运行完整自动化测试套件（360 项全面回归测试）
npm test

# 重新编译前端浏览器运行时（源码位于 mockjs/，构建产物为 mock/riichi.js）
npm run build
```

- 项目详细架构：[`docs/technical-architecture.md`](docs/technical-architecture.md)
- 代码地图与各模块职责：[`codemap.md`](codemap.md)
- 历史交接与修复明细：[`docs/handoff.md`](docs/handoff.md)、[`docs/repair-backlog.md`](docs/repair-backlog.md)

---

## English Documentation

### Overview

**Mahjong Dream Snapshot** is an offline, standalone single-player Riichi Mahjong game adapted from the game snapshot of *Mahjong Dream* (*激情麻将*). It combines a local Node.js microservice backend with the original Unity WebGL client.

- **100% Offline**: Runs strictly on localhost (`127.0.0.1`). No internet connection is required, and no private data or telemetry is transmitted.
- **Bilingual Support**: Includes both the original Chinese client (*激情麻将*) and the international English client (*Mahjong Dream*).
- **Dedicated Riichi Experience**: Focused exclusively on Riichi Mahjong (4-Player, 3-Player, and One-Round Quick Match). Non-Riichi modes (Sichuan Mahjong, Fight the Landlord, Guandan) have been cleanly removed from the lobby.
- **Full Unlock by Default**: All 10 characters, 23 costumes, max affection levels, avatars, and cosmetics are unlocked and ready to use immediately.

---

### Unlocked Offline Content

- **All Characters Unlocked**: All 10 original mahjong players are unlocked and selectable.
- **All Costumes Unlocked**: All 23 character outfits, swimsuits, and special illustrations are available in the inventory.
- **Max Affection (Lv.6 MAX)**: All characters are set to maximum affection level (Lv.6 MAX) with awakening completed. Match settlement panels properly display Lv.6 MAX instead of Lv.0.
- **Full Cosmetic Collection**: All 19 avatars (DT11 series), titles, riichi sticks, table cloths, tile faces, tile backs, riichi BGM, and win animations are unlocked in your bag.
- **Offline Economy & Shops**: Pre-loaded with abundant coins and dream stones. Four offline shops (General Store, Recruitment Shop, Honor Shop, and 8-slot Daily Coin Shop) are functional with atomic local persistence.
- **Offline Safety Guards**: Lobby buttons for online-only features (Friends, Gacha, Guild, Tournaments) display a native toast prompt: *"Feature not available in offline mode"*, preventing crashes or deadlocks.

---

### Game Modes & Riichi Rules

1. **4-Player Riichi Mahjong (Yonma)**:
   - Supports **East (Tonpuusen)** and **South (Hanchan)** matches.
   - Four ranked rooms: **Novice (启航)**, **Adept (逐梦)**, **Master (乘风)**, and **Throne (御龙)**.
2. **3-Player Riichi Mahjong (Sanma)**:
   - Supports **East (Tonpuusen)** and **South (Hanchan)** matches.
   - Full implementation of Kita (North extraction dora), 2-8 character removal, North wind as yakuhai, and tsumo-loss rules.
3. **One-Round Quick Match (一局战)**:
   - Fast single-hand showdown across Bronze, Silver, Gold, and Jade tiers with han/mangan tiered payouts.
4. **Authentic Riichi Rules & Precision Scoring**:
   - **Complete Yaku List**: Riichi, Double Riichi, Ippatsu, Menzen Tsumo, Tanyao, Pinfu, Iipeikou, Sanshoku Doujun, Ittsu, Chanta, Junchan, Honitsu, Chinitsu, Chiitoitsu, Toitoi, Sanankou, and all Yakuman / Double Yakuman.
   - **Abrupt Draws (Tochuu Ryuukyoku)**: Kyuushu Kyuuhai, Suufon Renda, Suuka Riichi, Suukaikan (accurately triggers only after the 4th kan draw and discard without ron), and Nagashi Mangan.
   - **Strict Furiten System**: Discard furiten, temporary same-turn furiten (including no-yaku passes, cleared upon the next draw), and permanent post-riichi furiten.
   - **Accurate Fu & Scoring**: Proper calculation of 4 fu for double-wind pair, 2 fu for edge/closed/pair waits, 20 fu for pinfu tsumo, 25 fu for chiitoitsu, pao liability, and riichi deposit distribution.

---

### AI Engine & Fair Play

- **Intermediate AI**: Powers Novice, Adept, Master rooms, and One-Round mode.
  - Driven by an Expected Value (EV) evaluation model incorporating shanten, effective tile count (ukeire), hand value potential, defensive discard risks (Genbutsu, Suji, Kabe), and push/fold positioning.
  - Chii, Pon, and Open Kan choices are evaluated directly against the EV of skipping to prevent opening hands without a clear yaku.
- **Advanced AI**: Powers the Throne (御龙) room.
  - Enhances intermediate evaluation with a bounded-budget 1-shanten and tenpai search, projecting exact yaku and scoring values.
- **100% Fair Play**: The AI only examines its own hand and public discard/meld information. It never peeks at the wall, hidden tiles, or ura-dora. Matches with fixed seeds are completely deterministic and reproducible.

---

### Reconnection & Session Recovery

- **In-Process Reload Snapshot**: Supports protocol-level session state snapshots (`Offline2OnlineGameScene`).
- If you accidentally refresh the page or close your browser tab during a match, reopening the URL immediately restores your hand, discard river, melds, scores, and active action timers without needing to replay the entire hand.
- An automatic 60-second grace period is granted upon disconnect to prevent the AI from fast-forwarding the game before you return.

---

### Getting Started

#### Requirements
- **OS**: Windows 10 / 11
- **Runtime**: **Node.js 22 or higher** (Download from [nodejs.org](https://nodejs.org/))

#### How to Play

- **Chinese Version**: Double-click [`start-game.bat`](start-game.bat).
- **English Version**: Double-click [`start-game-en.bat`](start-game-en.bat).

The launcher starts the local server on loopback (`127.0.0.1`) and automatically launches Microsoft Edge or Google Chrome. **Close the command prompt window to stop the game server.**

#### Command-Line Arguments (Optional)

You can launch directly into a specific mode from the command line:

```bat
:: 4-Player East Match (Chinese)
start-game.bat --players=4 --length=east

:: 4-Player South Match (Chinese)
start-game.bat --players=4 --length=hanchan

:: 3-Player East Match (Chinese)
start-game.bat --players=3 --length=east

:: 3-Player South Match (Chinese)
start-game.bat --players=3 --length=hanchan

:: 4-Player South Match (English)
start-game-en.bat --players=4 --length=hanchan
```

You can also pass query parameters in your browser:
- Switch to English client: `http://127.0.0.1:8790/game.html?mjLang=en`

---

### Save Data & Profiles

- All player profile data is stored in a single JSON file: `userdata/profile.json`.
- Contains: active character, equipped skins, accessories, nickname, Yonma/Sanma rank points, coin balances, and historical battle records.
- Saves are written using an atomic swap mechanism with automatic corrupt-file recovery.
- To back up or transfer your progress, simply copy `userdata/profile.json`.

---

### Development & Testing

```bash
# Install dependencies
npm install

# Run static syntax checks
npm run check

# Run the automated regression test suite (360 tests)
npm test

# Rebuild client runtime (source in mockjs/, output in mock/riichi.js)
npm run build
```

- Architecture details: [`docs/technical-architecture.md`](docs/technical-architecture.md)
- Codebase structure: [`codemap.md`](codemap.md)
- Development history: [`docs/handoff.md`](docs/handoff.md), [`docs/repair-backlog.md`](docs/repair-backlog.md)
