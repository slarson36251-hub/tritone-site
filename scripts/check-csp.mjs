// Browser check for the Content-Security-Policy in firebase.json. Serves dist/ with the same
// headers Firebase applies (scripts/serve-with-headers.mjs), opens every built page in Chromium,
// exercises the interactive parts, and fails on any CSP violation (enforced or report-only).
//
//   npm run build && node scripts/check-csp.mjs
//
// Needs Playwright with Chromium, which is not a project dependency: `npm i --no-save playwright &&
// npx playwright install chromium`, or point PLAYWRIGHT_MODULE at an installed copy
// (e.g. PLAYWRIGHT_MODULE=/opt/node-tools/node_modules/playwright/index.js).
// Nothing leaves the machine: every off-site request is answered by a stub here. The booking and
// free-track Apps Script endpoints get fake JSON, so the real endpoints are never called.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, headersFor } from "./serve-with-headers.mjs";

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const chromium = pw.chromium ?? pw.default.chromium;
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

const pages = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) pages.push("/" + relative(DIST, p).replace(/\.html$/, "").replace(/^index$/, ""));
  }
})(DIST);
pages.sort();

const csp = headersFor("/")["Content-Security-Policy"] ?? headersFor("/")["Content-Security-Policy-Report-Only"];
if (!csp) throw new Error("no Content-Security-Policy in firebase.json for /");

// Fake availability: the next three days, 10:00-18:00.
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const AVAIL = { ok: true, tz: "America/Los_Angeles", days: [1, 2, 3].map((n) => ({ date: day(n), windows: [{ start: `${day(n)}T10:00`, end: `${day(n)}T18:00`, hours: 8 }] })) };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const offsite = [];

const server = await serve(0); // any free port
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: "block" });
await ctx.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    window.__csp.push(`${e.disposition} ${e.effectiveDirective} blocked ${e.blockedURI || "(inline)"} at ${e.sourceFile || location.pathname}:${e.lineNumber}`));
});
await ctx.route((url) => !url.href.startsWith(ORIGIN), async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  offsite.push(`${req.method()} ${u.origin}${u.pathname}`);
  if (/^script\.google(usercontent)?\.com$/.test(u.hostname)) {
    const body = req.method() === "POST" ? { ok: true, id: "TEST-0001", conflict: false } : AVAIL;
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  }
  if (req.resourceType() === "image") return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stub</title>" });
});

const violations = [];
const page = await ctx.newPage();
page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(`${page.url()} console: ${m.text()}`); });
page.on("pageerror", (e) => violations.push(`${page.url()} pageerror: ${e.message}`));

const collect = async (label) => {
  const v = await page.evaluate(() => { const v = window.__csp.splice(0); return v; }).catch(() => []);
  for (const x of v) violations.push(`${label}: ${x}`);
};
const tryStep = async (label, fn) => {
  try { await fn(); } catch (e) { violations.push(`${label}: step failed: ${e.message.split("\n")[0]}`); }
  await page.waitForTimeout(300);
  await collect(label);
};

for (const path of pages) {
  await page.goto(ORIGIN + path, { waitUntil: "networkidle" });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); // lazy images, reveal observers
  await page.waitForTimeout(300);
  await collect(path || "/");
}

// Player dock: open it (Spotify iframe), then a data-play button.
await page.goto(ORIGIN + "/", { waitUntil: "networkidle" });
await tryStep("dock", async () => {
  await page.click("#dock-toggle");
  await page.waitForSelector('#dock-slot iframe[src*="open.spotify.com"]', { state: "attached", timeout: 5000 });
});
await tryStep("dock data-play", async () => { const b = page.locator("[data-play]").first(); if (await b.count()) await b.click(); });

// Soft navigation through the ClientRouter (scripts re-run on swap), dock persists.
for (const href of ["/sessions", "/gallery", "/bands", "/shows", "/book-the-hut", "/"]) {
  await tryStep(`nav ${href}`, async () => {
    const link = page.locator(`header a[href="${href}"]`).first();
    if (await link.count()) await link.click(); else await page.goto(ORIGIN + href);
    await page.waitForLoadState("networkidle");
  });
}

// Band page track list (same-origin audio).
const band = pages.find((p) => p.startsWith("/bands/"));
if (band) {
  await page.goto(ORIGIN + band, { waitUntil: "networkidle" });
  await tryStep("tracklist", async () => { const b = page.locator("[data-tracklist] button").first(); if (await b.count()) await b.click(); });
}

// Gallery lightbox.
await page.goto(ORIGIN + "/gallery", { waitUntil: "networkidle" });
await tryStep("lightbox open", async () => { await page.click(".g-open"); await page.waitForSelector("#lightbox[open]", { timeout: 5000 }); });
await tryStep("lightbox next", () => page.click("#lb-next"));
await tryStep("lightbox close", () => page.click("#lb-close"));

const src = (p) => readFileSync(join(DIST, (p === "/" ? "index" : p.slice(1)) + ".html"), "utf8");

// Sessions: tape tabs (if any), then a click-to-load YouTube card on the first page that has one.
await page.goto(ORIGIN + "/sessions", { waitUntil: "networkidle" });
await tryStep("sessions tab", async () => { const t = page.locator("#hh-s .tape").nth(1); if (await t.count()) await t.click(); });
for (const ytPage of pages.filter((p) => /<a[^>]*class="yt\b/.test(src(p)))) {
  await page.goto(ORIGIN + ytPage, { waitUntil: "networkidle" });
  const a = page.locator("a.yt:visible").first();
  if (!(await a.count())) continue;
  await tryStep(`youtube on ${ytPage}`, async () => {
    await a.click();
    await page.waitForSelector('iframe[src*="youtube-nocookie.com"]', { state: "attached", timeout: 5000 });
  });
  break;
}

// SoundCloud click-to-load players.
const scPage = pages.find((p) => /data-sc-src=/.test(src(p)));
if (scPage) {
  await page.goto(ORIGIN + scPage, { waitUntil: "networkidle" });
  await tryStep(`soundcloud on ${scPage}`, async () => {
    await page.locator("[data-sc-src]").first().click();
    await page.waitForSelector('iframe[src*="w.soundcloud.com"]', { state: "attached", timeout: 5000 });
  });
}

// Shows: add-to-calendar links stay links; download the .ics.
const show = pages.find((p) => p.startsWith("/shows/"));
if (show) {
  await page.goto(ORIGIN + show, { waitUntil: "networkidle" });
  await tryStep("add to calendar (.ics)", async () => {
    const a = page.locator('a[href$=".ics"]').first();
    if (await a.count()) { const dl = page.waitForEvent("download", { timeout: 5000 }); await a.click(); await dl; }
  });
}

// Booking form against the stubbed Apps Script.
await page.goto(ORIGIN + "/book-the-hut", { waitUntil: "networkidle" });
await tryStep("booking", async () => {
  await page.locator("#hbh-days button:not([disabled])").first().click();
  await page.locator("#hbh-times button:not([disabled])").first().click();
  await page.fill("#hbh-name", "CSP Test");
  await page.fill("#hbh-email", "csp-test@example.com");
  await page.fill("#hbh-phone", "510-555-0100");
  await page.fill("#hbh-project", "CSP check");
  await page.fill("#hbh-num", "3");
  await page.waitForTimeout(3200); // past the 3-second bot trap
  await page.click("#hbh-submit");
  await page.waitForSelector("#hbh-done:not([hidden])", { timeout: 5000 });
});

// Free-track form against the stubbed Apps Script.
await page.goto(ORIGIN + "/free-track", { waitUntil: "networkidle" });
await tryStep("free track", async () => {
  await page.fill("#ft-first", "CSP");
  await page.fill("#ft-last", "Test");
  await page.fill("#ft-email", "csp-test@example.com");
  await page.waitForTimeout(3200);
  await page.click("#ft-submit");
  await page.waitForSelector("[data-screen=tip]:not([hidden])", { timeout: 5000 });
});

// Upload landing with a valid link (button only, nothing followed).
await page.goto(ORIGIN + "/upload?s=" + encodeURIComponent("https://example.quickconnect.to/sharing/abc") + "&n=Test", { waitUntil: "networkidle" });
await collect("upload");

await browser.close();
server.close();

console.log(`CSP: ${csp}\n`);
console.log(`${pages.length} pages checked. Off-site requests (stubbed):`);
for (const o of [...new Set(offsite.map((x) => x.replace(/(\/\/[^/]+).*/, "$1")))].sort()) console.log("  " + o);
if (violations.length) {
  console.error(`\n${violations.length} problem(s):`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("\nNo CSP violations.");
