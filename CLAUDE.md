# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Rapid Coach: a free chess coach for chess.com and Lichess games, shared with friends and deployed on GitHub Pages at https://leo17coder.github.io/rapid-coach/ (from `main`, repo root). Static site with **no build step, no package manager, no tests, no linter**: `index.html` + `style.css` + `app.js` + `config.js`, a `privacy.html` page, and third-party code vendored in `vendor/`. Optional accounts use Supabase; the database schema is `supabase/migrations/*.sql` (run by hand in the Supabase SQL editor; setup steps in `supabase/README.md`).

## Releasing

GitHub Pages lets browsers cache files for about 10 minutes, so a new `index.html` can load with an old `app.js`. `index.html` (and `privacy.html` for the stylesheet) reference `style.css`, `config.js` and `app.js` with a `?v=<version>` query: **change that version in every release that touches those files.** Vendored files have the version in their name and need no query.

## Run locally

The page must be served over http(s), not opened as `file://`, because Stockfish runs in a Web Worker:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

To check a change, load the page (Playwright/Chromium is available in cloud sessions) and use a real chess.com username.

## Decisions to keep

- **Everything runs in the visitor's browser**: engine analysis, puzzles, insights. No server compute and no AI/LLM calls. Insights are fixed, hand-written rules in `insights()` in `app.js`.
- **Public game APIs only**: chess.com (`https://api.chess.com/pub/...`), Lichess (`https://lichess.org/api/...`) and the Lichess opening explorer (`https://explorer.lichess.org`, needs a Lichess OAuth token; see `LiAuth`), fetched **one request at a time** (serially, never `Promise.all`). `api()` retries on network errors and backs off on 429; Lichess calls pass `liOpts()`, which waits a full minute after a 429 as Lichess requires.
- **Must stay free to run**: GitHub Pages plus free tiers only (Supabase free plan for accounts).
- **Accounts are optional**: with an empty `supabaseKey` in `config.js` the app must behave exactly as without accounts. Never upload games (they contain opponents' usernames); only analyses, puzzle progress, baselines and linked accounts sync. Every table needs RLS; the browser only ever holds the publishable key.
- **GDPR** (maintainer is in Denmark): keep `privacy.html` in step with what is stored, keep self-service export and deletion working, no analytics or tracking.
- **GPL-3.0** because Stockfish is shipped. Keep `LICENSE` and `vendor/*-LICENSE.txt`. The app is not affiliated with chess.com or Lichess; keep that statement.
- No CDN dependencies at runtime: vendor any new library into `vendor/` with its licence file.

## Architecture (`app.js`)

All code sits in one top-level `{ ... }` block (block-scoped, no modules, no globals leaked). `chess.js` is loaded first as a global `Chess` and is the **old 0.x API** (`game_over()`, `in_checkmate()`, `move({from,to,promotion})`), not the 1.x camelCase API. Code style is dense, one-liner-heavy; match it when editing.

**State and cancellation.** Module-level `let`s: `P` (profile `{source: "cc"|"li", user, tc}`), `ALL` (every stored game), `GAMES` (`ALL` filtered to the current source, user and time control, oldest first), `CUR`/`PLY` (game open in Review). `GEN` is a generation counter bumped by `enter()` on every profile switch; long-running async loops (`sync`, the analysis `queue`) capture `GEN` at start and stop when it changes. Any new async work must follow this pattern, and must not touch `P` after the generation changed (it may be `null` after Switch).

**Storage.**
- IndexedDB `rapid-coach` v2 via `DB`: store `games` (keyPath `id`) and store `pending` (analyses pulled from the account for games not fetched yet on this device; kept in the `PEND` map and attached in `refreshGames()`). Game objects are stored without the cached replay fields `_f` (FENs per ply) and `_m` (chess.js move objects), which `replay(g)` rebuilds lazily.
- `localStorage` through `LS`, every key prefixed `rc.`. `profile`, `lastSrc`, `v2` and the sync keys `sb.out` (outbox), `sb.pull.<uid>` (pull watermarks), `sb.init.<uid>` (first full upload done) are global; per-user keys go through `uk(k)` → `<source>:<user>.<k>`: `months.<tc>` (chess.com archive months already fully fetched), `last.<tc>` (Lichess: newest `createdAt` seen, sent as `since`), `trainer` (puzzle progress `{puzzleId: {seen, ok, fail}}`), `base.<tc>` (baseline stats snapshot). V1 keys had no source prefix; a one-time migration at startup renames them to `cc:` and sets `rc.v2`.

**Game record** (`fromApi` for chess.com, `fromLichess` for Lichess, same shape): `{id:"cc-<uuid>"|"li-<id>", source, user, ts, date, color:"w"|"b", opp, myR, oppR, result:"win"|"draw"|"loss", how, eco, moves:[SAN], clocks:[secs remaining per ply], tc, tclass, rules, link}`. `tc` uses chess.com's format (`"600"`, `"180+2"`) for both sources, and `how` uses chess.com's result codes (`timeout`, `resigned`, `checkmated`...), which `fromLichess` maps to via `LI_HOW`. V1 records have no `source` field; use `srcOf(g)`. After analysis it gains `an: {ev:[cp per position, white's point of view, mate = ±10000], best:[UCI best move per ply], depth}`.

**Pipeline.**
1. `sync()` dispatches on `P.source`. `syncCc()` lists `/games/archives`, always refetches the two most recent months and skips older months marked in `months.<tc>`. `syncLi()` reads one NDJSON stream (`perfType`, `clocks`, `opening`; `max=2000` first, then `since`) and adds games in batches as lines arrive. Both keep only games matching the time control (`matchTc`: `"600"` means exactly 10+0, otherwise `time_class`/`speed`).
2. `queue()` is the single serial analysis queue: for every position of each game it calls `Engine.eval(fen, DEPTH=12)`; `Engine` is one Stockfish worker with its own FIFO of UCI jobs. Finished games are written back to IndexedDB, then UI, puzzles and baseline are refreshed.
3. `errorsOf(g)` classifies moves by the drop in the mover's win percentage `wp(cp)`: ≥10 inaccuracy, ≥20 mistake, ≥30 blunder. `serious()` = the player's own mistakes and blunders.
4. Puzzles (`buildPuzzles`) are **derived, not stored**: every serious error from a position with `wp ≥ 30` and a known best move; id `<gameId>:<ply>`. A move is accepted if it equals the engine move or is within 8 win-% points of the position's eval.
5. `stats()` (rating, median time used, serious errors per game over the last 20 analysed, score) feeds the Progress tab; `maybeBaseline()` freezes the first snapshot once 10 games are analysed. A manual reset stores `manual: <ISO time>` in the baseline.

**Sync (`Sync`, optional).** Local first: code that changes synced data calls `Sync.mark(kind, key)` (`an` game id, `pz` `account|puzzleId`, `base` `account|tc`, `la` `account|tc`), which queues it in the outbox; `flush()` uploads in chunks with upserts, reading current values from local storage. `pull()` fetches rows with `updated_at` after the stored watermark and merges: analyses fill games that have none (or go to `pending`), puzzle `seen`/`ok` are OR-ed and `fail` takes the max, baselines prefer the latest manual reset and otherwise the earlier date. The first sign-in on a device pulls, then queues everything local (`markAll`). The account id is `<source>:<username>` (`acct()`), the same prefix as the localStorage keys. supabase-js (`vendor/supabase-2.118.0.js`) is injected only when someone signs in or a session exists; sign-in is email OTP (link with PKCE, or the code typed in) so the `#tab` hash routing is never touched.

**Friends (`Fr`, optional).** Needs an account. `profiles` holds the display name, the `share` switch (GDPR consent; off deletes the person's stats via trigger) and a private invite code; opening `?invite=<code>` and signing in calls `add_friend()`, which makes two people friends at once (no pending state). `Fr.publish()` (debounced via `Fr.soon()`, called after analyses, puzzle answers, baseline changes and pulls) upserts one `leaderboard_stats` row for the current account and time control, computed in the browser by `Fr.row()`; the database refuses it unless sharing is on. Friends' rows are read only through the `friends_leaderboard(tc)` and `my_friends()` functions, which expose the display name and source but never usernames or emails.

**Opening trainer.** `buildTree(col, fam)` merges the first `OP_PLY` (24) plies of the current account's games in one colour + `famOf` family into a `Map` keyed by `posKey(fen)` (first four FEN fields, so transpositions merge). A node has visit count, score, moves played (each with its child key `ck`), engine best-move votes and eval from stored analyses, and my error count; `weak` = often an inaccuracy or worse, or score ≥ 10 points below the opening's. Drill (`OD`, `opStep`/`opMove`, board `OB`): opponent moves are picked by frequency (`opPickOpp`, nudged towards lines with due positions by `opNeed`); my move is right if it equals the pinned move (`OPS[k].pin`), else the engine's best, else is within `OP_TOL` (6) win-% (evals via `opEval`, cached). A miss shows arrows and the eval swing and offers replaying the same line. Progress `OPS` = `uk("openings")` `{posKey: {s, due, ok, miss, pin, at}}` with review intervals `OP_IV`; learned = streak ≥ `OP_LEARNED` (3). `uk("opstart")` holds when each opening (`"w|<family>"`) was first drilled; `opEffect()` compares the score before and after it (Progress insight and Openings view). `uk("opsel")` remembers the chosen opening. **Explorer:** `LiAuth` does Lichess OAuth with PKCE (unregistered public client `rapid-coach`; verifier in sessionStorage; `LiAuth.callback()` runs before `Sync.start()` so Supabase never sees Lichess's `?code=`); the token lives only in `rc.li.token`. `Explorer.moves(fen)` is serialised through one promise chain, cached in `rc.lx` (newest 600), backs off a minute after 429, drops the token on 401, and returns `null` whenever unavailable, so the trainer falls back to my own games. Sync kinds `op` (`account|posKey`, newest `changed_at` wins) and `ops` (`account|w|<family>`, earliest start wins) go to tables `opening_progress` and `opening_practice` (`003_openings.sql`); `Fr.row()` adds `openings_learned`.

**UI.** Hash routing (`#review`, `#trainer`, `#progress`, `#openings`, and `#friends` when accounts are on) shows one `<section id="v-...">`; `v-start` is the username form. `Board` is a hand-rolled click-to-move SVG board used three times (Review, Trainer, hero). Charts are hand-drawn SVG (`chart()`), no chart library. `job()` drives the shared progress bar.

## Roadmap

V2 (see `docs/V2-PLAN.md`): Lichess, optional Supabase accounts with sync, the friends leaderboard and the opening trainer are built. Not built yet: deleting long-inactive accounts and a keep-awake job for the free Supabase project.
