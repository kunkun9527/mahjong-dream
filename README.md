# Mahjong Dream — Offline Riichi Mahjong

[简体中文](README_CN.md)

**Mahjong Dream (激情麻将) shut down in October 2026. This project brings it back as a free, single-player Riichi Mahjong game you can play right in your browser.**

The original 3D anime-style client, characters, voices and table animations are all here. The online servers are replaced by a backend that runs on your own computer: you play against AI opponents, there are no accounts, and you never have to pay.

![An AI opponent wins on a Riichi + Ippatsu + Pinfu + Iipeiko hand with dora: 8 han, Baiman, 16,000 points](docs/screenshots/double-mangan-ron.jpg)

<p align="center"><em>The AI can hit hard too: an 8-han Baiman ron worth 16,000 points.</em></p>

## ▶ Play Now

**Open <https://mahjong-dream.pages.dev> in Chrome or Edge.** You don't need to install anything or create an account.

- The first load downloads about 30 MB, and table assets load as you play. Later visits are faster because the browser caches these files.
- English is the default. You can switch to Simplified Chinese or another language under ⚙ Settings → Language.
- A computer works best. The game runs in landscape mode.

## Why Play It

- 🀄 **Real Riichi Mahjong.** 4-player and 3-player games, East-only and Hanchan matches, plus quick **1-Round** showdowns. Scoring follows Mahjong Soul–style ranked rules: every yaku and yakuman, furiten, abortive draws, Nagashi Mangan, pao liability and accurate fu.
- 🎎 **Everything Unlocked.** All 10 characters, 19 outfits, max affection (Lv.6 MAX) and every avatar, title, table cloth, tile back, riichi BGM and win animation are unlocked from the start.
- 🤖 **AI Opponents Who Play Fair.** 19 opponents with their own names, looks and play styles, from reckless pushers to patient defenders. Three difficulty tiers across four ranked rooms. The strongest reads discards, tsumogiri and riichi timing to judge danger. All AI see only public information and never peek at the wall or your hand.
- 🏆 **Climb the Ranks.** Ranked rooms (Launch → Pursuit → Ascension → Conquest) with rank points, promotion and match records, just like the live game.
- 🛍️ **Working Shops.** Four in-game shops work, and your wallet starts with plenty of coins and gems to spend freely.
- 🛠️ **Built-in Save Editor.** Set your rank, coins and nickname, reset your record, or back up your save. It's your game.
- 🔒 **Private.** Nothing is uploaded and there are no ads or tracking. The website only delivers the game files.

## Screenshots

| Lobby | Ranked rooms |
| --- | --- |
| ![Lobby with character and game modes](docs/screenshots/lobby.jpg) | ![Ranked room selection: Launch, Pursuit, Ascension, Conquest](docs/screenshots/rank-rooms.jpg) |
| **At the table** | **Save editor** |
| ![A 4-player East-only match in progress](docs/screenshots/table.jpg) | ![The save editor panel next to the lobby](docs/screenshots/save-editor.jpg) |

## Your Save

- **Browser version:** your progress is saved in that browser. Clearing site data, using a private window, or switching browsers or devices starts a new save. **Export a backup now and then.**
- **Save Editor:** click the small **⚙ tab on the right edge** of the game.
  - **Account / Rank / Wallet**: change nickname, 4-player and 3-player rank and points, coins, gems and tickets, then click **Apply & Reload**.
  - **Reset Match Records**: clear your statistics. Rank and wallet stay.
  - **Export / Import**: save your progress as a JSON file or load one. The same file works in the offline version.
  - **New Account**: start over.
  - Editing is locked during a match. Finish or leave the match first.
- Refreshing the page in the middle of a match ends that match, but your save is kept. The offline version below can resume a match after a refresh.

## Offline Version (Windows)

Prefer to play without a browser tab pointing at a website? Run the game locally.

1. Install **[Node.js](https://nodejs.org/) 22 or newer**.
2. Download this repository (Code → Download ZIP) and unzip it.
3. Double-click **`start-game.bat`**. It installs what it needs, starts the game at `http://127.0.0.1:8765/` and opens Edge or Chrome.
4. Close the black command window to stop the game.

The offline version saves to `userdata/profile.json`; copy that file to back it up. Use the Save Editor's Export and Import to move a save between the browser and offline versions.

Every launch also writes a timestamped log to `logs/game-<time>.log` (dealt tiles, draws, discards, calls, win settlement, and every client request with its result code), which is what to attach when reporting a stuck or misbehaving hand. The game server process writes the file itself, so the log keeps growing even if the console window is paused or selected.

Optional shortcuts that open a specific match directly:

```bat
start-game.bat --players=4 --length=hanchan
start-game.bat --players=3 --length=east
```

## Diagnostic Logs

The reconnect banner has an **导出诊断日志** (export diagnostics) button. You can also run `__mjmock.exportLogs()` in the browser developer console. Logs stay local and include clock lifecycle, request results, reconnect/sync events and frontend errors; the browser history is bounded, so export soon after a problem. The offline launcher also keeps the full server log under `logs/`.

The local backend owns the countdown: hiding the page or disconnecting freezes it, and recovery continues the remaining time. A hash-pinned derived client synchronizes the current international build without replacing the original files. Recovery keeps the clock frozen until Unity confirms the current batch has been consumed, its render queue is idle, and any snapshot reload has returned to gameplay. Stale or missing confirmations cannot resume it. Both hosts have passed controlled Edge recovery checks; real OS background switching and naturally occurring robbing-kan/north windows remain unverified. See [current status](docs/handoff.md).

## FAQ

**The screen stays black or loading stops.** Use a recent Chrome or Edge with hardware acceleration on, then refresh. The first load needs a stable connection.

**Can I play with friends online?** No. This is a single-player game against AI. Friends, Gacha, Guild and Tournament buttons show an "unavailable offline" message.

**Are Sichuan Mahjong, Dou Dizhu or Guandan included?** No. Only Riichi Mahjong is supported.

## Host Your Own Copy

Fork the repository, then in Cloudflare create a **Pages** project from it: no build command, output directory left empty, and the environment variable `SKIP_DEPENDENCY_INSTALL=true`. The included `_headers` file lets browsers decompress the game files natively and cache the asset bundles. GitHub Pages (**Settings → Pages → `main` / root**) or any static file server also works, including on a sub-path, but loads more slowly.

## For Developers

```bash
npm install
npm run check   # syntax checks
npm test        # regression tests
npm run build   # rebuild mock/riichi.js from mockjs/
```

- Browser and offline versions share one backend: [ADR 0007](docs/adr/0007-browser-and-node-hosts.md)
- Architecture: [`docs/technical-architecture.md`](docs/technical-architecture.md) · Code map: [`codemap.md`](codemap.md)
- Rules baseline: [ADR 0002](docs/adr/0002-use-mahjong-soul-ranked-rules.md) · AI tiers: [ADR 0006](docs/adr/0006-riichi-ai-levels.md) · NPCs and match recovery: [ADR 0008](docs/adr/0008-npc-roster-and-match-recovery.md) · Countdown bridge (hash-pinned derived Unity WASM): [ADR 0009](docs/adr/0009-derived-unity-clock-client.md)
- History: [`docs/handoff.md`](docs/handoff.md), [`docs/repair-backlog.md`](docs/repair-backlog.md)

<details>
<summary>Full rules and AI details</summary>

**Modes**

- 4-player Riichi: East-only and Hanchan; ranked rooms Launch, Pursuit, Ascension and Conquest.
- 3-player Riichi: East-only and Hanchan; Kita (north) dora, no 2–8 man, North as a value tile, tsumo loss.
- 1-Round: one-hand showdown in Bronze, Silver, Gold and Jade tiers, with payouts by han.

**Rules**

- Yaku: Riichi, Double Riichi, Ippatsu, Menzen Tsumo, Tanyao, Pinfu, Iipeikou, Sanshoku, Ittsu, Chanta, Junchan, Honitsu, Chinitsu, Chiitoitsu, Toitoi, Sanankou, and every yakuman and double yakuman.
- Abortive draws: Kyuushu Kyuuhai, Suufon Renda, Suucha Riichi, Suukaikan (only after the 4th kan's replacement draw and discard pass without ron), and Nagashi Mangan.
- Furiten: discard furiten, temporary furiten (including passing on a no-yaku win, cleared on your next draw), and permanent furiten after riichi.
- Scoring: 4 fu for a double-wind pair, 2 fu for edge, closed and single waits, 20 fu for pinfu tsumo, 25 fu for chiitoitsu, pao liability, riichi deposits, honba and agari-yame.

**AI**

- Basic (Launch, Pursuit): legal moves, tile efficiency, hand value and basic defense.
- Intermediate (Ascension, 1-Round; default): expected-value play that weighs shanten, ukeire, hand value, genbutsu/suji/kabe danger and push/fold. Calls are compared against the value of skipping.
- Advanced (Conquest): adds a bounded tenpai search with exact scoring and reads each opponent's tenpai chance and danger from public discards, tsumogiri, riichi and calls. Uses placement-aware play in All Last.
- With a fixed seed, every match is deterministic and reproducible.

**Opponents:** 19 NPCs named after famous mahjong characters (Saki, Nodoka, Koromo, Awai, Akagi and more). Each has a fixed character and outfit and a style: how hard they push, how often they call, riichi or stay dama, speed or value. The room still sets their strength.

**Leaving mid-match:** close or refresh the page and the match waits for you, frozen on your turn. Come back within 5 minutes to keep playing. After that, the AI finishes the match for you the next time you open the game, and the result counts.

</details>

---

*Fan-made preservation project. Not affiliated with the original developer or publisher. The original Unity client files are preserved; a separate hash-pinned derived WASM synchronizes the countdown (ADR 0009).*
