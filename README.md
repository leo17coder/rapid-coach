# Rapid Coach

A free chess coach for your chess.com games. Enter a username and it:

- pulls your games from chess.com's public data API,
- checks every move with Stockfish (running in your browser),
- shows your key moments, with the better move, the evaluation swing and the time you spent,
- turns your own blunders into puzzles, and
- tracks your progress against a starting point, with plain-language advice on what to work on.

No accounts, no server, no AI calls. Everything runs and is stored in the visitor's browser.

## How it works

| Part | What it does |
| --- | --- |
| `index.html`, `style.css` | The page and its three tabs: Review, Trainer, Progress |
| `app.js` | Fetching games, analysis queue, puzzles, rule-based insights |
| `vendor/stockfish-19-lite-single.*` | Stockfish 19 (lite NNUE) compiled to WebAssembly, run in a Web Worker |
| `vendor/chess.js` | Move legality and PGN replay |

- **Games**: `https://api.chess.com/pub/player/<user>/games/archives`, then each monthly archive, one request at a time (chess.com doesn't rate-limit requests made one at a time). Past months are cached and not fetched again.
- **Analysis**: every position is analysed to depth 12. A move counts as an inaccuracy, mistake or blunder when the mover's winning chances drop by 10, 20 or 30 percentage points.
- **Puzzles**: every blunder or mistake made from a position that wasn't already lost becomes a puzzle. The answer is the engine's move, or any move within 8 points of it.
- **Insights**: fixed rules over the analysed games, such as time used, errors made when already winning, unpunished opponent blunders, missed mates, error phase, opening scores, losses on time, long games and colour gap.
- **Storage**: IndexedDB for games and analyses, localStorage for the profile, puzzle progress and baseline.

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

Not affiliated with or endorsed by chess.com.

## Roadmap (V2)

- Optional accounts (Supabase) to sync across devices
- Friends leaderboard: blunders per game, time used, puzzles solved
- Lichess support
