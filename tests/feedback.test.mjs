// Scott's beta-site feedback overlay: the host + ?feedback gate, the Firestore document shape
// (must satisfy firestore.rules), and the overlay staying out of every page's initial load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { feedbackHostAllowed, feedbackParam, feedbackDoc, FEEDBACK_ENDPOINT } = await import("../src/lib/feedback-gate.ts");
const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("the overlay is allowed only on the beta host and its preview channels", () => {
  for (const h of ["tritone-site.web.app", "TRITONE-SITE.web.app", "tritone-site--pr12-feedback-a1b2c3.web.app"])
    assert.equal(feedbackHostAllowed(h), true, h);
  for (const h of [
    "tritone-productions.com", "www.tritone-productions.com", "tritone-site.firebaseapp.com",
    "localhost", "127.0.0.1", "evil-tritone-site.web.app", "tritone-site.web.app.evil.com",
    "tritone-site--x.web.app.evil.com", "tritone-site--.web.app", "other.web.app", "",
  ])
    assert.equal(feedbackHostAllowed(h), false, h);
});

test("?feedback=on / off is read, anything else leaves the flag alone", () => {
  assert.equal(feedbackParam("?feedback=on"), "on");
  assert.equal(feedbackParam("?x=1&feedback=OFF"), "off");
  assert.equal(feedbackParam("?feedback=yes"), null);
  assert.equal(feedbackParam(""), null);
});

test("the Firestore document fits firestore.rules", () => {
  const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");
  const keys = JSON.parse(rules.match(/hasOnly\((\[[^\]]+\])\)/)[1].replace(/'/g, '"'));
  const limits = Object.fromEntries([...rules.matchAll(/data\.(\w+)\.size\(\) < (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const long = "x".repeat(20000);
  const doc = feedbackDoc({ page: long, selector: long, snippet: long, note: `  ${long}  `, viewport: long, createdAt: long, ua: long });
  assert.deepEqual(Object.keys(doc.fields).sort(), [...keys].sort());
  for (const [k, v] of Object.entries(doc.fields)) {
    assert.deepEqual(Object.keys(v), ["stringValue"], k);
    assert.ok(v.stringValue.length < limits[k], `${k}: ${v.stringValue.length} < ${limits[k]}`);
  }
  assert.equal(feedbackDoc({ page: "/", selector: "", snippet: "", note: "  hi  ", viewport: "1x1", createdAt: "t", ua: "u" }).fields.note.stringValue, "hi");
  assert.equal(FEEDBACK_ENDPOINT, "https://firestore.googleapis.com/v1/projects/tritone-site/databases/(default)/documents/feedback");
});

// ---- dist/ ----
const DIST = join(ROOT, "dist");
const built = existsSync(join(DIST, "index.html"));
const astro = built ? readdirSync(join(DIST, "_astro")).filter((f) => f.endsWith(".js")) : [];
const read = (f) => readFileSync(join(DIST, "_astro", f), "utf8");

test("the overlay is a separate chunk that no page loads up front", { skip: !built && "dist/ not built" }, () => {
  const overlay = astro.filter((f) => read(f).includes("fb-launch"));
  assert.equal(overlay.length, 1, `one overlay chunk (${overlay.join(", ")})`);
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  assert.ok(!html.includes(overlay[0]) && !html.includes("fb-launch"), "index.html does not reference the overlay");
  // The gate itself ships, and still names only the beta host.
  const gate = astro.filter((f) => f !== overlay[0] && read(f).includes("tritone-site.web.app"));
  assert.ok(gate.length >= 1, "gate is bundled");
  for (const f of gate) assert.ok(!read(f).includes("localhost"), `${f}: no localhost allowance in a production build`);
});
