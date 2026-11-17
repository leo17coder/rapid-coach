#!/usr/bin/env python3
"""Build the vendored puzzle subset for the Tactics & checkmate patterns lessons.

Source: the Lichess puzzle database (CC0), https://database.lichess.org/#puzzles
  curl -O https://database.lichess.org/lichess_db_puzzle.csv.zst
  pip install zstandard
  python3 tools/build-puzzles.py lichess_db_puzzle.csv.zst

Writes vendor/lichess-puzzles-<YYYY-MM>/<course>.json, one file per lesson course (op-<opening>.json for the
"tactics in this opening" chapters of the Openings track, chosen by the OpeningTags column; eg-<course>.json for the
endgame puzzle chapters of the Endgames track, chosen by the endgame themes), loaded by the app only when
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
# "tactics in this opening" chapters (opening courses): Lichess OpeningTags families, the side that solves (None: either),
# 12 puzzles per band from 400 to 2000; "principles" takes early-opening puzzles (theme "opening") of any opening
OP_BANDS = BANDS + [(1800, 2000)]
OP_PER = 12
OPENINGS = {
    "principles": (None, None),
    "italian": (["Italian_Game"], None), "ruy": (["Ruy_Lopez"], None), "scotch": (["Scotch_Game"], None),
    "london": (["London_System"], "w"), "qg": (["Queens_Gambit_Declined", "Queens_Gambit_Accepted", "Slav_Defense", "Semi-Slav_Defense"], "w"),
    "scandinavian": (["Scandinavian_Defense"], "b"), "caro": (["Caro-Kann_Defense"], "b"), "french": (["French_Defense"], "b"),
    "sicilian": (["Sicilian_Defense"], "b"), "qgd": (["Queens_Gambit_Declined", "Slav_Defense", "Semi-Slav_Defense"], "b"),
    "english": (["English_Opening", "Zukertort_Opening", "Reti_Opening"], None),
}


# endgame chapters (Endgames track): Lichess endgame themes, bands as above plus 1800-2200, 30 per band, each puzzle in one file;
# "tech" also takes general endgame puzzles that carry no specific ending theme (mixed material)
EG_BANDS = BANDS + [(1800, 2200)]
EG_PER = 30
EG_SPEC = {"pawnEndgame", "rookEndgame", "bishopEndgame", "knightEndgame", "queenEndgame", "queenRookEndgame"}
ENDGAMES = {"kp": ["pawnEndgame"], "rook": ["rookEndgame"], "minor": ["bishopEndgame", "knightEndgame"], "tech": ["queenEndgame", "queenRookEndgame", "mixedEndgame"]}


def eg_band(r):
    for i, (lo, hi) in enumerate(EG_BANDS):
        if lo <= r < hi:
            return i, min(SUB - 1, (r - lo) * SUB // (hi - lo))
    return None, None


def op_band(r):
    for i, (lo, hi) in enumerate(OP_BANDS):
        if lo <= r < hi:
            return i, min(SUB - 1, (r - lo) * SUB // (hi - lo))
    return None, None


def band_of(r):
    for i, (lo, hi) in enumerate(BANDS):
        if lo <= r < hi:
            return i, min(SUB - 1, (r - lo) * SUB // (hi - lo))
    return None, None


def main(path):
    heaps = {}  # (course, theme, band, sub) -> heap of (plays, id, row)
    oheaps = {}  # (opening course, band, sub) -> heap
    eheaps = {}  # (endgame course, theme, band, sub) -> heap
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
            moves = row[ix["Moves"]].split()
            if len(moves) < 2 or len(moves) > 8:
                continue
            th = set(row[ix["Themes"]].split())
            eb, esub = eg_band(r)
            if eb is not None and "endgame" in th:
                tl = th & EG_SPEC or ({"mixedEndgame"} if not th & EG_SPEC else set())
                item = (plays, row[ix["PuzzleId"]], (row[ix["PuzzleId"]], row[ix["FEN"]], " ".join(moves), r, ""))
                for eid, tags in ENDGAMES.items():
                    for t in tags:
                        if t in tl:
                            h = eheaps.setdefault((eid, t, eb, esub), [])
                            if len(h) < KEEP:
                                heapq.heappush(h, item)
                            elif item > h[0]:
                                heapq.heapreplace(h, item)
            ob, osub = op_band(r)
            if ob is not None:
                tags = row[ix["OpeningTags"]].split()
                solver = "b" if row[ix["FEN"]].split()[1] == "w" else "w"
                item = (plays, row[ix["PuzzleId"]], (row[ix["PuzzleId"]], row[ix["FEN"]], " ".join(moves), r, ""))
                for oid, (fams, side) in OPENINGS.items():
                    if fams is None:
                        if "opening" not in th or r >= 1400:
                            continue
                    elif not tags or not any(t.startswith(f) for f in fams for t in tags[:1]) and not any(f in t for f in fams for t in tags):
                        continue
                    if side and solver != side:
                        continue
                    h = oheaps.setdefault((oid, ob, osub), [])
                    if len(h) < KEEP:
                        heapq.heappush(h, item)
                    elif item > h[0]:
                        heapq.heapreplace(h, item)
            b, s = band_of(r)
            if b is None:
                continue
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
    # endgame courses: eg-<id>.json, bands as EG_BANDS, a puzzle in one endgame file only
    eused = set()
    for eid, tags in ENDGAMES.items():
        bands = []
        for b in range(len(EG_BANDS)):
            pools = [sorted(eheaps.get((eid, t, b, s), []), reverse=True) for s in range(SUB) for t in tags]
            pick = []
            while len(pick) < EG_PER and any(pools):
                for p in pools:
                    while p and p[0][1] in eused:
                        p.pop(0)
                    if p and len(pick) < EG_PER:
                        it = p.pop(0)
                        eused.add(it[1])
                        pick.append(it[2])
            pick.sort(key=lambda x: x[3])
            bands.append([[i, f, m, r] for (i, f, m, r, t) in pick])
        print(f"eg-{eid:12s}", [len(b) for b in bands], file=sys.stderr)
        with open(os.path.join(d, "eg-" + eid + ".json"), "w") as f:
            json.dump({"course": "eg-" + eid, "bands": bands}, f, separators=(",", ":"))
    # opening courses: one file each (op-<id>.json), bands as above plus 1800-2000; a puzzle may appear in several openings' files
    for oid in OPENINGS:
        bands = []
        for b in range(len(OP_BANDS)):
            pools = [sorted(oheaps.get((oid, b, s), []), reverse=True) for s in range(SUB)]
            pick, seen = [], set()
            while len(pick) < OP_PER and any(pools):
                for p in pools:
                    if p and len(pick) < OP_PER:
                        it = p.pop(0)
                        if it[1] not in seen:
                            seen.add(it[1])
                            pick.append(it[2])
            pick.sort(key=lambda x: x[3])
            bands.append([[i, f, m, r] for (i, f, m, r, t) in pick])
        print(f"op-{oid:12s}", [len(b) for b in bands], file=sys.stderr)
        with open(os.path.join(d, "op-" + oid + ".json"), "w") as f:
            json.dump({"course": "op-" + oid, "bands": bands}, f, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv[1])
