# Kibitz design plan

A *kibitzer* is the onlooker at a club table who comments on your game. Kibitz is that friend: it looks over your own
chess.com and Lichess games afterwards and tells you, kindly and briefly, what happened and what to train.

**Concept: the club room after the games.** A warm, dimly lit club: charcoal wood-panelled walls, a green baize board under
the lamp, brass on the trophy shelf, and a coach whose remarks read like the annotations in a good chess book. Calm,
encouraging, never cluttered. Every screen has one obvious main action; everything else waits behind "See more", a tab or
a detail page.

## Colour

Dark is the default; light stays as an option in Settings. All text/background pairs meet WCAG AA (body text ≥ 7:1 on the
background in dark, ≥ 4.5:1 for secondary text).

| Token | Dark | Light | Role |
|---|---|---|---|
| Club charcoal `--bg` | `#1D1C1A` | `#F2F3EF` | page background: a warm, slightly brown charcoal (not a tinted near-black) |
| Panel `--surface` | `#282623` | `#FFFFFF` | cards and the sidebar |
| Raised `--raised` | `#33302C` | `#E9EBE5` | inputs, chips, hover, inner wells |
| Line `--border` | `#46423C` | `#D3D6CE` | hairlines, card edges |
| Ivory `--text` | `#F1ECE2` | `#1C1F1A` | text |
| Smoke `--muted` | `#BDB5A6` | `#4F564C` | secondary text (≥ 14 px only) |
| Baize green `--primary` | `#7BC55C` (text on it `#10200A`) | `#2E7A23` (text on it `#FFFFFF`) | the one main action per screen, focus, links |
| Brass `--gold` | `#E3B654` | `#8A6510` | streaks, XP, trophies, "For you" |
| Signals | win `#8FD06F`, loss `#F2826F`, draw `#AEB8C4` | win `#2E7A23`, loss `#B53A2A`, draw `#56606B` | results and move quality |

The board keeps its own felt: light `#E8E5C8`, dark `#6F8F52` (Garden), with Walnut and Slate as options.

Review against the brief: the brief asks for chess-club charcoal with a bright green main button, which sits close to the
"near-black + one bright accent" default. What makes it ours: the charcoal is warm and brown, not neutral `#111`; the green
is a soft baize, not acid; a second, quieter accent (brass) carries everything about motivation, so green only ever means
"do this"; and the coach's voice gets its own typeface.

## Type

- **Literata** (variable, optical sizes): headings and the coach's sentences (today's focus, game summaries, insights). It's a
  book face, so the commentary reads like annotations in a chess book. This is where the design spends its boldness.
- **Atkinson Hyperlegible Next** (variable): all interface text, numbers and buttons. Chosen for legibility at small sizes on
  dark backgrounds; numbers use tabular figures where they line up.
- Scale (1.2 ratio, 16 px base): 14 secondary (the minimum), 16 body, 18 lead/coach text, 22 h3, 27 h2, 32 h1, 40 start
  headline. Line length ≤ 72 characters for prose. Sentence case everywhere; no all-caps labels, no eyebrows above headings,
  no "A · B · C" meta strings (use two short lines or a chip).
- Both fonts are vendored in `vendor/fonts/` with their OFL licences; no third-party font requests.

## Shape and depth

Not every block is a card. Three levels:
1. **Plain**: headings, sentences and lists sit directly on the background (today's focus, summaries).
2. **Card** (`--surface`, 1 px line, radius 16): things you can open or act on (game cards, opening cards, plan items).
3. **Feature card** (`--raised` with a baize or brass edge on the left): the one primary thing on a screen.

Radius: 10 for controls, 16 for cards, pills for chips. Shadows only on overlays (menus, dialogs, toasts).
Motion: one short reveal for the focus sentence on Home; everything else only answers an action (menu opening, a move
sliding). `prefers-reduced-motion` turns it all off.

## Layout

Left-aligned content, max width 1080 px on desktop. Desktop: a 240 px sidebar with the logo, the four tabs and the profile
button at the bottom. Phone: a slim top bar (logo, analysis status, labelled profile button) and a bottom tab bar with four
labelled tabs.

Tabs: **Home, Review, Train, Progress**. Train has three sections (Puzzles, Openings, Lessons) and Progress three (Overview,
Trophies, Friends when accounts are on), switched with a segmented control at the top of the tab. Old links (`#trainer`,
`#openings`, `#lessons`, `#friends`) redirect to their new place.

### Home

```
Good evening, Leo                                    (Literata h1)

Today's focus                                         plain, no card
  You often hang a piece when you're winning.         Literata 22
  [ Train this ]                                      primary

Today's plan
  ┌ Solve 5 puzzles from your games    +25 XP [Start]┐   first: feature card, green button
  │ Review your loss against Bob        +30 XP  Open │   then quiet rows
  │ Drill the Caro-Kann                 +20 XP  Go   │
  └──────────────────────────────────────────────────┘
  🔥 6 days   ◔ 4 / 10 today   Knight · 820 XP          one strip, brass

Latest game                                 2 new since your last visit
  ┌──────┬──────────────────────────────────────────┐
  │board │ Lost, on time · Sun 15 Nov, 14:32        │
  │      │ You were winning until 31…Rd2 let it slip│
  └──────┴──────────────────────────────────────────┘
```

### Review list

```
Review
( All ) ( Wins ) ( Losses ) ( White ) ( Black ) ( Not analysed )     chips

Today
┌──────┬───────────────────────────────────────────┐
│ mini │ Won · with White · checkmate       14:32  │
│board │ vs bob_99 (1412) · you 1398 · Caro-Kann   │  → two lines, not one long string
│      │ Your opponent blundered on move 18 and    │  Literata summary
│      │ you made it count.                         │
└──────┴───────────────────────────────────────────┘
Yesterday
...
[ Show more ]
```
Game view: back link "All games", board on the left, key moments as the main column, compact wrapping move list below.

### Train hub, Puzzles summary

```
Train   [ Puzzles | Openings | Lessons ]                segmented

Your last 5 games
  W  L  L  W  D                                         result chips
  3 blunders, 5 mistakes · you missed forks most        plain text
  Time used: 6:10 of a 10:00 goal
  - "You were winning until 22…Qxb2 let it slip."       summaries (Literata)

Choose your training
┌ Puzzles from these 5 games ┐ ┌ Retry the ones you missed ┐
│ 7 puzzles · about 10 min   │ │ 3 puzzles · about 5 min   │
│ [Start]                    │ │ [Start]                   │
└────────────────────────────┘ └───────────────────────────┘
┌ Your weakest theme: forks  ┐ ┌ Quick warm-up             ┐
```

### Openings gallery

```
Openings              [ White | Black ]

Openings you play
┌──────────┐ ┌──────────┐ ┌──────────┐     3 per row desktop, 2 tablet, 1–2 phone
│ Caro-Kann│ │ London   │ │ ...      │
│ [board]  │ │ [board]  │ │          │
│1.e4 c6 2.│ │          │ │          │
│12 games  │ │          │ │          │
│54% · 6 learned        │ │          │
└──────────┘ └──────────┘ └──────────┘
Popular openings
...
```
Opening page: stats, "Practise my lines" (primary), "Learn the main lines", weak spots as small boards, Lichess option.

### Puzzle session summary

```
Session done
  6 solved · 1 missed · best run 4             big numbers, plain
  [ Train again ]   Back to Train
```

## Principles

1. One main action per screen, in baize green. Everything else is quieter.
2. Show each piece of information in one home: the top insight on Home, all insights on Progress.
3. Write like a friend at the club: plain words, no engine jargon, no ISO dates, relative dates where natural.
4. Empty states say what to do next; no walls of zeros or grey badges.
5. Brass is for motivation only; green is for action only.
6. Accessible by default: 14 px minimum, AA contrast, 44 px targets, visible focus, reduced motion respected.
