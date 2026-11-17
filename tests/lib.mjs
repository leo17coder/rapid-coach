// Test harness: static server, headless Chrome, a fake chess.com / Lichess network, small helpers.
// No test framework on purpose: plain Node + puppeteer-core, so it runs anywhere Chrome is installed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FX = path.join(ROOT, "tests", "fixtures");
export const CC = JSON.parse(fs.readFileSync(path.join(FX, "chesscom.json"), "utf8"));
export const LI_NDJSON = fs.readFileSync(path.join(FX, "lichess.ndjson"), "utf8");
export const CC_USER = CC.player;        // "test_player"
export const LI_USER = "li_friend";
export const CC_RAPID_10 = Object.values(CC.months).flatMap(m => m.games).filter(g => g.time_control === "600").length; // 10-minute games in the fixture

/* ---------- static server ---------- */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".woff2": "font/woff2", ".png": "image/png", ".txt": "text/plain" };
export function serve(root = ROOT) {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/__blank") { rsp.writeHead(200, { "Content-Type": "text/html" }); return rsp.end("<!DOCTYPE html><title>blank</title>"); }
      let p = path.join(root, decodeURIComponent(u.pathname));
      if (!p.startsWith(root)) { rsp.writeHead(403); return rsp.end(); }
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
      fs.readFile(p, (err, data) => {
        if (err) { rsp.writeHead(404); return rsp.end("not found"); }
        rsp.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
        rsp.end(data);
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

/* ---------- Chrome ---------- */
function findChrome() {
  const c = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"];
  const pw = path.join(process.env.HOME || "", ".cache", "ms-playwright");
  if (fs.existsSync(pw)) for (const d of fs.readdirSync(pw).filter(d => d.startsWith("chromium")).sort().reverse())
    for (const s of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) c.push(path.join(pw, d, s));
  const f = c.find(p => p && fs.existsSync(p));
  if (!f) throw new Error("No Chrome/Chromium found. Install one or set CHROME_PATH.");
  return f;
}
export const launch = () => puppeteer.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

/* ---------- fake network ----------
   net.state: { newGame: bool (append CC.newGame to the newest month), accountsOff: bool, monthHits: [urls], thirdParty: [urls] } */
const ALLOWED = [/^https:\/\/api\.chess\.com\//, /^https:\/\/lichess\.org\//, /^https:\/\/explorer\.lichess\.org\//, /^https:\/\/[a-z0-9]+\.supabase\.co\//];
export async function attach(page, base, net) {
  await page.setRequestInterception(true);
  page.on("request", r => {
    const u = r.url(), H = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    const json = (b, s = 200) => r.respond({ status: s, contentType: "application/json", headers: H, body: JSON.stringify(b) });
    if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: H });
    if (u.startsWith(base)) {
      if (net.state.accountsOff && /\/config\.js(\?|$)/.test(new URL(u).pathname + new URL(u).search))
        return r.respond({ status: 200, contentType: "text/javascript", body: 'window.RC_CONFIG={supabaseUrl:"",supabaseKey:""};' });
      return r.continue();
    }
    let m;
    if ((m = u.match(/^https:\/\/api\.chess\.com\/pub\/player\/([^/?]+)\/games\/archives/))) {
      if (decodeURIComponent(m[1]).toLowerCase() !== CC_USER) return json({ archives: [] });
      return json({ archives: Object.keys(CC.months).sort().map(k => `https://api.chess.com/pub/player/${CC_USER}/games/${k.replace("-", "/")}`) });
    }
    if ((m = u.match(/^https:\/\/api\.chess\.com\/pub\/player\/([^/?]+)\/games\/(\d{4})\/(\d{2})$/))) {
      net.state.monthHits.push(u);
      const k = `${m[2]}-${m[3]}`, newest = Object.keys(CC.months).sort().pop();
      const games = (CC.months[k] || { games: [] }).games.slice();
      if (net.state.newGame && k === newest) games.push(CC.newGame);
      return json({ games });
    }
    if ((m = u.match(/^https:\/\/api\.chess\.com\/pub\/player\/([^/?]+)$/)))
      return decodeURIComponent(m[1]).toLowerCase() === CC_USER ? json({ username: CC_USER, player_id: 1 }) : json({ code: 0, message: "not found" }, 404);
    if ((m = u.match(/^https:\/\/lichess\.org\/api\/user\/([^/?]+)$/)))
      return decodeURIComponent(m[1]).toLowerCase() === LI_USER ? json({ id: LI_USER, username: "Li_Friend", perfs: { rapid: { games: 6 } } }) : json({ error: "Not found" }, 404);
    if ((m = u.match(/^https:\/\/lichess\.org\/api\/games\/user\/([^/?]+)\?(.*)$/))) {
      if (decodeURIComponent(m[1]).toLowerCase() !== LI_USER) return r.respond({ status: 404, headers: H, body: "" });
      const since = +new URLSearchParams(m[2]).get("since") || 0;
      const body = LI_NDJSON.trim().split("\n").filter(l => JSON.parse(l).createdAt >= since).join("\n") + "\n";
      return r.respond({ status: 200, contentType: "application/x-ndjson", headers: H, body });
    }
    if (ALLOWED.some(a => a.test(u))) return r.abort("internetdisconnected"); // explorer, Supabase: behave as offline
    net.state.thirdParty.push(u);
    return r.abort("blockedbyclient");
  });
}

/* ---------- page with error capture ---------- */
export async function newPage(browser, base, opts = {}) {
  const ctx = opts.fresh ? await browser.createBrowserContext() : browser.defaultBrowserContext();
  const page = await ctx.newPage();
  const net = { state: { newGame: false, accountsOff: !!opts.accountsOff, monthHits: [], thirdParty: [] } };
  page.errors = [];
  page.on("pageerror", e => page.errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR_/.test(m.text())) page.errors.push("console: " + m.text()); });
  await attach(page, base, net);
  await page.setViewport({ width: 1280, height: 900 });
  page.net = net;
  page.ctx = ctx;
  return page;
}

/* ---------- helpers ---------- */
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(page, fn, { timeout = 20000, label = "condition", arg } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await page.evaluate(fn, arg); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out after ${timeout / 1000}s waiting for: ${label}`);
    await sleep(250);
  }
}
export const st = page => page.evaluate(() => window.rcTest && window.rcTest.state());
export const text = (page, sel) => page.$eval(sel, e => e.innerText.trim()).catch(() => "");
export const visible = (page, sel) => page.$eval(sel, e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return !e.closest("[hidden]") && s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; }).catch(() => false);
export async function goto(page, base, hash = "") { await page.goto(`${base}/index.html?test=1${hash}`, { waitUntil: "load" }); await waitFor(page, () => !!window.rcTest, { label: "app booted (window.rcTest)" }); }
export async function tab(page, name) { await page.evaluate(n => { location.hash = n; }, name); await waitFor(page, n => window.rcTest.state().route === n || !document.querySelector("#v-start").hidden, { label: `tab ${name}`, arg: name }); await sleep(300); }
/** Click a square on a board element; uses rcTest to know the orientation. */
export async function clickSquare(page, boardSel, sq, flip) {
  const r = await page.$eval(boardSel, e => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
  let f = "abcdefgh".indexOf(sq[0]), k = 8 - +sq[1]; if (flip) { f = 7 - f; k = 7 - k; }
  await page.mouse.click(r.x + (f + 0.5) * r.w / 8, r.y + (k + 0.5) * r.h / 8);
  await sleep(150);
}
/** Seed storage exactly like an older version left it, then load the app. snap = {localStorage:{k:v}, games:[...], idbVersion} */
export async function seedStorage(page, base, snap) {
  await page.goto(`${base}/__blank`);
  await page.evaluate(async s => {
    localStorage.clear();
    for (const [k, v] of Object.entries(s.localStorage)) localStorage.setItem(k, v);
    await new Promise((res, rej) => { const d = indexedDB.deleteDatabase("rapid-coach"); d.onsuccess = d.onerror = d.onblocked = () => res(); });
    await new Promise((res, rej) => {
      const r = indexedDB.open("rapid-coach", s.idbVersion);
      r.onupgradeneeded = () => r.result.createObjectStore("games", { keyPath: "id" });
      r.onsuccess = () => { const db = r.result, tx = db.transaction("games", "readwrite"); s.games.forEach(g => tx.objectStore("games").put(g)); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = rej; };
      r.onerror = rej;
    });
  }, snap);
}
