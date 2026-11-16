# Rapid Coach

A free chess coach for your chess.com and Lichess games. Enter a username and it:

- pulls your games from chess.com's or Lichess's public API,
- checks every move with Stockfish (running in your browser),
- shows your key moments, with the better move, the evaluation swing and the time you spent,
- turns your own blunders into puzzles, and
- tracks your progress against a starting point, with plain-language advice on what to work on.

No server compute and no AI calls. Everything runs and is stored in the visitor's browser. An optional account (email sign-in, no password) syncs analyses, puzzle progress and baselines across devices; games themselves are never uploaded.

## How it works

| Part | What it does |
| --- | --- |
| `index.html`, `style.css` | The page and its three tabs: Review, Trainer, Progress |
| `app.js` | Fetching games, analysis queue, puzzles, rule-based insights |
| `vendor/stockfish-19-lite-single.*` | Stockfish 19 (lite NNUE) compiled to WebAssembly, run in a Web Worker |
| `vendor/chess.js` | Move legality and PGN replay |

- **Games (chess.com)**: `https://api.chess.com/pub/player/<user>/games/archives`, then each monthly archive, one request at a time (chess.com doesn't rate-limit requests made one at a time). Past months are cached and not fetched again.
- **Games (Lichess)**: one streamed request to `https://lichess.org/api/games/user/<user>` (newest 2,000 games on the first load, then only games since the last one). After a 429 the app waits a full minute, as Lichess asks.
- **Analysis**: every position is analysed to depth 12. A move counts as an inaccuracy, mistake or blunder when the mover's winning chances drop by 10, 20 or 30 percentage points.
- **Puzzles**: every blunder or mistake made from a position that wasn't already lost becomes a puzzle. The answer is the engine's move, or any move within 8 points of it.
- **Home**: your plan for today (ranked by impact, with the XP each step earns), what happened since your last visit, progress against your baseline, quick actions and, with friends, a mini leaderboard.
- **Daily goal and streaks** (rule-based, never for wins): a daily goal ring with light/normal/serious intensity, streaks with freezes, XP and levels (Pawn to King), badges (milestones, real improvement, a few fun ones), a weekly challenge and personal records. Can be hidden.
- **Why panel** (Trainer and opening trainer): after a wrong move, on Show answer, or with "Why?" after a right one, Stockfish's lines show what your move allows and why the better move is better, e.g. "After Nd6+, Black plays Qxd6 and you've lost a knight." Step through each line on the board. Labels such as "wins the exchange" or "allows mate in 3" are fixed rules over material and mate at the end of the line; nothing leaves your browser.
- **Opening trainer** (Progress → Openings → Practise): the first 12 moves of your games in one opening, merged into a tree. Weak spots are positions where you often go wrong or your score drops. You play your side; the app plays your opponents' moves as often as they played them. The right move is your pinned repertoire move, else the engine's (within 6 points counts). Missed positions come back sooner (spaced repetition). Optionally, connecting a Lichess account fills thin spots with the Lichess opening explorer's most common moves at your rating.
- **Insights**: fixed rules over the analysed games, such as time used, errors made when already winning, unpunished opponent blunders, missed mates, error phase, opening scores, losses on time, long games and colour gap.
- **Storage**: IndexedDB for games and analyses, localStorage for the profile, puzzle progress and baseline.
- **Accounts (optional)**: Supabase (free plan, EU region). Changes are saved locally first and uploaded in the background. Setup: `supabase/README.md`. Privacy: `privacy.html`.

## Run locally

Any static server works. The page must be served over http(s), not opened as a file, because the engine runs in a Web Worker:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy for free

**GitHub Pages:** Settings → Pages → Source: *Deploy from a branch* → `main` / root. The site will be at `https://<user>.github.io/rapid-coach/`.

**Cloudflare Pages:** Workers & Pages → Create → Pages → connect this repo. Leave the build command empty and set the output directory to `/`.

## Licence

GPL-3.0 (see `LICENSE`), because the app ships Stockfish, which is GPL-3.0.
Stockfish: https://github.com/official-stockfish/Stockfish · stockfish.js: https://github.com/nmrugg/stockfish.js (licence in `vendor/STOCKFISH-LICENSE.txt`).
chess.js © Jeff Hlywa, BSD-2-Clause (`vendor/CHESSJS-LICENSE.txt`).
supabase-js © Supabase, MIT (`vendor/SUPABASE-JS-LICENSE.txt`).

Not affiliated with or endorsed by chess.com or Lichess.

## Roadmap (V2)

- ~~Optional accounts (Supabase) to sync across devices~~ (built; needs the Supabase setup above)
- ~~Friends leaderboard: blunders per game, time used, puzzles solved~~ (built; run `supabase/migrations/002_friends.sql`)
- ~~Lichess support~~ (done)
