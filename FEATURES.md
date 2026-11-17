# What Kibitz does: the "nothing broken" checklist

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
- [manual] Choosing Lichess, the time control (segmented: Rapid 10 min, All rapid, Blitz, Bullet), the language switch, or an invite link (`?invite=…`, shows the invite banner) works from the start screen.
- [manual] The demo on the start screen steps through the example on its own, and stops if you click it or have "reduce motion" on.

## Games and analysis
- [auto] **Analysis starts automatically** in the background after onboarding (latest 20 games), with progress in the status pill.
- [auto] **Reload keeps games and analyses**; older chess.com months are not fetched again, only the newest two.
- [auto] **Check for new games** adds games played since the last visit.
- [auto] chess.com and Lichess requests are made one at a time, and the site makes **no third-party requests** beyond the game and account APIs (fonts, icons and pieces are self-hosted).
- [manual] "Analyse 20 more games" queues more games; "Analyse" on a Review card or in the game view analyses that game first.

## Review
- [auto] **Game cards open a game at its first key moment**: the list shows one card per game (grouped Today, Yesterday, This week, then by month; 20 at a time with "Show more"), each with result and how, colour, opponent and both ratings, opening, time control, a small board of the decisive position and a one-sentence summary; "All games" goes back.
- [auto] **Evaluation graph, key moments and move list**: the graph shows; every move is listed; clicking a key moment jumps to it and shows the evaluation.
- [auto] **Keyboard and buttons step through moves** (←/→, start/end buttons), the **board flips**, and **filter chips work** (All, Wins, Losses, White, Black, Not analysed; Losses shows only losses).
- [manual] Key moments show the better move, the swing in plain words ("you were clearly winning, then it was about equal") and the time spent; the line under the board says how the position stands in words; the previous/next arrows step between games; the board shows the played move (red) and the better move (green) as arrows; the eval bar follows the position; clicking the graph jumps to that move.
- [manual] Reviewing a game (8 positions of an analysed game) counts towards the daily goal.

## Train › Puzzles (puzzles from your own blunders)
- [auto] **A summary of the last 5 analysed games comes first** (result and one sentence per game, linked to Review; blunders, mistakes, typical time used vs the goal; the themes that cost most once games are tagged); **the board appears only after starting** a training.
- [auto] **A session ends with a summary** (solved, missed, best run) with **Train again** and **Back to Train**.
- [manual] "Choose your training" offers, each with a count, a time estimate and a Start button: puzzles from these 5 games, retry the ones you missed (only when there are any), your weakest theme (opens its lesson course when your games have fewer than 3 such positions), and a quick 5-puzzle warm-up. Home's "Retry" and "new puzzles" plan cards start those sessions; leaving Train mid-session and coming back resumes it.
- [auto] **A puzzle from your own games appears** once games are analysed.
- [auto] **A wrong move gets feedback and an engine explanation** (the Why panel names the better move).
- [auto] **Hint and show answer** work.
- [auto] **The right move is accepted and remembered after reload.**
- [manual] Click-to-move, drag-and-drop and keyboard moves (arrows + Enter) all work on every board; a move "just as good" as the engine's counts as correct; the session counter (solved, run, best run) updates.

## Openings
- [auto] **Openings open** (the gallery).
- [auto] **Opening cards follow the White/Black switch and open an opening page** (stats), whose "Practise my lines" starts the drill.
- [manual] The gallery shows my openings first (games, score, positions learned), then popular ones (`vendor/openings-popular-…`, 12 at first, "Show more"), each card with a small board after the defining moves and the moves underneath; the colour choice is remembered. The opening page shows "Learn the main lines" when a lesson course teaches it, weak spots as small boards (tapping one drills from there), the before-and-after effect and the Lichess explorer option; Home's opening cards, Progress's opening table, the priority list and "Drill this line in the opening trainer" open the right opening.
- [manual] The opening drill plays the opponent's usual moves, grades my move, shows arrows after a miss and offers to replay the line; progress (learned positions) is kept; the optional Lichess explorer sign-in works and the trainer falls back to my own games without it.

## Lessons
- [auto] **Lessons open** with their tracks.
- [auto] **Course cards follow the Tactics/Endgames switch and open a course page** (chapters and lessons), with a way back.
- [manual] The lessons home shows the level as chips (the suggested one marked, a choice is remembered), the top 3 priorities, course cards with a progress ring and "For you", a link to the opening principles (opening courses also open from each opening's "Learn the main lines"), and the weakness profile behind "See your weakness profile".
- [manual] The priority list and weakness profile appear after enough analysed games; puzzle courses load (from `vendor/lichess-puzzles-…`), adapt to my level, give hints and record progress; opening courses play a line guided, then from memory; placement checks work; lesson progress is kept.

## Progress
- [auto] **Insights, key numbers, charts, endings and openings** all render.
- [auto] **A baseline is frozen once 10 games are analysed.**
- [manual] "Reset baseline" sets a new one; change since the baseline is shown on Progress.

## Home and motivation
- [auto] **Home shows a plan of actions.**
- [manual] Home shows, in order: a greeting, today's focus (the top insight with one action), today's plan (top 3, the first one primary), a streak / daily goal / level strip, and the latest game card ("N new games since your last visit"). The strip opens Progress › Trophies.
- [manual] Progress › Trophies: level and XP, streak (with freezes), the daily goal ring and its size (Light/Normal/Serious), the weekly challenge, badges (earned first, "See all"), records; toasts work; Settings › "Hide streaks, XP and badges" hides them on Home; XP only comes from training, never from results.

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
- [manual] Navigation: four tabs (Home, Review, Train, Progress) as a sidebar on desktop and a labelled bottom tab bar on phones; Train has Puzzles, Openings and Lessons, Progress has Overview and Friends; old links (`#trainer`, `#openings`, `#lessons`, `#friends`) open their new place; the profile menu holds Switch player, Sign in/Account and Settings.
- [manual] Settings: theme (dark by default, light, or match the device) and language.
- [manual] Board colours (green, wood, slate), piece sets, sound on/off; visible keyboard focus everywhere; reduced motion respected; text readable (WCAG AA) in light and dark.
- [manual] No script errors in the browser console while using the app (the automated run checks this for everything it touches).

## Releasing
- [manual] The `?v=` version in `index.html` (and `privacy.html` for the stylesheet) is bumped whenever `style.css`, `config.js` or `app.js` change.
- [manual] After merging, the live site at https://leo17coder.github.io/rapid-coach/ loads and a real username works.
