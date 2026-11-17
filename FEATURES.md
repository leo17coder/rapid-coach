# What Rapid Coach does: the "nothing broken" checklist

Every item below must still work after any change, including redesigns. Items marked **[auto]** are checked by `npm test` (see `tests/run.mjs`; the test names match the bold words). Items marked **[manual]** need a quick human or Claude check in a browser before merging. If a change has to alter or remove an item, ask Leo first and update this file in the same pull request.

## How to check

```sh
npm install        # once: installs puppeteer-core (dev only; the site itself has no dependencies)
npm test           # ~1 minute, offline: uses a fake chess.com / Lichess built from tests/fixtures
npm test -- --only trainer    # just the tests whose name contains "trainer" (plus the steps they depend on)
```

Needs Chrome or Chromium (set `CHROME_PATH` if it isn't found automatically). On failure a screenshot is saved as `tests/failure-N.png`.

## Getting started
- [auto] **Start screen** shows the username form and the demo board.
- [auto] **Unknown username** shows "No … player called …" and stays on the start screen.
- [auto] **Onboarding** works with any capitalisation of the username and keeps only the chosen time control (blitz games are excluded under 10-minute rapid).
- [manual] Choosing Lichess, rapid/blitz/bullet, or an invite link (`?invite=…`, shows the invite banner) works from the start screen.
- [manual] The demo on the start screen steps through the example on its own, and stops if you click it or have "reduce motion" on.

## Games and analysis
- [auto] **Analysis starts automatically** in the background after onboarding (latest 20 games), with progress in the status pill.
- [auto] **Reload keeps games and analyses**; older chess.com months are not fetched again, only the newest two.
- [auto] **Check for new games** adds games played since the last visit.
- [auto] chess.com and Lichess requests are made one at a time, and the site makes **no third-party requests** beyond the game and account APIs (fonts, icons and pieces are self-hosted).
- [manual] "Analyse 20 more games" queues more games; "Analyse this game" in Review analyses the open game first.

## Review
- [auto] **Evaluation graph, key moments and move list**: the graph shows; every move is listed; clicking a key moment jumps to it and shows the evaluation.
- [auto] **Keyboard and buttons step through moves** (←/→, start/end buttons), the **board flips**, and **filters work** (Losses shows only losses).
- [manual] Key moments show the better move, the evaluation swing and the time spent; the board shows the played move (red) and the better move (green) as arrows; the eval bar follows the position; clicking the graph jumps to that move.
- [manual] Reviewing a game (8 positions of an analysed game) counts towards the daily goal.

## Trainer (puzzles from your own blunders)
- [auto] **A puzzle from your own games appears** once games are analysed.
- [auto] **A wrong move gets feedback and an engine explanation** (the Why panel names the better move).
- [auto] **Hint and show answer** work.
- [auto] **The right move is accepted and remembered after reload.**
- [manual] Click-to-move, drag-and-drop and keyboard moves (arrows + Enter) all work on every board; a move "just as good" as the engine's counts as correct; missed puzzles come back first; the session counter (solved, run, best run) updates.

## Openings
- [auto] **Openings open** (trainer or its empty state).
- [manual] The opening drill plays the opponent's usual moves, grades my move, shows arrows after a miss and offers to replay the line; progress (learned positions) is kept; the optional Lichess explorer sign-in works and the trainer falls back to my own games without it.

## Lessons
- [auto] **Lessons open** with their tracks.
- [manual] The priority list and weakness profile appear after enough analysed games; puzzle courses load (from `vendor/lichess-puzzles-…`), adapt to my level, give hints and record progress; opening courses play a line guided, then from memory; placement checks work; lesson progress is kept.

## Progress
- [auto] **Insights, key numbers, charts, endings and openings** all render.
- [auto] **A baseline is frozen once 10 games are analysed.**
- [manual] "Reset baseline" sets a new one; change since the baseline is shown on Home and Progress.

## Home and motivation
- [auto] **Home shows a plan of actions.**
- [manual] "Since your last visit", the daily goal ring, streak (with freezes), level, weekly challenge, badges, records and toasts work; intensity and "hide" settings are respected; XP only comes from training, never from results.

## Players, accounts and friends
- [auto] **Switch player**: a **Lichess account** loads its own games.
- [auto] **Switching back keeps the first player's data** (games, analyses, puzzle progress).
- [auto] **Existing V1 users keep their games, analyses and puzzle progress** after an update (storage snapshot in `tests/fixtures/v1-storage.json`).
- [auto] **With accounts switched off** (empty `supabaseKey`) the app works and hides Friends.
- [manual] With accounts on: email sign-in (link or code), sync across two browsers, friends via invite link, the leaderboard (only when sharing is on), display name and sharing switch, export my data, delete my account, sign out.
- [manual] `privacy.html` still matches what is stored.

## Look and feel
- [auto] **Settings: dark theme applies and is remembered.**
- [auto] **Layouts don't overflow sideways** on a phone (390 px) or a desktop (1280 px), and navigation is visible on both.
- [manual] Board colours (green, wood, slate), piece sets, sound on/off; the sidebar on desktop and the bottom tab bar on phones; visible keyboard focus everywhere; reduced motion respected; text readable (WCAG AA) in light and dark.
- [manual] No script errors in the browser console while using the app (the automated run checks this for everything it touches).

## Releasing
- [manual] The `?v=` version in `index.html` (and `privacy.html` for the stylesheet) is bumped whenever `style.css`, `config.js` or `app.js` change.
- [manual] After merging, the live site at https://leo17coder.github.io/rapid-coach/ loads and a real username works.
