// Screenshots for design review: node tests/tools/screens.mjs <outDir> [route ...]
// Onboards the fixture player against the fake network, waits for some analysis, then captures each route at 390 px and
// 1440 px wide, in dark and light. Routes default to the four tabs and their sections.
import fs from "node:fs";
import path from "node:path";
import { serve, launch, newPage, waitFor, sleep, goto } from "../lib.mjs";
const out = process.argv[2] || "screens", routes = process.argv.slice(3).length ? process.argv.slice(3) : ["home", "review", "train/puzzles", "train/openings", "train/lessons", "progress"];
fs.mkdirSync(out, { recursive: true });
const { srv, base } = await serve(), browser = await launch(), page = await newPage(browser, base, { fresh: true });
await page.goto(`${base}/index.html?test=1`); await waitFor(page, () => !!window.rcTest);
const shot = async (name, w, theme) => {
  await page.setViewport({ width: w, height: w < 600 ? 844 : 900, deviceScaleFactor: 1 });
  await page.evaluate(t => { const u = JSON.parse(localStorage.getItem("rc.ui") || "{}"); u.theme = t; u.v3 = 1; localStorage.setItem("rc.ui", JSON.stringify(u)); document.documentElement.dataset.theme = t; }, theme);
  await sleep(500);
  // grow the viewport to the page height so fixed bars (the phone tab bar) sit at the bottom, not mid-page
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewport({ width: w, height: Math.min(h, 12000), deviceScaleFactor: 1 }); await sleep(300);
  await page.screenshot({ path: path.join(out, `${name.replace(/\//g, "-")}-${w}-${theme}.png`) });
};
for (const t of ["dark"]) for (const w of [390, 1440]) await shot("start", w, t);
await page.$eval("#uSrcCc", e => { e.checked = true; e.dispatchEvent(new Event("change", { bubbles: true })); });
await page.type("#uName", "test_player"); await page.click("#startBtn");
await waitFor(page, () => window.rcTest.state().analysed >= 10, { timeout: 600000, label: "analysis" });
await sleep(1500);
for (const r of routes) {
  await page.evaluate(h => { location.hash = h; }, r); await sleep(1200);
  for (const t of ["dark", "light"]) for (const w of [390, 1440]) await shot(r, w, t);
}
await browser.close(); srv.close();
console.log("saved to", out);
