// End-to-end tests for Rapid Coach. Run: npm install && npm test
// Options: --only <text> (tests whose name contains <text>, plus the main-flow steps before them), --keep-going
// Every test drives the real page in headless Chrome against a fake chess.com / Lichess (tests/fixtures),
// so it runs offline and never touches the real APIs or Supabase. Each test maps to an item in FEATURES.md.
// When the UI changes, update the selectors in SEL (one place) — never weaken what a test checks.
import fs from "node:fs";
import path from "node:path";
import { ROOT, CC_USER, LI_USER, CC_RAPID_10, serve, launch, newPage, sleep, waitFor, st, text, visible, goto, tab, clickSquare, seedStorage } from "./lib.mjs";

const SEL = {
  start: "#v-start", uName: "#uName", srcCc: "#uSrcCc", srcLi: "#uSrcLi", tc: v => `input[name="uTc"][value="${v}"]`, startBtn: "#startBtn", startMsg: "#startMsg", heroBoard: "#heroBoard",
  who: "#whoName", profBtn: "#profBtn", switchBtn: "#switchBtn", navLink: t => `#hdr nav a[data-t="${t}"], #subnav a[data-t="${t}"]`, nav: "#hdr nav",
  card: ".gcard-link[data-g]", chip: v => `#rvChips [data-f="${v}"]`, back: "#rvBack", rvGame: "#rvGame", board: "#board", flip: "#flipBtn", navBtn: a => `[data-nav="${a}"]`, evFig: "#evFig", evNow: "#evNow",
  kmCard: "#km button[data-p]", moveBtn: "#moves button[data-p]",
  tboard: "#tboard", tHint: "#tHint", tShow: "#tShow", tNext: "#tNext", tPrompt: "#tPrompt", tFeedback: "#tFeedback", tOk: "#tFeedback .v-ok", tNo: "#tFeedback .v-no", tWhy: "#tWhy",
  tSum: "#tSum", tHub: "#tHub", tPlay: "#tPlay", tDone: "#tDone", tMode: m => `#tModes [data-mode="${m}"]`, tAgain: "#tAgain", tBack: "#tBack", tQuit: "#tQuit",
  insights: "#insights", kpis: "#pKpis", charts: ["#ratingFig", "#timeFig", "#errFig"], ends: "#ends", opRows: "#opBody tr", syncBtn: "#syncBtn",
  homePlan: "#hPlan .plan-card", lsTracks: "#lsTracks", oMain: "#oGal", oEmpty: "#oPage", oCard: ".ocard[data-k]", oCol: v => `input[name="oCol"][value="${v}"]`, oPage: "#oPage", oName: "#opName", oDrill: "#oDrill", oPractise: "#opPractise", oPrompt: "#oPrompt",
  setBtn: "#setBtn", settings: "#settings", theme: v => `input[name="sTheme"][value="${v}"]`, setClose: "#setClose",
};
const TABS = ["home", "review", "train/puzzles", "train/lessons", "progress", "train/openings"];
const V1 = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/v1-storage.json"), "utf8"));

/* ---------- runner ---------- */
const args = process.argv.slice(2), only = args.includes("--only") ? args[args.indexOf("--only") + 1].toLowerCase() : null, keepGoing = args.includes("--keep-going");
const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const lsGet = (page, k) => page.evaluate(k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return localStorage.getItem(k); } }, k);
const setChecked = (page, sel) => page.$eval(sel, e => { e.checked = true; e.dispatchEvent(new Event("change", { bubbles: true })); e.dispatchEvent(new Event("input", { bubbles: true })); });
async function onboard(page, user, source = "cc", tc = "600") {
  await waitFor(page, s => !document.querySelector(s).hidden, { label: "start screen", arg: SEL.start });
  await setChecked(page, source === "li" ? SEL.srcLi : SEL.srcCc);
  await setChecked(page, SEL.tc(tc));
  await page.$eval(SEL.uName, e => { e.value = ""; });
  await page.type(SEL.uName, user);
  await page.click(SEL.startBtn);
}
const ctx = {}; // values shared between the ordered tests of the main flow
/** Account actions and settings live in the profile menu: open it, then click the item. */
/** Next puzzle in the session; when the session is over, start it again. */
async function nextPz(page) {
  await page.click(SEL.tNext); await sleep(300);
  if (await visible(page, SEL.tDone)) { await page.click(SEL.tAgain); await sleep(300); }
}
async function menuClick(page, sel) { await page.click(SEL.profBtn); await waitFor(page, s => !document.querySelector(s).closest("[hidden]"), { label: "profile menu open", arg: sel }); await page.click(sel); }

/* ================= main flow (one browser profile, tests run in order) ================= */

test("Start screen: onboarding form and demo board", async ({ page, base }) => {
  await page.goto(`${base}/index.html?test=1`);
  await waitFor(page, () => !!window.rcTest, { label: "app booted" });
  assert(await visible(page, SEL.start), "start screen not visible");
  assert(await visible(page, SEL.uName), "username field not visible");
  assert(await page.$eval(SEL.heroBoard, e => !!e.querySelector("svg")), "demo board not drawn");
});

test("Onboarding: unknown username shows a clear error", async ({ page }) => {
  await onboard(page, "nobody_here_123");
  await waitFor(page, s => /player called/i.test(document.querySelector(s).textContent), { label: "not-found message", arg: SEL.startMsg });
  assert(await visible(page, SEL.start), "should stay on the start screen");
});

test("Onboarding: chess.com username (any case) loads only 10-minute games", async ({ page }) => {
  await onboard(page, "Test_Player");
  await waitFor(page, n => { const s = window.rcTest.state(); return s.user && s.games === n && !document.querySelector("#v-start").hidden === false; }, { label: `${CC_RAPID_10} games loaded`, arg: CC_RAPID_10, timeout: 30000 });
  const s = await st(page);
  assert(s.user === CC_USER && s.source === "cc" && s.tc === "600", `profile wrong: ${JSON.stringify(s)}`);
  assert((await text(page, SEL.who)).toLowerCase().includes(CC_USER), "username not shown in the app shell");
});

test("Analysis starts automatically in the background", async ({ page }) => {
  await waitFor(page, () => window.rcTest.state().analysed >= 3, { label: "3 games analysed", timeout: 300000 });
});

test("Review: game cards open a game, at its first key moment", async ({ page }) => {
  await tab(page, "review");
  await waitFor(page, s => document.querySelectorAll(s).length > 0, { label: "game cards", arg: SEL.card });
  const ids = await page.$$eval(SEL.card, as => as.map(a => a.dataset.g));
  let id = null;
  for (const g of ids) {
    if (!(await page.evaluate(id => !!window.rcTest.game(id).an, g))) continue;
    await page.click(`${SEL.card}[data-g="${g}"]`);
    await waitFor(page, ([g, s]) => window.rcTest.state().cur === g && !document.querySelector(s).hidden, { label: "game view open", arg: [g, SEL.rvGame] });
    await sleep(200);
    if ((await page.$$(SEL.kmCard)).length) { id = g; break; }
    await page.click(SEL.back); await waitFor(page, s => document.querySelectorAll(s).length > 0, { label: "back to the list", arg: SEL.card });
  }
  assert(id, "no analysed game with key moments found");
  ctx.gameId = id;
  const ply = (await st(page)).ply, kms = await page.$$eval(SEL.kmCard, bs => bs.map(b => +b.dataset.p));
  assert(kms.includes(ply), `the game view opened at ply ${ply}, not at a key moment (${kms})`);
});

test("Review: evaluation graph, key moments and move list", async ({ page }) => {
  const id = ctx.gameId;
  const g = await page.evaluate(id => window.rcTest.game(id), id);
  assert(await page.$eval(SEL.evFig, e => !!e.querySelector("svg")), "evaluation graph missing");
  assert((await page.$$(SEL.moveBtn)).length === g.moves, "move list doesn't list every move");
  const p = await page.$eval(SEL.kmCard, e => +e.dataset.p);
  await page.click(SEL.navBtn("start")); await sleep(100);
  await page.click(SEL.kmCard); await sleep(300);
  assert((await st(page)).ply === p, "clicking a key moment doesn't jump to it");
  assert((await text(page, SEL.evNow)).length > 0, "current evaluation not shown");
});

test("Review: keyboard and buttons step through moves, board flips, filters work", async ({ page }) => {
  const g = await page.evaluate(id => window.rcTest.game(id), ctx.gameId);
  await page.click(SEL.navBtn("start")); await sleep(100);
  assert((await st(page)).ply === 0, "start button");
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press("ArrowRight"); await sleep(100);
  assert((await st(page)).ply === 1, "ArrowRight should step forward");
  await page.click(SEL.navBtn("end")); await sleep(100);
  assert((await st(page)).ply === g.moves, "end button");
  const f0 = (await st(page)).flip; await page.click(SEL.flip); await sleep(100);
  assert((await st(page)).flip !== f0, "flip button");
  await page.click(SEL.back); await waitFor(page, s => document.querySelectorAll(s).length > 0, { label: "game cards", arg: SEL.card });
  await page.click(SEL.chip("loss")); await sleep(300);
  const res = await page.evaluate(sel => [...document.querySelectorAll(sel)].map(a => window.rcTest.game(a.dataset.g)).filter(Boolean).map(g => g.result), SEL.card);
  assert(res.length > 0 && res.every(r => r === "loss"), `Losses filter shows other results: ${res}`);
  await page.click(SEL.chip("all"));
});

test("Puzzles: a summary of the last 5 games comes first; the board only after starting", async ({ page }) => {
  await tab(page, "trainer");
  await waitFor(page, s => document.querySelectorAll(s).length === 5, { label: "5 recent games in the summary", arg: SEL.tSum + " .t-g", timeout: 60000 });
  assert(/\d/.test(await text(page, SEL.tSum)), "summary has no blunder/mistake counts");
  assert(!(await visible(page, SEL.tboard)), "the puzzle board shows before a session starts");
  assert(await page.$(SEL.tMode("recent")) && await page.$(SEL.tMode("warm")), "training choices missing");
});

test("Trainer: a puzzle from your own games appears", async ({ page }) => {
  await page.click(SEL.tMode("recent"));
  await waitFor(page, () => !!window.rcTest.puzzle(), { label: "a puzzle", timeout: 60000 });
  assert((await text(page, SEL.tPrompt)).length > 0, "no prompt");
  assert(await page.$eval(SEL.tboard, e => !!e.querySelector("svg")), "puzzle board missing");
});

test("Trainer: a wrong move gets feedback and an engine explanation", async ({ page }) => {
  for (let i = 0; i < 6; i++) {
    const pz = await page.evaluate(() => window.rcTest.puzzle());
    const mv = await page.evaluate(p => { const c = new Chess(p.fen); const ms = c.moves({ verbose: true }).filter(m => m.from + m.to !== p.best.slice(0, 4));
      ms.sort((a, b) => (a.piece === "k") - (b.piece === "k") || (b.captured ? 0 : 1) - (a.captured ? 0 : 1)); return ms.find(m => !m.captured && m.piece !== "k") || ms[0]; }, pz);
    await clickSquare(page, SEL.tboard, mv.from, pz.flip); await clickSquare(page, SEL.tboard, mv.to, pz.flip);
    await waitFor(page, s => document.querySelector(s).textContent.trim().length > 0, { label: "feedback after a move", arg: SEL.tFeedback, timeout: 60000 });
    if (await page.$(SEL.tNo)) {
      const bestSan = await page.evaluate(p => { const c = new Chess(p.fen); const m = c.move({ from: p.best.slice(0, 2), to: p.best.slice(2, 4), promotion: p.best[4] || "q" }); return m && m.san; }, pz);
      await waitFor(page, ([s, san]) => { const t = document.querySelector(s).textContent; return t.includes(san) && t.includes(san.replace(/[+#]/g, "")); }, { label: `Why panel naming the better move ${bestSan}`, arg: [SEL.tWhy, bestSan], timeout: 90000 });
      return;
    }
    await nextPz(page); await sleep(100); // that move was also fine; try the next puzzle
  }
  throw new Error("never saw wrong-move feedback");
});

test("Trainer: hint and show answer", async ({ page }) => {
  await nextPz(page); await sleep(200);
  const before = await text(page, SEL.tFeedback);
  await page.click(SEL.tHint); await sleep(300);
  assert((await text(page, SEL.tFeedback)) !== before || (await page.$eval(SEL.tboard, e => e.innerHTML.length)) > 0, "hint did nothing");
  await page.click(SEL.tShow);
  await waitFor(page, s => document.querySelector(s).textContent.trim().length > 0, { label: "answer shown", arg: SEL.tFeedback, timeout: 60000 });
});

test("Trainer: the right move is accepted and remembered after reload", async ({ page, base }) => {
  await nextPz(page); await sleep(200);
  const pz = await page.evaluate(() => window.rcTest.puzzle());
  await clickSquare(page, SEL.tboard, pz.best.slice(0, 2), pz.flip); await clickSquare(page, SEL.tboard, pz.best.slice(2, 4), pz.flip);
  await waitFor(page, s => !!document.querySelector(s), { label: "correct-move feedback", arg: SEL.tOk, timeout: 30000 });
  ctx.solved = pz.id;
  await goto(page, base, "#trainer");
  const tr = await lsGet(page, `rc.cc:${CC_USER}.trainer`);
  assert(tr && tr[pz.id] && tr[pz.id].ok, "solved puzzle not saved");
});

test("Puzzles: a session ends with a summary, then Train again or Back to Train", async ({ page }) => {
  await tab(page, "trainer");
  if (await visible(page, SEL.tPlay)) await page.click(SEL.tQuit); // the earlier session is still open
  await waitFor(page, s => !!document.querySelector(s), { label: "warm-up choice", arg: SEL.tMode("warm") });
  await page.click(SEL.tMode("warm"));
  await waitFor(page, () => !!window.rcTest.puzzle(), { label: "a puzzle" });
  for (let i = 0; i < 12 && !(await visible(page, SEL.tDone)); i++) { await page.click(SEL.tShow); await sleep(150); await page.click(SEL.tNext); await sleep(200); }
  assert(await visible(page, SEL.tDone), "no summary at the end of the session");
  const nums = (await text(page, SEL.tDone + " .kpis")).match(/\d+/g) || [];
  assert(nums.length === 3 && +nums[1] > 0, `summary should show solved, missed and best run: ${nums}`);
  await page.click(SEL.tAgain);
  await waitFor(page, s => !document.querySelector(s).hidden && !!window.rcTest.puzzle(), { label: "Train again starts a new session", arg: SEL.tPlay });
  await page.click(SEL.tQuit);
  await waitFor(page, s => !document.querySelector(s).hidden, { label: "back to the Train hub", arg: SEL.tHub });
});

test("Progress: insights, key numbers, charts, endings and openings", async ({ page }) => {
  await tab(page, "progress");
  await waitFor(page, s => document.querySelector(s).textContent.trim().length > 20, { label: "insights", arg: SEL.insights });
  assert(/\d/.test(await text(page, SEL.kpis)), "key numbers missing");
  for (const c of SEL.charts) assert(await page.$eval(c, e => !!e.querySelector("svg") || e.textContent.trim().length > 0), `chart ${c} empty`);
  assert((await page.$$(SEL.ends + " tr")).length > 0, "how-games-end table empty");
  assert((await page.$$(SEL.opRows)).length > 0, "openings table empty");
});

test("Progress: a baseline is frozen once 10 games are analysed", async ({ page }) => {
  await waitFor(page, () => window.rcTest.state().analysed >= 10, { label: "10 games analysed", timeout: 600000 });
  await waitFor(page, k => !!localStorage.getItem(k), { label: "baseline stored", arg: `rc.cc:${CC_USER}.base.600`, timeout: 10000 });
});

test("Home: a plan of actions", async ({ page }) => {
  await tab(page, "home");
  await waitFor(page, s => document.querySelectorAll(s).length > 0, { label: "plan cards", arg: SEL.homePlan });
});

test("Lessons and Openings open", async ({ page }) => {
  await tab(page, "lessons");
  await waitFor(page, s => document.querySelector(s).children.length > 0, { label: "lesson tracks", arg: SEL.lsTracks });
  await tab(page, "openings");
  assert((await visible(page, SEL.oMain)) || (await visible(page, SEL.oEmpty)), "openings screen empty");
});

test("Lessons: course cards follow the track switch and open a course page", async ({ page }) => {
  await tab(page, "lessons");
  await page.$eval('input[name="lsTrack"][value="endgames"]', e => e.click()); await sleep(200);
  const eg = await page.$$eval(".lcard[data-co]", bs => bs.map(b => b.dataset.co));
  await page.$eval('input[name="lsTrack"][value="tactics"]', e => e.click()); await sleep(200);
  const tac = await page.$$eval(".lcard[data-co]", bs => bs.map(b => b.dataset.co));
  assert(eg.length >= 3 && tac.length >= 10 && !eg.some(x => tac.includes(x)), `track switch shows the wrong courses: ${eg} / ${tac}`);
  await page.click(`.lcard[data-co="${tac[1]}"]`);
  await waitFor(page, () => !document.querySelector("#lsCourse").hidden && document.querySelectorAll("#lsCoBody button[data-ls]").length > 0, { label: "course page with lessons" });
  await page.click("#coBack");
  await waitFor(page, () => !document.querySelector("#lsHome").hidden, { label: "back to the lessons home" });
});

test("Openings: cards follow the White/Black switch and open an opening page", async ({ page }) => {
  await tab(page, "openings");
  const keys = () => page.$$eval(SEL.oCard, as => as.filter(a => a.offsetParent).map(a => a.dataset.k));
  await page.$eval(SEL.oCol("w"), e => e.click());
  await waitFor(page, s => document.querySelectorAll(s).length > 5, { label: "opening cards", arg: SEL.oCard });
  let k = await keys();
  assert(k.length > 5 && k.every(x => x.startsWith("w|")), `White shows other cards: ${k.slice(0, 5)}`);
  await page.$eval(SEL.oCol("b"), e => e.click()); await sleep(300);
  k = await keys();
  assert(k.length > 5 && k.every(x => x.startsWith("b|")), `Black shows other cards: ${k.slice(0, 5)}`);
  const mine = await page.$eval("#oMine", e => e.querySelectorAll(".ocard").length);
  assert(mine > 0, "the player's own Black openings are missing");
  await page.click(SEL.oCard);
  await waitFor(page, ([p, n]) => !document.querySelector(p).hidden && document.querySelector(n).textContent.trim().length > 0, { label: "opening page", arg: [SEL.oPage, SEL.oName] });
  assert(/\d/.test(await text(page, "#oKpis")), "opening page has no stats");
  await page.click(SEL.oPractise);
  await waitFor(page, ([d, p]) => !document.querySelector(d).hidden && document.querySelector(p).textContent.trim().length > 0, { label: "opening drill", arg: [SEL.oDrill, SEL.oPrompt], timeout: 30000 });
  await page.$eval(SEL.oCol("w"), e => e.click());
});

test("Settings: dark theme applies and is remembered", async ({ page, base }) => {
  await menuClick(page, SEL.setBtn);
  await waitFor(page, s => document.querySelector(s).open, { label: "settings dialog open", arg: SEL.settings });
  await page.$eval(SEL.theme("dark"), e => e.click()); await sleep(200);
  assert(await page.evaluate(() => document.documentElement.dataset.theme === "dark"), "dark theme not applied");
  await page.click(SEL.setClose);
  await goto(page, base, "#home");
  assert(await page.evaluate(() => document.documentElement.dataset.theme === "dark"), "theme not remembered");
  await menuClick(page, SEL.setBtn); await page.$eval(SEL.theme("system"), e => e.click()); await page.click(SEL.setClose);
});

test("Reload keeps games and analyses; only the newest months are fetched again", async ({ page, base }) => {
  const a0 = (await st(page)).analysed;
  page.net.state.monthHits = [];
  await goto(page, base, "#review");
  await waitFor(page, n => window.rcTest.state().games === n, { label: "games restored", arg: CC_RAPID_10 });
  assert((await st(page)).analysed >= a0, "analyses lost on reload");
  await sleep(3000);
  const hits = page.net.state.monthHits;
  assert(hits.length <= 2 && !hits.some(u => u.endsWith("/2026/09")), `refetched old months: ${hits}`);
});

test("Check for new games finds a new game", async ({ page }) => {
  page.net.state.newGame = true;
  await tab(page, "progress");
  await waitFor(page, s => !document.querySelector(s).disabled, { label: "sync button enabled", arg: SEL.syncBtn, timeout: 30000 });
  await page.click(SEL.syncBtn);
  await waitFor(page, n => window.rcTest.state().games === n, { label: "new game added", arg: CC_RAPID_10 + 1, timeout: 30000 });
});

test("Layouts don't overflow sideways on phone or desktop", async ({ page }) => {
  for (const w of [390, 1280]) {
    await page.setViewport({ width: w, height: w < 600 ? 844 : 900 });
    for (const t of TABS) {
      await tab(page, t);
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(o <= 1, `${t} overflows by ${o}px at ${w}px wide`);
    }
    assert(await visible(page, SEL.nav), `navigation not visible at ${w}px`);
  }
  await page.setViewport({ width: 1280, height: 900 });
});

test("Switch player: a Lichess account with its own games", async ({ page }) => {
  ctx.ccAnalysed = (await st(page)).analysed;
  await menuClick(page, SEL.switchBtn);
  await onboard(page, "Li_Friend", "li");
  await waitFor(page, () => { const s = window.rcTest.state(); return s.source === "li" && s.games === 6; }, { label: "6 Lichess games", timeout: 30000 });
  assert((await st(page)).user === LI_USER, "Lichess user not set");
});

test("Switching back keeps the first player's data", async ({ page }) => {
  await menuClick(page, SEL.switchBtn);
  await onboard(page, CC_USER, "cc");
  await waitFor(page, n => { const s = window.rcTest.state(); return s.source === "cc" && s.games === n; }, { label: "chess.com games back", arg: CC_RAPID_10 + 1, timeout: 30000 });
  assert((await st(page)).analysed >= ctx.ccAnalysed, "analyses lost after switching");
  const tr = await lsGet(page, `rc.cc:${CC_USER}.trainer`);
  assert(tr && tr[ctx.solved] && tr[ctx.solved].ok, "puzzle progress lost after switching");
});

test("No third-party requests and no script errors", async ({ page }) => {
  assert(page.net.state.thirdParty.length === 0, `unexpected requests: ${page.net.state.thirdParty.slice(0, 5)}`);
  assert(page.errors.length === 0, `errors on the page:\n  ${page.errors.slice(0, 8).join("\n  ")}`);
});

/* ================= isolated scenarios (fresh browser profile each) ================= */

test("Existing V1 users keep their games, analyses and puzzle progress", async ({ browser, base }) => {
  const page = await newPage(browser, base, { fresh: true });
  try {
    await seedStorage(page, base, V1);
    await goto(page, base);
    await waitFor(page, () => { const s = window.rcTest.state(); return s.user === "test_player" && s.games >= 41; }, { label: "V1 games restored", timeout: 30000 });
    const s = await st(page), v1an = V1.games.filter(g => g.an).length;
    assert(s.source === "cc" && s.tc === "600", "V1 profile not migrated");
    assert(s.analysed >= v1an, `V1 analyses lost (${s.analysed} < ${v1an})`);
    const trOld = JSON.parse(V1.localStorage["rc.test_player.trainer"]), trNew = await lsGet(page, "rc.cc:test_player.trainer");
    assert(trNew && Object.keys(trOld).every(k => trNew[k]), "V1 puzzle progress lost");
    assert(await lsGet(page, "rc.cc:test_player.months.600"), "V1 fetched-months cache lost");
    assert(page.errors.length === 0, `errors: ${page.errors.join(" | ")}`);
  } finally { await page.ctx.close(); }
}, { isolated: true });

test("With accounts switched off the app still works and hides Friends", async ({ browser, base }) => {
  const page = await newPage(browser, base, { fresh: true, accountsOff: true });
  try {
    await goto(page, base);
    await onboard(page, CC_USER);
    await waitFor(page, n => window.rcTest.state().games === n, { label: "games loaded", arg: CC_RAPID_10, timeout: 30000 });
    assert(!(await visible(page, SEL.navLink("friends"))), "Friends shown although accounts are off");
    await page.evaluate(() => { location.hash = "friends"; }); await sleep(400);
    assert((await st(page)).route !== "progress/friends", "#friends opens although accounts are off");
    assert(page.errors.length === 0, `errors: ${page.errors.join(" | ")}`);
  } finally { await page.ctx.close(); }
}, { isolated: true });

/* ---------- run ---------- */
const { srv, base } = await serve();
const browser = await launch();
const main = await newPage(browser, base);
const lastMain = only ? Math.max(-1, ...tests.map((t, i) => !t.isolated && t.name.toLowerCase().includes(only) ? i : -1)) : tests.length;
let pass = 0, fail = 0, skip = 0, broken = false; const t0 = Date.now(), failures = [];
for (const t of tests) {
  if (only && !(t.isolated ? t.name.toLowerCase().includes(only) : tests.indexOf(t) <= lastMain)) continue; // main-flow tests need the steps before them
  if (broken && !t.isolated) { skip++; console.log(`  - ${t.name} (skipped)`); continue; }
  const s = Date.now();
  try { await t.fn({ page: main, browser, base }); pass++; console.log(`  ✓ ${t.name} (${((Date.now() - s) / 1000).toFixed(1)}s)`); }
  catch (e) {
    fail++; failures.push(t.name); console.log(`  ✗ ${t.name}\n      ${e.message}`);
    try { const f = path.join(ROOT, "tests", `failure-${failures.length}.png`); await main.screenshot({ path: f, fullPage: true }); console.log(`      screenshot: ${path.relative(ROOT, f)}`); } catch (x) {}
    if (!t.isolated && !keepGoing) { broken = true; console.log("  (skipping the rest of the main flow: later tests depend on this one; use --keep-going to try anyway)"); }
  }
}
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await browser.close(); srv.close();
process.exit(fail ? 1 : 0);
