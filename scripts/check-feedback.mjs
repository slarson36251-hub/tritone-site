// Browser check for Scott's beta-site feedback overlay (src/lib/feedback-overlay.ts).
// Serves dist/ with the firebase.json headers, and answers requests for the real hostnames
// (tritone-site.web.app, a preview channel, tritone-productions.com) from that local server,
// so the hostname gate is exercised exactly as deployed. Firestore is intercepted: nothing
// leaves the machine. At 390px (touch) and 1366px it checks: off by default and on the public
// domain, on after ?feedback=on and across navigations, picking without navigating, voice
// (a stand-in SpeechRecognition) into the textarea, the exact Firestore request, a failed send
// keeping the note, whole-page notes, Esc, ?feedback=off, and no speech API (Firefox).
//
//   PUBLIC_FEEDBACK_API_KEY=test-key npm run build && node scripts/check-feedback.mjs [shots-dir]
//   npm run build && FEEDBACK_EXPECT=unconfigured node scripts/check-feedback.mjs
//
// Needs Playwright with Chromium (not a project dependency), as scripts/check-csp.mjs does.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { serve } from "./serve-with-headers.mjs";

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const chromium = pw.chromium ?? pw.default.chromium;
const SHOTS = process.argv[2];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const UNCONFIGURED = process.env.FEEDBACK_EXPECT === "unconfigured";

const server = await serve(0);
const LOCAL = `http://127.0.0.1:${server.address().port}`;
const BETA = "https://tritone-site.web.app";
const PREVIEW = "https://tritone-site--pr7-feedback-x1y2z3.web.app";
const PUBLIC = "https://tritone-productions.com";
const FIRESTORE = "https://firestore.googleapis.com/v1/projects/tritone-site/databases/(default)/documents/feedback";

const FAKE_SPEECH = () => {
  class FakeSpeech extends EventTarget {
    start() {
      this.t = setTimeout(() => {
        const results = [Object.assign([{ transcript: "the headline should be bigger" }], { isFinal: true })];
        this.dispatchEvent(Object.assign(new Event("result"), { results, resultIndex: 0 }));
      }, 150);
    }
    stop() { clearTimeout(this.t); setTimeout(() => this.dispatchEvent(new Event("end")), 10); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSpeech;
};
const NO_SPEECH = () => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; };

async function newContext(browser, vp, { speech = true } = {}) {
  const mobile = vp.width < 500;
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(speech ? FAKE_SPEECH : NO_SPEECH);
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const log = { firestore: [], overlayChunk: 0, reply: { status: 200, body: { name: "projects/tritone-site/databases/(default)/documents/feedback/abc" } } };
  await ctx.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if ([BETA, PREVIEW, PUBLIC].includes(url.origin)) {
      if (url.pathname.includes("feedback-overlay")) log.overlayChunk++;
      const res = await route.fetch({ url: LOCAL + url.pathname + url.search, maxRedirects: 0 });
      return route.fulfill({ response: res });
    }
    if (url.href.startsWith(FIRESTORE)) {
      log.firestore.push({ url: url.href, method: route.request().method(), body: route.request().postDataJSON() });
      return route.fulfill({ status: log.reply.status, contentType: "application/json", body: JSON.stringify(log.reply.body) });
    }
    return route.fulfill({ status: 204, body: "" }); // any other off-site request
  });
  return { ctx, log };
}

const shot = (page, name) => SHOTS && page.screenshot({ path: join(SHOTS, `${name}.png`) });
const settle = (page) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(150));

const browser = await chromium.launch();
const results = [];
try {
  for (const vp of [{ width: 390, height: 844 }, { width: 1366, height: 900 }]) {
    const tag = `${vp.width}`;
    const touch = vp.width < 500;
    const { ctx, log } = await newContext(browser, vp);
    const page = await ctx.newPage();
    const press = (loc) => (touch ? loc.tap() : loc.click());

    // 1. Public domain: never, even with ?feedback=on.
    await page.goto(`${PUBLIC}/?feedback=on`);
    await settle(page);
    assert.equal(await page.locator("#fb-root").count(), 0, "no overlay on tritone-productions.com");
    assert.equal(log.overlayChunk, 0, "overlay chunk never requested on tritone-productions.com");
    assert.equal(await page.evaluate(() => localStorage.getItem("tritone:feedback")), null, "no flag stored on the public domain");

    // 2. Beta host, no flag: off.
    await page.goto(`${BETA}/`);
    await settle(page);
    assert.equal(await page.locator("#fb-root").count(), 0, "off by default on the beta host");
    assert.equal(log.overlayChunk, 0, "overlay chunk not requested by default");
    await shot(page, `${tag}-0-default-off`);

    // 3. ?feedback=on turns it on, and it stays on across a ClientRouter navigation.
    await page.goto(`${BETA}/?feedback=on`);
    const launch = page.locator("#fb-launch");
    await launch.waitFor();
    assert.equal(log.overlayChunk, 1, "overlay chunk loaded once");
    const lb = await launch.boundingBox();
    const dock = await page.locator("#dock > div").boundingBox();
    assert.ok(lb.y + lb.height <= dock.y, "button sits above the player dock");
    assert.ok(lb.height >= 44 && lb.x < 40, "44px target, bottom-left");
    await shot(page, `${tag}-1-button`);
    await page.evaluate(() => document.querySelector('a[href="/bands"]')?.click());
    await page.waitForURL(/\/bands$/);
    await settle(page);
    assert.equal(await page.locator("#fb-launch").count(), 1, "button survives navigation (one copy)");

    // 4. Pick mode: hover highlights, click selects without navigating.
    await press(launch);
    await page.locator("#fb-bar").waitFor();
    const link = page.locator("main a[href]:visible").first();
    const href = await link.getAttribute("href");
    if (!touch) {
      await link.hover();
      assert.ok(await page.locator("#fb-box").isVisible(), "hover highlights");
    }
    await shot(page, `${tag}-2-pick`);
    const before = page.url();
    await press(link);
    await page.locator("#fb-panel").waitFor();
    await page.waitForTimeout(300);
    assert.equal(page.url(), before, `picking ${href} did not navigate`);
    assert.ok(await page.locator("#fb-box").isVisible(), "picked element stays outlined");
    const pb = await page.locator("#fb-panel").boundingBox();
    assert.ok(pb.x >= 15 && pb.x + pb.width <= vp.width - 15, "panel inside the viewport");

    if (UNCONFIGURED) {
      assert.match(await page.locator("#fb-panel .fb-status").textContent(), /Feedback not configured yet/);
      assert.ok(await page.locator("#fb-send").isDisabled(), "Send disabled without a key");
      await shot(page, `${tag}-unconfigured`);
      results.push(`${tag}: unconfigured message shown, nothing sent`);
      await ctx.close();
      continue;
    }

    // 5. Talk → transcript in the editable textarea; Stop; edit; Send → Firestore REST.
    await press(page.locator("#fb-mic"));
    await page.waitForFunction(() => document.querySelector("#fb-note").value.includes("headline"));
    await shot(page, `${tag}-3-talking`);
    await press(page.locator("#fb-mic"));
    await page.locator("#fb-note").press("End");
    await page.locator("#fb-note").pressSequentially(", and bolder.");
    log.reply = { status: 403, body: { error: { code: 403, message: "Missing or insufficient permissions.", status: "PERMISSION_DENIED" } } };
    await press(page.locator("#fb-send"));
    await page.locator("#fb-panel .fb-status.fb-error").waitFor();
    assert.match(await page.locator("#fb-panel .fb-status").textContent(), /HTTP 403 Missing or insufficient permissions/);
    assert.equal(await page.locator("#fb-note").inputValue(), "the headline should be bigger, and bolder.", "note kept after a failed send");
    await shot(page, `${tag}-4-error`);
    log.reply = { status: 200, body: { name: "x" } };
    await press(page.locator("#fb-send"));
    await page.locator("#fb-panel .fb-status", { hasText: "Sent to Claude ✓" }).waitFor();
    await shot(page, `${tag}-5-sent`);
    const req = log.firestore.at(-1);
    assert.equal(req.method, "POST");
    assert.equal(req.url, `${FIRESTORE}?key=test-key`);
    const f = req.body.fields;
    assert.deepEqual(Object.keys(f).sort(), ["createdAt", "note", "page", "selector", "snippet", "ua", "viewport"]);
    for (const v of Object.values(f)) assert.deepEqual(Object.keys(v), ["stringValue"]);
    assert.equal(f.page.stringValue, "/bands");
    assert.equal(f.note.stringValue, "the headline should be bigger, and bolder.");
    assert.equal(f.viewport.stringValue, `${vp.width}x${vp.height}`);
    assert.ok(!Number.isNaN(Date.parse(f.createdAt.stringValue)) && f.createdAt.stringValue.endsWith("Z"));
    assert.ok(f.ua.stringValue.length > 10 && f.ua.stringValue.length <= 290);
    const same = await page.evaluate(([sel, h]) => document.querySelector(sel) === document.querySelector(`main a[href="${h}"]`), [f.selector.stringValue, href]);
    assert.ok(same, `selector ${f.selector.stringValue} finds the picked link`);
    assert.equal(f.snippet.stringValue, (await link.textContent()).replace(/\s+/g, " ").trim().slice(0, 300));
    await page.locator("#fb-panel").waitFor({ state: "hidden" });
    assert.equal((await launch.textContent()).trim(), "Feedback1", "running count on the button");

    // 6. Whole page note, then Esc cancels.
    await press(launch);
    await press(page.locator("#fb-bar button", { hasText: "Whole page" }));
    await page.locator("#fb-note").fill("Whole page note");
    await shot(page, `${tag}-6-whole-page`);
    await press(page.locator("#fb-send"));
    await page.locator("#fb-panel .fb-status", { hasText: "2 notes this session" }).waitFor();
    assert.equal(log.firestore.at(-1).body.fields.selector.stringValue, "(whole page)");
    await page.locator("#fb-panel").waitFor({ state: "hidden" });
    await press(launch);
    await page.locator("#fb-bar").waitFor();
    await page.keyboard.press("Escape");
    assert.ok(await page.locator("#fb-bar").isHidden(), "Esc cancels pick mode");
    await press(launch);
    await press(page.locator("#fb-bar button", { hasText: "Whole page" }));
    await page.keyboard.press("Escape");
    assert.ok(await page.locator("#fb-panel").isHidden(), "Esc closes the panel");

    // 7. Preview channel works; ?feedback=off turns it off.
    await page.goto(`${PREVIEW}/listen?feedback=on`);
    await page.locator("#fb-launch").waitFor();
    await page.goto(`${PREVIEW}/listen?feedback=off`);
    await settle(page);
    assert.equal(await page.locator("#fb-root").count(), 0, "?feedback=off turns it off");
    await page.goto(`${PREVIEW}/`);
    await settle(page);
    assert.equal(await page.locator("#fb-root").count(), 0, "stays off");

    const csp = await page.evaluate(() => window.__csp);
    assert.deepEqual(csp, [], "no CSP violations");
    results.push(`${tag}: ok (${log.firestore.length} Firestore requests intercepted)`);
    await ctx.close();

    // 8. No speech API (Firefox): typing still works, one-line notice.
    const ff = await newContext(browser, vp, { speech: false });
    const p2 = await ff.ctx.newPage();
    await p2.goto(`${BETA}/?feedback=on`);
    await (touch ? p2.locator("#fb-launch").tap() : p2.locator("#fb-launch").click());
    await (touch ? p2.locator("#fb-bar button", { hasText: "Whole page" }).tap() : p2.locator("#fb-bar button", { hasText: "Whole page" }).click());
    assert.equal(await p2.locator("#fb-mic").count(), 0, "no Talk button without speech");
    assert.match(await p2.locator("#fb-panel .fb-note").textContent(), /Voice isn't available/);
    await p2.locator("#fb-note").fill("typed");
    await shot(p2, `${tag}-7-no-speech`);
    await ff.ctx.close();
  }
  // What the deployed Permissions-Policy allows for the microphone (speech recognition needs it).
  const { ctx } = await newContext(browser, { width: 1366, height: 900 });
  const p = await ctx.newPage();
  await p.goto(`${BETA}/`);
  results.push(`microphone allowed by Permissions-Policy: ${await p.evaluate(() => document.featurePolicy?.allowsFeature("microphone"))}`);
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
console.log(results.join("\n"));
