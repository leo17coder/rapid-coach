// Accessibility sweep: node tests/tools/a11y.mjs. Lists, per screen at 390 and 1440 px, visible text under 14 px, controls under 44 px tall
// (text links inside sentences excepted) and buttons or links without a name. Runs offline against the test fixtures.
import { serve, launch, newPage, waitFor, sleep } from "../lib.mjs";
const { srv, base } = await serve(), browser = await launch(), page = await newPage(browser, base, { fresh: true });
await page.goto(`${base}/index.html?test=1`); await waitFor(page, () => !!window.rcTest);
const audit = async (name) => page.evaluate((name) => {
  const out = { small: new Set(), tiny: new Set(), unlabeled: new Set() };
  const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !e.closest("[hidden]"); };
  const desc = e => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : "")) + " «" + (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 30) + "»";
  for (const e of document.querySelectorAll("body *")) {
    if (!vis(e) || e.closest("svg")) continue;
    const t = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (t && parseFloat(getComputedStyle(e).fontSize) < 13.9) out.small.add(desc(e) + " " + getComputedStyle(e).fontSize);
  }
  for (const e of document.querySelectorAll("button, a[href], input, select, summary, [role=radio], [role=switch]")) {
    if (!vis(e) && !(e.matches("input") && vis(e.parentElement))) continue;
    const el = e.matches(".seg input, .switch input") ? e.parentElement : e, r = el.getBoundingClientRect();
    const inline = e.matches("a") && getComputedStyle(e).display === "inline" && e.closest("p, li, span.small, .small");
    if (!inline && r.height < 43.5 && r.height > 0) out.tiny.add(desc(e) + " " + Math.round(r.width) + "x" + Math.round(r.height));
    if ((e.matches("button, a") && !(e.textContent.trim() || e.getAttribute("aria-label") || e.getAttribute("title")))) out.unlabeled.add(desc(e));
  }
  return { name, small: [...out.small].slice(0, 12), tiny: [...out.tiny].slice(0, 25), unlabeled: [...out.unlabeled].slice(0, 10) };
}, name);
for (const w of [390, 1440]) { await page.setViewport({ width: w, height: 900 }); await sleep(300); console.log(JSON.stringify(await audit("start-" + w), null, 0)); }
await page.$eval("#uSrcCc", e => { e.checked = true; e.dispatchEvent(new Event("change", { bubbles: true })); });
await page.type("#uName", "test_player"); await page.click("#startBtn");
await waitFor(page, () => window.rcTest.state().analysed >= 6, { timeout: 600000 });
for (const r of ["home", "review", "train/puzzles", "train/openings", "train/lessons", "progress", "progress/trophies"]) for (const w of [390, 1440]) {
  await page.setViewport({ width: w, height: 900 }); await page.evaluate(h => { location.hash = h; }, r); await sleep(900);
  if (r === "progress") await page.$eval("#pMore", e => e.open = true);
  console.log(JSON.stringify(await audit(r + "-" + w)));
}
await page.evaluate(() => { location.hash = "review"; }); await sleep(600); await page.evaluate(() => { const a = [...document.querySelectorAll(".gcard-link[data-g]")].find(a => window.rcTest.game(a.dataset.g).an); a && a.click(); }); await sleep(900); console.log(JSON.stringify(await audit("game-1440")));
await browser.close(); srv.close();
