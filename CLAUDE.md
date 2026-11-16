# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Rapid Coach: a free chess coach for chess.com games, shared with friends and deployed on GitHub Pages at https://leo17coder.github.io/rapid-coach/ (from `main`, repo root). Static site with **no build step, no package manager, no tests, no linter**: `index.html` + `style.css` + `app.js`, with third-party code vendored in `vendor/`.

## Run locally

The page must be served over http(s), not opened as `file://`, because Stockfish runs in a Web Worker:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

To check a change, load the page (Playwright/Chromium is available in cloud sessions) and use a real chess.com username.

## Decisions to keep

- **Everything runs in the visitor's browser**: engine analysis, puzzles, insights. No server compute and no AI/LLM calls. Insights are fixed, hand-written rules in `insights()` in `app.js`.
- **chess.com public API only** (`https://api.chess.com/pub/...`), fetched **one request at a time** (serially, never `Promise.all`) to respect their rate limit. `api()` retries on network errors and backs off on 429.
- **Must stay free to run**: GitHub Pages plus free tiers only.
- **GPL-3.0** because Stockfish is shipped. Keep `LICENSE` and `vendor/*-LICENSE.txt`. The app is not affiliated with chess.com; keep that statement.
- No CDN dependencies at runtime: vendor any new library into `vendor/` with its licence file.

## Architecture (`app.js`)

All code sits in one top-level `{ ... }` block (block-scoped, no modules, no globals leaked). `chess.js` is loaded first as a global `Chess` and is the **old 0.x API** (`game_over()`, `in_checkmate()`, `move({from,to,promotion})`), not the 1.x camelCase API. Code style is dense, one-liner-heavy; match it when editing.

**State and cancellation.** Module-level `let`s: `P` (profile `{user, tc}`), `ALL` (every stored game), `GAMES` (`ALL` filtered to the current user and time control, oldest first), `CUR`/`PLY` (game open in Review). `GEN` is a generation counter bumped by `enter()` on every profile switch; long-running async loops (`sync`, the analysis `queue`) capture `GEN` at start and stop when it changes. Any new async work must follow this pattern.

**Storage.**
- IndexedDB `rapid-coach` v1, single store `games` (keyPath `id`) via `DB`. Game objects are stored without the cached replay fields `_f` (FENs per ply) and `_m` (chess.js move objects), which `replay(g)` rebuilds lazily.
- `localStorage` through `LS`, every key prefixed `rc.`. `profile` is global; per-user keys go through `uk(k)` → `<user>.<k>`: `months.<tc>` (archive months already fully fetched), `trainer` (puzzle progress `{puzzleId: {seen, ok, fail}}`), `base.<tc>` (baseline stats snapshot).

**Game record** (`fromApi`): `{id:"cc-<uuid>", user, ts, date, color:"w"|"b", opp, myR, oppR, result:"win"|"draw"|"loss", how, eco, moves:[SAN], clocks:[secs remaining per ply], tc, tclass, rules, link}`. After analysis it gains `an: {ev:[cp per position, white's point of view, mate = ±10000], best:[UCI best move per ply], depth}`.

**Pipeline.**
1. `sync()` lists `/games/archives`, always refetches the two most recent months, skips older months marked in `months.<tc>`, keeps only games matching the time control (`matchTc`: `"600"` means exactly 10+0, otherwise chess.com `time_class`).
2. `queue()` is the single serial analysis queue: for every position of each game it calls `Engine.eval(fen, DEPTH=12)`; `Engine` is one Stockfish worker with its own FIFO of UCI jobs. Finished games are written back to IndexedDB, then UI, puzzles and baseline are refreshed.
3. `errorsOf(g)` classifies moves by the drop in the mover's win percentage `wp(cp)`: ≥10 inaccuracy, ≥20 mistake, ≥30 blunder. `serious()` = the player's own mistakes and blunders.
4. Puzzles (`buildPuzzles`) are **derived, not stored**: every serious error from a position with `wp ≥ 30` and a known best move; id `<gameId>:<ply>`. A move is accepted if it equals the engine move or is within 8 win-% points of the position's eval.
5. `stats()` (rating, median time used, serious errors per game over the last 20 analysed, score) feeds the Progress tab; `maybeBaseline()` freezes the first snapshot once 10 games are analysed.

**UI.** Hash routing (`#review`, `#trainer`, `#progress`) shows one `<section id="v-...">`; `v-start` is the username form. `Board` is a hand-rolled click-to-move SVG board used three times (Review, Trainer, hero). Charts are hand-drawn SVG (`chart()`), no chart library. `job()` drives the shared progress bar.

## Roadmap

V2 (planned, see `docs/V2-PLAN.md`): optional Supabase login (magic link) to sync across devices while still working without an account, a friends leaderboard, and Lichess as a second game source.
