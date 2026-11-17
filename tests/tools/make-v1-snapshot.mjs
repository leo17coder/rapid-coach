// One-off: rebuilds tests/fixtures/v1-storage.json, the browser storage a V1 user had (commit 607d3e6).
// Usage: git worktree add /tmp/v1 607d3e6 && node tests/tools/make-v1-snapshot.mjs /tmp/v1
import fs from "node:fs";
import path from "node:path";
import { serve, launch, newPage, sleep, ROOT } from "../lib.mjs";
const v1 = process.argv[2]; if (!v1) throw new Error("pass the V1 checkout folder");
const { srv, base } = await serve(path.resolve(v1)), browser = await launch(), page = await newPage(browser, base);
await page.goto(base + "/index.html");
await page.waitForSelector("#uName", { visible: true });
await page.type("#uName", "Test_Player"); await page.click("#startBtn");
const n = async () => page.$$eval("#gamePick option", o => o.filter(x => !/not analysed/.test(x.textContent)).length);
for (let t = 0; (await n()) < 6; t++) { if (t > 600) throw new Error("V1 analysis too slow"); await sleep(500); }
await page.evaluate(() => { location.hash = "trainer"; }); await sleep(1500);
await page.click("#tShow"); await sleep(300); await page.click("#tNext"); await sleep(500);
await page.evaluate(() => { location.hash = "review"; }); await sleep(500);
await page.evaluate(() => new Promise(r => { location.reload(); r(); })); await sleep(3000); // let V1 flush its last writes
const snap = await page.evaluate(async () => {
  const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("rc.")) ls[k] = localStorage.getItem(k); }
  const games = await new Promise(res => { const r = indexedDB.open("rapid-coach"); r.onsuccess = () => { const q = r.result.transaction("games").objectStore("games").getAll(); q.onsuccess = () => { res(q.result); r.result.close(); }; }; });
  return { note: "Browser storage left by Rapid Coach V1 (commit 607d3e6) for chess.com user test_player. Rebuild with tests/tools/make-v1-snapshot.mjs.", idbVersion: 1, localStorage: ls, games: games.map(({ _f, _m, ...g }) => g) };
});
fs.writeFileSync(path.join(ROOT, "tests/fixtures/v1-storage.json"), JSON.stringify(snap));
console.log("keys", Object.keys(snap.localStorage), "games", snap.games.length, "analysed", snap.games.filter(g => g.an).length, "errors", page.errors);
await browser.close(); srv.close();
