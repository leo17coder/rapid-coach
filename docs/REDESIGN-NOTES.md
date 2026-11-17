# Kibitz redesign: notes

The redesign was built in nine stages, each its own pull request, merged after `npm test` passed and screenshots at 390 px
and 1440 px, dark and light, were checked:
[#2](https://github.com/leo17coder/rapid-coach/pull/2) design system, shell, name ·
[#3](https://github.com/leo17coder/rapid-coach/pull/3) Home ·
[#4](https://github.com/leo17coder/rapid-coach/pull/4) Review ·
[#5](https://github.com/leo17coder/rapid-coach/pull/5) Train hub and Puzzles ·
[#6](https://github.com/leo17coder/rapid-coach/pull/6) Openings ·
[#7](https://github.com/leo17coder/rapid-coach/pull/7) Lessons ·
[#8](https://github.com/leo17coder/rapid-coach/pull/8) Progress, Trophies, Friends ·
[#9](https://github.com/leo17coder/rapid-coach/pull/9) French, German, Danish ·
stage 9 (this one) polish. Screenshots of every stage are in `docs/screens/stage-N/`; the plan is `docs/DESIGN.md`.
No stage had to be reverted.

## What to look at first

1. **The start screen in another language**: the EN / FR / DE / DA switch at the top right, and the demo explaining 5.Nd6+ in plain words.
2. **Train › Puzzles**: the summary of your last 5 games, "Choose your training", a session, and the summary at the end.
3. **Review**: the game cards, a game opening at its first key moment, and the key moments written in plain words.
4. **Train › Openings**: switch White/Black, open one of your openings, then "Practise my lines".
5. **Home on a phone**: greeting, today's focus, the top 3 plan, the streak/goal/level strip, the latest game.
6. **Light theme** (Settings › Theme): every screen was checked in both themes.

## What changed

- **Name and identity.** Rapid Coach is now Kibitz: a green speech bubble with a 2×2 checker as the logo, Literata for
  headings and the coach's sentences, Atkinson Hyperlegible Next for everything else (both self-hosted). The repository,
  URLs, `rc.` storage keys, the IndexedDB name, the Lichess OAuth client id and invite links keep the old name.
- **Design system.** A warm dark "club room" palette is the default (light stays as an option and "match my device"),
  with tokens for every colour; all text pairs meet WCAG AA in both themes. Baize green marks the one main action per
  screen; brass is used only for motivation (XP, streaks, badges).
- **Navigation.** Four tabs (Home, Review, Train, Progress) as a sidebar on desktop and a labelled bottom bar on phones;
  Train has Puzzles / Openings / Lessons and Progress has Overview / Trophies / Friends as segmented sub-navigation. The
  profile menu (labelled on phones) holds Switch player, Sign in/Account and Settings. Old links redirect.
- **Home.** Greeting, today's focus (the top insight), today's plan (top 3, each with one clear button), a slim
  streak/goal/level strip linking to Trophies, and the latest game as a card.
- **Review.** Game cards grouped Today / Yesterday / This week / by month, 20 at a time, with filter chips. Each card:
  result and how, colour, opponent and ratings, opening, time control, a small board of the decisive moment, one
  rule-based sentence. A game opens at `#review/<id>` at its first key moment, with key moments first, the graph behind a
  disclosure and a wrapping move list.
- **Train › Puzzles.** A hub instead of a board: how the last 5 games went (results, sentences, blunders and mistakes,
  typical time against the goal, themes that cost most), then four trainings with counts and time estimates. Sessions end
  with a summary.
- **Train › Openings.** A gallery of cards (your openings first, then 35 White / 33 Black popular ones vendored in
  `vendor/openings-popular-2026-11.json`, names checked against chess-openings with chess.js), each with a board after
  the defining moves. An opening page has stats, "Practise my lines", "Learn the main lines", weak spots as small
  boards and the Lichess explorer option. No more dropdown.
- **Train › Lessons.** Tactics / Endgames switch, level chips, the top 3 priorities, course cards with progress rings
  and "For you", a page per course; the weakness profile behind "See your weakness profile".
- **Progress.** Actions in a bar at the top, key numbers, every insight with a link to act on it, charts / endings /
  openings behind "See more". Trophies show progress on locked badges; Friends' sharing is a switch.
- **Languages.** English, French, German and Danish (`i18n/*.js`, 694 keys each), browser language by default,
  switch on the start screen and in Settings. Dates and numbers through `Intl`. `node tools/check-i18n.cjs` checks keys,
  placeholders, HTML and plural forms.
- **Plain words.** No ISO dates; "+6.2 → −0.8" became "you were clearly winning, then it was about equal" (key moments,
  Show answer, the opening drill and the Why panel).
- **Accessibility.** 14 px minimum text, every control at least 44 px tall (touch move lists 44 px, 32 px with a
  mouse), visible focus rings, reduced motion respected (board slides, toasts, the demo), `aria-pressed` / `role=switch` /
  `role=radio` where they apply, `<html lang>` follows the language. Toasts moved to the top and never block clicks.
- **Tests.** 23 → 30 end-to-end tests. New: game cards open a game at its first key moment; the Puzzles summary comes
  first and the board only after starting; a session ends with a summary; opening cards follow the White/Black switch and
  open an opening page and its drill; lesson cards follow the track switch and open a course page; the start-screen
  language switch; Settings language remembered after reload. No test was weakened, skipped or deleted.

## Judgement calls (all stages)

- **Stage 1–2**: dark palette tuned by contrast rather than copied from anywhere; Literata + Atkinson Hyperlegible Next
  replaced Fredoka/Nunito; the old default theme "system" moves once to "dark" (`UI.v3`), "light" is kept; the
  start screen shows three benefits; Trophies became its own section under Progress.
- **Stage 3**: the game view has its own URL; two card columns on desktop; it opens at the first key moment (or the end);
  the numeric evaluation stays available as a tooltip and in the eval bar.
- **Stage 4**: about 1.2 minutes per puzzle; session sizes 10 / 10 / 8 / 5; a puzzle counts by its first answer, "Show
  answer" counts as missed, skipped ones aren't counted; the weakest theme opens its lesson course when your games have
  fewer than 3 such positions; sessions are not saved across reloads.
- **Stage 5**: popularity is ranked by hand (no authoritative count without a Lichess token), and the source note says
  so; defining moves for your own openings are the moves all your games in that family share; 12 popular cards first;
  the Evans Gambit and Black's 1.Nf3 d5 were dropped (more than three moves a side / no distinct name).
- **Stage 6**: opening courses moved out of Lessons (they open from each opening's page and from a link to the opening
  principles); the course page is a view inside Lessons, not a URL; rings count chapters.
- **Stage 7**: the old Progress headline (a copy of the top insight) is gone; key numbers come before insights; Reset
  baseline asks for confirmation; badge progress is read from each badge's rule.
- **Stage 8**: informal address (tu / du / du); move notation stays in English letters (N, B, R, Q) because chess.com,
  Lichess and chess.js use it and the app shows chess.js moves; opening names stay as chess-openings has them.
- **Stage 9**: text-style buttons, chips, footer links and the logo link grew to 44 px; the Why panel's move buttons are
  44 px on touch screens only; "No games yet" became an encouraging line; the eval bar's 10 px number became a
  tooltip (and stays in its screen-reader label), since a 14 px label does not fit the narrow bar; Home's focus line and
  plan only redraw when their text changes, so they no longer flicker while games are being analysed. The drill's coach
  messages, the lesson courses' buttons and the lesson player's status lines moved into translation keys.
- **Tools added along the way**: `tests/tools/screens.mjs` (screenshots, `KZ_LANG` for other languages),
  `tests/tools/a11y.mjs` (text under 14 px, controls under 44 px, unnamed controls), `tools/check-i18n.cjs`,
  `tools/build-popular.cjs`.

## Still in English

Lesson content (teaching pages, coach notes, course, chapter and lesson names, the reasons on the priority list and the
weakness profile's strength lines), the account dialog and its sync messages, parts of the friends leaderboard, the
analysis status pill's sync messages, and `privacy.html`. These are long or legal texts; translating them well needs a
translator, and they are the natural next step.

## Danish to check with a native speaker

All of `i18n/da.js` was written without a native speaker. The chess terms and phrases most worth a look:

- **Chess terms**: brøler (blunder), fejl (mistake), unøjagtighed, opgaver (puzzles), stime (streak), stimefrys (streak
  freeze), kvaliteten (the exchange), merbonde / merofficer / mertårn, binding / spid (pin / skewer), gafler (forks),
  svag grundlinje (back-rank weakness), lette officerer (minor pieces), hurtigskak / lynskak.
- **Coaching phrases**: "Du stod til gevinst, indtil {mv} gav fordelen væk", "Små fejl hobede sig op",
  "Du straffer ikke deres brølere", "Sigt efter at bruge omkring {aim}", "så sidder vanen".
- **Interface words**: Forside, Fremskridt, Træning, "Gennemgå", "Analysér", "Spring frem: test med {n} opgaver",
  "Nulstil udgangspunkt", "Træn mine varianter", "Lær hovedvarianterne".
- **Levels and badges**: Bonde → Konge, Ny i skak / Begynder / På vej frem / Øvet / Klubspiller, Stamgæst, Teorinørd,
  Natugle, Morgenfrisk, Weekendkriger, Skarpskytte.
- **Why panel**: "Efter {mv} spiller sort {r}, og du har tabt en springer", "du står bedst med lige materiale".

French and German were written with the same care (FR "gaffe", DE "grober Fehler"/"Patzer") and would also benefit from a
quick read by native speakers.
