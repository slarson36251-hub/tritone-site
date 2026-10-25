// Security headers in firebase.json, and the built site staying inside its Content-Security-Policy.
// The browser check (every page, dock, booking, lightbox, sessions) is scripts/check-csp.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const hosting = JSON.parse(readFileSync(join(ROOT, "firebase.json"), "utf8")).hosting;
const all = hosting.headers.find((h) => h.source === "**");
const header = (k) => all?.headers.find((h) => h.key.toLowerCase() === k.toLowerCase())?.value;
const csp = Object.fromEntries(
  (header("Content-Security-Policy") ?? "").split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]),
);

test('firebase.json sets the security headers on "**"', () => {
  assert.ok(all, 'a "**" headers rule');
  assert.equal(header("Strict-Transport-Security"), "max-age=31536000; includeSubDomains");
  assert.equal(header("X-Content-Type-Options"), "nosniff");
  assert.equal(header("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(header("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(header("Cross-Origin-Opener-Policy"), "same-origin-allow-popups");
  for (const f of ["camera=()", "microphone=()", "geolocation=()", "interest-cohort=()"])
    assert.ok(header("Permissions-Policy")?.includes(f), `Permissions-Policy has ${f}`);
  assert.ok(header("Content-Security-Policy"), "an enforced Content-Security-Policy");
  assert.equal(header("Content-Security-Policy-Report-Only"), undefined, "no leftover report-only policy");
});

test("the security rule sits alongside the asset cache rule", () => {
  assert.ok(hosting.headers.some((h) => h.source === "/_astro/**"), "/_astro/** cache rule");
});

test("the CSP has no wildcard sources and no unsafe script sources", () => {
  for (const [dir, sources] of Object.entries(csp)) {
    for (const s of sources) {
      assert.ok(!s.includes("*"), `${dir}: wildcard source ${s}`);
      assert.ok(!/^(https?:|data:|blob:)$/.test(s), `${dir}: bare scheme source ${s}`);
    }
  }
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.ok(csp["script-src"], "script-src");
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "data:"]) assert.ok(!csp["script-src"].includes(bad), `script-src without ${bad}`);
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["base-uri"], ["'self'"]);
  assert.deepEqual(csp["frame-ancestors"], ["'self'"]);
  assert.ok(csp["form-action"], "form-action");
});

// ---- dist/ checks (CI builds before npm test) ----
const DIST = join(ROOT, "dist");
const built = existsSync(join(DIST, "index.html"));
const files = [];
if (built) (function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(html|js)$/.test(e.name)) files.push(p);
  }
})(DIST);
const html = files.filter((f) => f.endsWith(".html")).map((f) => [f.slice(DIST.length), readFileSync(f, "utf8")]);
const js = files.filter((f) => f.endsWith(".js")).map((f) => [f.slice(DIST.length), readFileSync(f, "utf8")]);
const allows = (dir, origin) => (csp[dir] ?? csp["default-src"]).includes(origin);

test("built pages carry no inline script code or inline event handlers", { skip: !built && "dist/ not built" }, () => {
  for (const [f, h] of html) {
    for (const m of h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=/.test(m[1]) || !m[2].trim()) continue;
      const type = m[1].match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "";
      assert.match(type, /^application\/(ld\+)?json$/i, `${f}: inline <script${m[1]}> would be blocked by script-src 'self'`);
    }
    assert.doesNotMatch(h, /<[a-z][^>]*\son[a-z]+\s*=/i, `${f}: inline on*= handler`);
    assert.doesNotMatch(h, /href\s*=\s*["']\s*javascript:/i, `${f}: javascript: URL`);
  }
});

test("every off-site script, image and frame in dist/ is allowed by the CSP", { skip: !built && "dist/ not built" }, () => {
  const tags = { script: "script-src", img: "img-src", iframe: "frame-src", audio: "media-src", video: "media-src", source: "media-src" };
  for (const [f, h] of html) {
    for (const m of h.matchAll(/<(script|img|iframe|audio|video|source)\b[^>]*?\s(?:src|srcset)\s*=\s*"(https?:\/\/[^/"\s]+)/gi))
      assert.ok(allows(tags[m[1].toLowerCase()], new URL(m[2]).origin), `${f}: <${m[1]}> from ${m[2]} not in ${tags[m[1].toLowerCase()]}`);
  }
  // Endpoints the page scripts fetch, and iframes they create.
  for (const [f, s] of [...js, ...html]) {
    for (const m of s.matchAll(/https:\/\/script\.google\.com\/macros\/[^"'`\s]+/g))
      assert.ok(allows("connect-src", "https://script.google.com"), `${f}: fetches ${m[0]}`);
    if (s.includes("https://firestore.googleapis.com/"))
      assert.ok(allows("connect-src", "https://firestore.googleapis.com"), `${f}: fetches Firestore`);
    for (const m of s.matchAll(/https:\/\/(open\.spotify\.com|www\.youtube-nocookie\.com|w\.soundcloud\.com)\/embed/g))
      assert.ok(allows("frame-src", `https://${m[1]}`), `${f}: embeds ${m[1]}`);
  }
});
