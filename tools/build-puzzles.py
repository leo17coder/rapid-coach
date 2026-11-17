#!/usr/bin/env python3
"""Build the vendored puzzle subset for the Tactics & checkmate patterns lessons.

Source: the Lichess puzzle database (CC0), https://database.lichess.org/#puzzles
  curl -O https://database.lichess.org/lichess_db_puzzle.csv.zst
  pip install zstandard
  python3 tools/build-puzzles.py lichess_db_puzzle.csv.zst

Writes vendor/lichess-puzzles-<YYYY-MM>/<course>.json, one file per lesson course, loaded by the app only when
that course is opened. Each file: {"course": id, "bands": [[puzzle, ...] per rating band]}, a puzzle being
[lichess id, FEN before the opponent's last move, UCI moves (the first is the opponent's, then the solution),
rating] plus the mating-pattern tag for the "patterns" course. Selection is deterministic: well-rated
(Popularity >= 85), often played (NbPlays >= 300), settled ratings (RatingDeviation <= 100), at most four moves to
find, spread evenly across each band, each puzzle used in one course only.
"""
import csv, io, json, os, sys, heapq
import zstandard

BANDS = [(400, 1000), (1000, 1200), (1200, 1400), (1400, 1600), (1600, 1800)]
SUB = 10  # rating sub-bins per band, so picks spread across the band
# course id -> (Lichess themes, puzzles per band, mate allowed?)
COURSES = {
    "hanging": (["hangingPiece"], 48, False),
    "fork": (["fork"], 48, False),
    "pin": (["pin"], 48, False),
    "skewer": (["skewer"], 48, False),
    "discovered": (["discoveredAttack"], 48, False),
    "double-check": (["doubleCheck"], 40, True),
    "deflection": (["deflection"], 48, False),
    "mate1": (["mateIn1"], 48, True),
    "mate2": (["mateIn2"], 48, True),
    "mate3": (["mateIn3"], 44, True),
    "back-rank": (["backRankMate"], 44, True),
    "smothered": (["smotheredMate"], 30, True),
    "patterns": (["anastasiaMate", "arabianMate", "bodenMate", "doubleBishopMate", "dovetailMate", "hookMate"], 48, True),
}
# scarce courses pick first, so a puzzle tagged with several themes goes where it is needed most
ORDER = ["patterns", "smothered", "double-check", "back-rank", "skewer", "mate3", "deflection", "discovered", "pin", "mate2", "fork", "hanging", "mate1"]
KEEP = 6  # candidates kept per (course, theme, band, sub-bin)


def band_of(r):
    for i, (lo, hi) in enumerate(BANDS):
        if lo <= r < hi:
            return i, min(SUB - 1, (r - lo) * SUB // (hi - lo))
    return None, None


def main(path):
    heaps = {}  # (course, theme, band, sub) -> heap of (plays, id, row)
    with open(path, "rb") as fh:
        text = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh), encoding="utf-8")
        rd = csv.reader(text)
        head = next(rd)
        ix = {k: i for i, k in enumerate(head)}
        n = 0
        for row in rd:
            n += 1
            try:
                r, rdv, pop, plays = int(row[ix["Rating"]]), int(row[ix["RatingDeviation"]]), int(row[ix["Popularity"]]), int(row[ix["NbPlays"]])
            except ValueError:
                continue
            if pop < 85 or plays < 300 or rdv > 100:
                continue
            b, s = band_of(r)
            if b is None:
                continue
            moves = row[ix["Moves"]].split()
            if len(moves) < 2 or len(moves) > 8:
                continue
            th = set(row[ix["Themes"]].split())
            for cid, (tags, _, mate_ok) in COURSES.items():
                if not mate_ok and "mate" in th:
                    continue
                for t in tags:
                    if t in th:
                        k = (cid, t, b, s)
                        h = heaps.setdefault(k, [])
                        item = (plays, row[ix["PuzzleId"]], (row[ix["PuzzleId"]], row[ix["FEN"]], " ".join(moves), r, t))
                        if len(h) < KEEP:
                            heapq.heappush(h, item)
                        elif item > h[0]:
                            heapq.heapreplace(h, item)
        print(f"read {n} puzzles", file=sys.stderr)
    used, out = set(), {}
    for cid in ORDER:
        tags, per, _ = COURSES[cid]
        bands = []
        for b in range(len(BANDS)):
            # round-robin over sub-bins (and over themes for "patterns"), best-played first
            pools = [sorted(heaps.get((cid, t, b, s), []), reverse=True) for s in range(SUB) for t in tags]
            pick, k = [], 0
            while len(pick) < per and any(pools):
                for p in pools:
                    while p and p[0][1] in used:
                        p.pop(0)
                    if p and len(pick) < per:
                        it = p.pop(0)
                        used.add(it[1])
                        pick.append(it[2])
                k += 1
            pick.sort(key=lambda x: x[3])
            bands.append([[i, f, m, r] + ([t] if cid == "patterns" else []) for (i, f, m, r, t) in pick])
            print(f"{cid:13s} band {b}: {len(pick)}", file=sys.stderr)
        out[cid] = bands
    stamp = os.environ.get("PUZZLE_STAMP", "2026-11")
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vendor", f"lichess-puzzles-{stamp}")
    os.makedirs(d, exist_ok=True)
    for cid, bands in out.items():
        with open(os.path.join(d, cid + ".json"), "w") as f:
            json.dump({"course": cid, "bands": bands}, f, separators=(",", ":"))
    print("total", sum(len(b) for bs in out.values() for b in bs), file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
