# Mahjong Dream Snapshot

[简体中文文档](README_CN.md)

**Mahjong Dream Snapshot** is an offline, standalone single-player Riichi Mahjong game adapted from the game snapshot of *Mahjong Dream* (*激情麻将*). It combines a local Node.js microservice backend with the original Unity WebGL client.

- **100% Offline**: Runs strictly on localhost (`127.0.0.1`). No internet connection is required, and no private data or telemetry is transmitted.
- **Multilingual Client**: One international client with English on first launch; switch to Simplified Chinese or another built-in language in Settings. Your choice is remembered on this local origin.
- **Dedicated Riichi Experience**: Focused exclusively on Riichi Mahjong (4-Player, 3-Player, and One-Round Quick Match). Only Riichi modes are supported; any non-Riichi requests receive an "unavailable offline" response instead of starting a match. The Unity client files are kept unmodified.
- **Full Unlock by Default**: All 10 characters, 23 costumes, max affection levels, avatars, and cosmetics are unlocked and ready to use immediately.

---

## Table of Contents

- [Overview](#overview)
- [Unlocked Offline Content](#unlocked-offline-content)
- [Game Modes & Riichi Rules](#game-modes--riichi-rules)
- [AI Engine & Fair Play](#ai-engine--fair-play)
- [Reconnection & Session Recovery](#reconnection--session-recovery)
- [Getting Started](#getting-started)
- [Save Data & Profiles](#save-data--profiles)
- [Development & Testing](#development--testing)

---

### Unlocked Offline Content

- **All Characters Unlocked**: All 10 original mahjong players are unlocked and selectable.
- **All Costumes Unlocked**: All 23 character outfits, swimsuits, and special illustrations are available in the inventory.
- **Max Affection (Lv.6 MAX)**: All characters are set to maximum affection level (Lv.6 MAX) with awakening completed. Match settlement panels properly display Lv.6 MAX instead of Lv.0.
- **Full Cosmetic Collection**: All 19 avatars (DT11 series), titles, riichi sticks, table cloths, tile faces, tile backs, riichi BGM, and win animations are unlocked in your bag.
- **Offline Economy & Shops**: Pre-loaded with abundant coins and dream stones. Four offline shops (General Store, Recruitment Shop, Honor Shop, and 8-slot Daily Coin Shop) are functional with atomic local persistence.
- **Quiet Lobby**: Sign-in, new-player gift, month-card, and activity promotions do not open automatically on login. Match results, One-Round payouts, and working shop purchase feedback remain available.
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

- **Basic AI**: Powers Novice (启航) and Adept (逐梦) rooms. Uses the shared legal-action, tile-efficiency, hand-value, and basic defensive evaluator, without wait-quality refinement, placement adjustments, or lookahead search.
- **Intermediate AI**: Powers Master (乘风) and One-Round modes; also the default difficulty.
  - Driven by an Expected Value (EV) evaluation model incorporating shanten, effective tile count (ukeire), hand value potential, defensive discard risks (Genbutsu, Suji, Kabe), and push/fold positioning.
  - Chii, Pon, and Open Kan choices are evaluated directly against the EV of skipping to prevent opening hands without a clear yaku.
- **Advanced AI**: Powers the Throne (御龙) room.
  - Enhances intermediate evaluation with a bounded-budget 1-shanten and tenpai search, projecting exact yaku and scoring values.
  - Reads opponents from public information only: discard order, tsumogiri, riichi and melds feed per-player tenpai probability, wait-shape danger and hand-value estimates (furiten-safe tiles, flush/toitoi signals). All Last uses placement utility; 2-shanten hands use second-order tile efficiency. The tiers differ by available analysis, not deliberate mistakes. Their win-rate ordering has not yet been established; see [ADR 0006](docs/adr/0006-riichi-ai-levels.md).
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

Double-click [`start-game.bat`](start-game.bat), or run `npm start`. There is no separate English launcher.

The international client defaults to English only on first launch; Settings → Language lets you select Simplified Chinese or another built-in language without being reset next time. Local client terms are accepted automatically. Event and Notifications badges and automatic reward promotions are suppressed; normal match results and shop feedback are retained.

The launcher starts the local server at `http://127.0.0.1:8765/` (override with `MJ_PORT`) and automatically launches Microsoft Edge or Google Chrome. **Close the command prompt window to stop the game server.**

#### Command-Line Arguments (Optional)

You can launch directly into a specific mode from the command line:

```bat
:: 4-Player South Match
start-game.bat --players=4 --length=hanchan

:: 4-Player East Match
start-game.bat --players=4 --length=east

:: 3-Player South Match
start-game.bat --players=3 --length=hanchan

:: 3-Player East Match
start-game.bat --players=3 --length=east
```

The client always uses `Build_intl/`; old `mjLang` links no longer select a different build or override a saved language. Keep the same local port to retain browser preferences. Player progress remains in `userdata/profile.json`.

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

# Run the automated regression test suite
npm test

# Rebuild client runtime (source in mockjs/, output in mock/riichi.js)
npm run build
```

- Architecture details: [`docs/technical-architecture.md`](docs/technical-architecture.md)
- Codebase structure: [`codemap.md`](codemap.md)
- Development history: [`docs/handoff.md`](docs/handoff.md), [`docs/repair-backlog.md`](docs/repair-backlog.md)
