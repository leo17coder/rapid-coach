# Rapid Coach V2 plan

Status: part 3 (Lichess) and part 1 (accounts and sync) are built; part 1 goes live once the Supabase setup in `supabase/README.md` is done. Part 2 (leaderboard) is built too; invite links make two people friends at once instead of a request to accept, and the 7-day puzzle count was left out. Not built yet from part 1: deleting long-inactive accounts, and the keep-awake job. The V1 rules still hold: all compute in the browser, no AI calls, free to run, GPL-3.0, one request at a time to every game API.

Build order: **3 → 1 → 2**. Lichess first, because it changes the local data keys that sync then has to mirror; the leaderboard last, because it needs accounts.

---

## 0. Groundwork (needed by all three parts)

- **Source-aware profile.** `P` becomes `{source: "cc"|"li", user, tc}`. `uk()` becomes `<source>:<user>.<k>`. Add a one-time migration on boot that renames the existing `rc.<user>.*` keys to `rc.cc:<user>.*` so V1 users keep their puzzle progress and baseline. Game ids are already prefixed `cc-`, so the IndexedDB store needs no migration. Each game record gets a `source` field.
- **Merge rules written down once**, used by both sync and import:
  - analysis: per game id; keep the one with the higher `depth`, otherwise keep the existing one.
  - puzzle progress: per puzzle id; `seen` and `ok` are OR-ed, `fail` takes the max.
  - baseline: per source + user + time control; the **earlier** date wins, it never moves forward.
- **`config.js`** (new, committed): Supabase URL and publishable key. Empty values mean "accounts off", and the app behaves exactly like V1.

---

## 1. Optional Supabase login (magic link)

### How it works

- A "Sign in to sync" link in the header. Without signing in nothing changes: IndexedDB and localStorage stay the source of truth.
- Signing in sends a magic link email. Use the **PKCE flow** (`flowType: "pkce"`), because the app already uses `location.hash` for its tabs and the default implicit flow puts the tokens in the hash. With PKCE the link comes back as `?code=...` and the router is untouched.
- Put the 6-digit code (`{{ .Token }}`) in the email template next to the link. People can then type the code on their laptop when they opened the email on their phone, and it still works when a mail scanner has already "clicked" the link.
- Vendor `supabase-js` (UMD build, pinned version) into `vendor/` with its MIT licence, to keep the no-CDN rule.
- Sync is "local first, then push/pull": after an analysis finishes, or a puzzle is answered, write locally, then upsert in the background. On sign-in and on page load, pull the rows changed since the last pull (`updated_at > last_pull`) and merge with the rules above. If offline, keep a small "to push" list in localStorage and retry.
- **Games themselves are not uploaded.** They can always be fetched again from chess.com or Lichess, and they contain the opponents' usernames (other people's personal data). Only what is expensive or personal to the user is synced: analyses, puzzle progress, baselines, linked usernames. A new device fetches the games from the source as V1 does and then attaches the synced analyses by game id, so nothing has to be re-analysed.

### What you set up yourself

1. **Supabase project** at supabase.com (free plan). Region: **EU**, e.g. Frankfurt (`eu-central-1`) or Stockholm (`eu-north-1`). The region can't be changed later.
2. **Auth → Sign In / Providers**: Email on, "Confirm email" on, passwords not needed (magic link / OTP only). Turn off any provider you won't use.
3. **Auth → URL Configuration**: Site URL `https://leo17coder.github.io/rapid-coach/`; redirect URLs: that URL plus `http://localhost:8000/`.
4. **Custom SMTP (required).** Supabase's built-in email sender only delivers to members of your Supabase organisation and is heavily rate-limited, so your friends would not receive links. Free options:
   - **Brevo**: free plan with a daily send limit, and you can verify a single sender address without owning a domain. Zero cost, but mail sent "from" a Gmail address through a third party may land in spam.
   - **Resend** or similar: generous free tier, but needs a domain you control.
   - A cheap domain (around €10 a year) is the one thing that clearly improves deliverability. It's optional, and the only item in this plan that isn't free.
   Enter the SMTP details under **Auth → SMTP Settings**, then raise the email rate limit under **Auth → Rate Limits** to match your provider.
5. **Email template** (Auth → Email Templates → Magic Link): plain text in English, with the link and `{{ .Token }}`, and the app's name, so it doesn't look like phishing.
6. **Keys**: copy the project URL and the **publishable/anon key** into `config.js`. That key is meant to be public and is safe only because every table has Row Level Security. **Never** put the `service_role`/secret key in the repo or the browser.
7. **Optional bot protection**: Auth → Attack Protection → CAPTCHA with Cloudflare Turnstile (free). Worth turning on if sign-up spam appears.
8. **Run the SQL migration** (I'll write it as `supabase/migrations/001_init.sql`) in the SQL editor. It creates the tables, RLS policies and the delete-account function below.
9. **Sign Supabase's DPA** (data processing agreement) from the organisation's legal documents page in the dashboard, and keep a copy. Do the same with the email provider.

### What gets stored

| Table | Columns | Notes |
| --- | --- | --- |
| `auth.users` (Supabase) | email, sign-in timestamps | Managed by Supabase |
| `profiles` | `id` (= auth user id), `display_name`, `created_at` | Display name chosen by the user; never show emails to anyone |
| `linked_accounts` | `user_id`, `source`, `username`, `tc` | Which chess.com/Lichess names this person reviews |
| `analyses` | `user_id`, `game_id`, `depth`, `ev smallint[]`, `best text[]`, `updated_at` | Primary key `(user_id, game_id)` |
| `puzzle_progress` | `user_id`, `puzzle_id`, `seen`, `ok`, `fail`, `updated_at` | One row per puzzle tried |
| `baselines` | `user_id`, `source`, `username`, `tc`, `stats jsonb`, `date` | Insert-once per key |

Every table: `user_id uuid references auth.users on delete cascade`, RLS on, with policies `user_id = auth.uid()` for select/insert/update/delete.

### Staying in the free tier

Supabase free plan limits as I know them (check the current pricing page; they change): a 500 MB database, generous monthly active users (tens of thousands), a few GB of egress a month, and **projects pause after about a week with no activity**.

- Size: an analysis is about 80 plies × (2-byte eval + 4–5 character move) ≈ 1 KB with row overhead. 1,000 analysed games per person ≈ 1–2 MB, so a few hundred heavy users still fit easily. Not storing games is what keeps it this small.
- Egress: pull only rows changed since the last pull, and never `select *` on the whole history after the first sync.
- Pausing: if your group goes quiet for a week, the project pauses and sign-in fails until you un-pause it in the dashboard. Optional fix: a free GitHub Actions cron job (public repo) that calls a cheap endpoint every few days. The app must handle "Supabase unreachable" by carrying on locally.
- No Edge Functions, no Storage, no Realtime: none are needed.

### GDPR (Denmark)

Sharing with friends over the public internet is not clearly covered by the "household" exemption, so treat GDPR as applying. You are the **data controller**; Supabase and the email provider are **processors**. The Danish authority is Datatilsynet.

- **Privacy page** (`privacy.html`, linked from the footer and the sign-in box), in plain language: who you are and how to contact you; what is stored (table above); why (to sync your own data across devices, and the leaderboard if you opt in); legal basis: performance of the service the user asked for (Art. 6(1)(b)), and **consent** for the leaderboard; processors and where data lives (EU region); retention (until you delete your account; accounts unused for e.g. 24 months are deleted); rights (access, export, correction, deletion, complaint to Datatilsynet).
- **Self-service deletion**: a "Delete my account" button calling a `security definer` SQL function that deletes the caller's `auth.users` row. `on delete cascade` removes everything else. The local copy stays in that browser, and the page says so.
- **Export**: a "Download my data" button that writes a JSON file of everything the account has. This also doubles as a backup and import path for people without accounts.
- **Data minimisation**: no games or opponent names on the server, no IP logging of your own, no analytics, no tracking scripts.
- **Cookies/ePrivacy**: storing the login session and app data in localStorage is strictly necessary for a service the user requested, so **no cookie banner is needed**, provided you add no analytics or third-party embeds.
- **Age**: add "for people aged 13 and over" (Denmark's age for information-society services).
- **Breaches**: if the database is exposed, Datatilsynet must be told within 72 hours. Keep RLS on every table; this is the main risk.

---

## 2. Friends leaderboard

### How it works

- **Opt-in**: a "Share my stats with friends" switch, off by default. Turning it off deletes your stats row.
- **Adding friends by invite link**, not by searching emails or names: each user has a random invite code; `.../rapid-coach/?invite=AB12CD` creates a pending request; the other person accepts. Either side can remove the friendship at any time.
- **Columns** (per time control, for the source each friend chooses to share):
  - blunders per game: blunders in the last 20 analysed games ÷ 20 (also show mistakes)
  - median time used per game (last 30 games, from `timeUsed()`)
  - puzzles solved (total, plus the last 7 days)
  - rating change since baseline: current minus baseline rating, **as a difference only**. chess.com and Lichess ratings aren't comparable, and nor are different time controls.
  - games analysed, so a "0.4 blunders per game" from 3 games is visibly weak. Show "–" below 10.
- The stats are **computed in the browser** (from the existing `stats()` and puzzle data) and uploaded as one row. They are therefore self-reported and could be faked by someone editing requests. That's fine for friends; don't present it as more than that.
- Refresh: upload after each finished analysis batch or solved puzzle, at most once a minute.

### What you set up yourself

Nothing beyond part 1: the migration adds the tables and policies.

### What gets stored

| Table | Columns |
| --- | --- |
| `invite_codes` | `user_id`, `code` (random, can be regenerated) |
| `friendships` | `requester`, `addressee`, `status` (`pending`/`accepted`), `created_at` |
| `leaderboard_stats` | `user_id`, `source`, `tc`, `games_analysed`, `blunders_per_game`, `mistakes_per_game`, `median_time_used`, `puzzles_solved`, `puzzles_solved_7d`, `rating_now`, `rating_base`, `base_date`, `updated_at` |

RLS: you can read a stats row if it's yours or if an `accepted` friendship exists in either direction (via a small `are_friends(a, b)` SQL function). You can only write your own row. Friendship rows are visible to the two people involved. Accepting a request is an RPC that checks you are the addressee. `display_name` from `profiles` is readable by friends only.

### Free tier

One row per user per time control, read with one query when the Progress tab opens. Negligible.

### GDPR

- Separate **consent** for sharing (the opt-in switch), recorded with a timestamp, withdrawable at any time (switch off = row deleted).
- Friends see only display name and the numbers above, never email or games.
- Rating and username are public on chess.com/Lichess anyway, but the derived stats aren't: that's why consent is needed.
- Add a leaderboard section to the privacy page.

---

## 3. Lichess as a second game source

### How it works

- On the start screen, a source switch: **chess.com | Lichess**, then username and time control.
- Endpoint: `GET https://lichess.org/api/games/user/{username}` with `Accept: application/x-ndjson` and the parameters `perfType` (`rapid`/`blitz`/`bullet`), `clocks=true`, `opening=true`, `moves=true`, `since=<ms>` for incremental fetches and `max` for the first load (e.g. 1,000). The response is a stream of one JSON game per line; read it with `response.body.getReader()` so games appear as they arrive, like the first chess.com month does today.
- Mapping into the existing game record: `id: "li-<id>"`, `moves` from the space-separated SAN string, `clocks` from the centisecond `clocks` array ÷ 100, `tc` from `clock.initial` + `clock.increment` (e.g. `"600+0"` → `"600"`, matching chess.com's format), `tclass` from `speed`, `result` from `winner`/`status`, `how` from `status` (`mate`, `resign`, `outoftime`, `draw`, `stalemate`...), `myR` from `players.<colour>.rating`, `eco` from `opening.name`, `link: https://lichess.org/<id>`.
- Incremental sync: store the newest game's timestamp per user and time control (instead of chess.com's month list) and pass it as `since`.
- **Rate limit**: Lichess asks for one request at a time and, after a 429, waiting a full minute before trying again. The current `api()` backs off for 2–8 seconds, so Lichess needs its own wait of 60 seconds or more. No API token is needed for public games, and CORS is allowed.
- The "10-minute rapid" option maps to Lichess `600+0` games.
- Ignore Lichess's own server analysis (`evals`) for now, so all games get the same depth-12 Stockfish analysis and the same thresholds.
- Insights and copy that mention chess.com by name become source-neutral. Add "Not affiliated with Lichess" next to the chess.com line.

### What you set up yourself

Nothing. No account, key or setting is required.

### What gets stored

Locally only: the same game records in IndexedDB (with `source: "li"`) and a `last.<tc>` timestamp per user. With an account, the same synced tables as chess.com (analyses, puzzle progress, baselines), keyed by `li-` game ids and `source = "li"`.

### Free tier / GDPR

Nothing runs on a server. As with chess.com, games aren't uploaded, so opponents' Lichess names never reach Supabase.

---

## Open questions for you

1. Brevo with your own address (free, may land in spam) or buy a small domain for sending mail?
2. Inactive-account deletion after 24 months: OK, or a different period?
3. Should one account link both a chess.com and a Lichess name, with the leaderboard letting each person pick which one to show? (The plan assumes yes.)

---

## 4. Opening trainer (built)

From Progress → Openings → **Practise**, a drill view (`#openings`) for one colour + opening family, built from the first 12 moves of your own games.

- **Tree and weak spots**: positions merged across games (transpositions included), with how often each was reached, the moves played and the score from there. Weak spots: an inaccuracy or worse in at least a third of analysed visits, or a score 10+ points below the opening's average; ranked by how often they come up.
- **Right move**: pinned repertoire move, else Stockfish's move from the stored analyses, else a quick depth-14 eval; anything within 6 win-% counts.
- **Drill**: opponent moves in proportion to your opponents' choices (nudged towards lines with positions due for review). A miss shows the right move with an arrow and the eval swing, then replays the same line.
- **Spaced repetition**: correct streak and next review per position (1, 3, 7, 16, 35, 80 days); a miss resets the streak and comes back within 10 minutes. Three correct reviews in a row = learned. Synced via `supabase/migrations/003_openings.sql`; "openings learned" is on the friends leaderboard.
- **Lichess opening explorer**: now at `explorer.lichess.org` and requires a Lichess OAuth token. The app uses Lichess's PKCE flow for unregistered public clients ("Connect Lichess"); the token stays in the browser. Used only where your own games have fewer than 3 games at an opponent's turn; one request at a time, cached locally, and the trainer works without it.
- **Effect**: score in the opening before vs since your first drill (needs 5+ games on each side), as a Progress insight.

## 5. Move explanations (built)

A shared Why panel in the Trainer and the opening drill shows Stockfish's lines for your move and the better move, with rule-based labels, steppable on the board.

## 6. Home tab and gamification (built)

- `#home` is the default tab for returning users: plan for today, since last visit, progress at a glance, quick actions, mini leaderboard.
- Rule-based gamification from local training data: daily goal (light 5 / normal 10 / serious 20 units: puzzle or opening position 1, reviewed game 3), streak with freezes (one per 7 days, max 2, used automatically), XP for training only (puzzle 10, first try +5, opening position 3, learned +15, game reviewed 10, daily goal 25, weekly challenge 100), levels Pawn 0, Knight 500, Bishop 1,500, Rook 3,500, Queen 7,000, King 12,000, King I 20,000 and +8,000 per further level; 21 badges; personal records with a short celebration; everything hideable, no notifications.
- Synced via `004_gamification.sql` (one row per account; merging is per-field max/union); weekly XP and streak on the friends leaderboard, with "You passed X this week!".
- Start screen: feature blocks, trust points, demo board stepping through a sample explanation, invite banner.

## 7. Tailored lessons (all 4 stages built)

- **Weakness profile:** every mistake/blunder in the newest 60 analysed games is tagged once by fixed rules over two Stockfish lines (my best line, the opponent's best reply line): hanging piece, missed/allowed fork, missed pin/skewer, missed free material, missed/allowed mate, back-rank weakness, other tactics, positional; plus phase and ending type. Tags stay local with the games.
- **Priority list:** themes and habits (errors when winning, fast play, weakest opening) ranked by win-% points lost per game, each with a one-line reason and a lesson; the top item feeds Home's plan.
- **Level:** from rating (Lichess −250) and accuracy; "New to chess" and "Beginner" get First steps first; override any time.
- **Framework:** Lessons tab with tracks > courses > chapters > lessons; guided puzzle steps with coach notes, the Why panel and eval bar; teaching pages; placement checks; local progress synced via `006_lessons.sql`; XP, daily goal, badges, "lessons completed" on the leaderboard.
- **Sample content:** First steps (moves, check and checkmate, don't hang pieces) and Tactical patterns › Forks, pins and skewers, all validated with Stockfish.
- **Stage 2, tactics & checkmate patterns:** 13 puzzle courses from a vendored CC0 subset of the Lichess puzzle database (2,926 puzzles, 300 KB, one file per course loaded on first use; `tools/build-puzzles.py`). Chapters per rating band (up to 1000 … 1600-1800) with Warm-up, Practice and Challenge lessons of 6 adaptive puzzles (Elo-style skill per course, synced in `lesson_progress`), a 4-puzzle placement check per chapter, hints, the Why panel, and a hand-written teaching page per course with diagrams, a worked example from a real game and a checklist. Placement from rating and weakness profile; the priority list and Home link straight into the chapter. No new SQL.
- **Stage 3, openings:** an opening-principles course plus 11 opening courses for White and Black, 49 hand-written lines (each move checked with Stockfish) with coach notes and trap lines, played guided and then from memory; a 4-move placement check per chapter; a "tactics in this opening" chapter per course from the puzzle database's OpeningTags (another 828 puzzles); a teaching page per opening with a worked example from a real game. Courses for the openings you play (from your games) are marked and start at the chapter for your colour and level; the weakest-opening priority links into its course; "Drill this line" pins the moves in the opening trainer, which then drills the line with spaced repetition. Opening names from lichess-org/chess-openings (CC0). No new SQL.
- **Stage 4, endgames:** 5 courses (basic mates, king and pawn, rook, minor pieces, queen endings & technique) with 20 hand-written lessons, each a pattern with a teaching page (the Lucena and Philidor methods move by move); 47 positions, either "find the move" or "play it out" against Stockfish at a depth set by level (win by mate or a safe promotion, hold a draw by the rules or for a number of moves), all checked with Stockfish; a placement check per chapter; endgame puzzle chapters per rating band up to 2200 from the Lichess endgame themes (720 puzzles), adaptive as in stage 2. Placement from rating and the ending types in the weakness profile; the priority list's ending items and Home link straight into the chapter. No new SQL.
- **Done:** the lessons roadmap is complete.

