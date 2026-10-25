// Visitor analytics: source classification, the Firestore write shape (must satisfy firestore.rules),
// link rules for interest events, and the weekly digest's aggregation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const T = await import("../src/lib/track.ts");
const S = await import("../src/lib/analytics-schema.ts");
const A = await import("../scripts/lib/analytics-agg.mjs");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OWN = "tritone-productions.com";
const src = (ref, search = "") => T.classifySource(ref, search, OWN).src;

test("UTM tags win over the referrer", () => {
  assert.equal(src("https://www.google.com/", "?utm_source=mailchimp&utm_medium=email&utm_campaign=fall"), "email");
  assert.equal(src("", "?utm_medium=Newsletter"), "email");
  assert.equal(src("", "?utm_source=newsletter"), "email");
  for (const s of ["chatgpt.com", "openai", "perplexity", "claude.ai", "gemini", "copilot", "deepseek", "grok"])
    assert.equal(src("https://www.google.com/", `?utm_source=${s}`), "ai", s);
  assert.equal(src("https://l.instagram.com/", "?utm_source=instagram&utm_medium=social&utm_campaign=spring"), "campaign");
  assert.equal(src("", "?utm_campaign=poster-qr"), "campaign");
  const a = T.classifySource("https://www.facebook.com/x?y=1", "?utm_source=FB&utm_medium=Paid&utm_campaign=Spring Show&utm_content=Story", OWN);
  assert.deepEqual(a, { src: "campaign", ref: "facebook.com", us: "fb", um: "paid", uc: "Spring Show", ux: "Story" });
});

test("AI assistants by referrer", () => {
  for (const h of [
    "https://chatgpt.com/", "https://chat.openai.com/c/123", "https://www.perplexity.ai/search?q=studio", "https://claude.ai/chat/abc",
    "https://gemini.google.com/app", "https://bard.google.com/", "https://copilot.microsoft.com/", "https://edgeservices.bing.com/edgesvc/chat",
    "https://you.com/search", "https://www.phind.com/", "https://poe.com/", "https://www.meta.ai/", "https://grok.com/", "https://chat.deepseek.com/",
    "https://chat.mistral.ai/chat", "https://duck.ai/", "android-app://com.openai.chatgpt/",
  ])
    assert.equal(src(h), "ai", h);
});

test("search engines, any Google TLD", () => {
  for (const h of [
    "https://www.google.com/", "https://www.google.co.uk/", "https://google.com.au/", "https://www.google.de/search?q=x", "https://www.bing.com/search?q=x",
    "https://cn.bing.com/", "https://duckduckgo.com/", "https://html.duckduckgo.com/html", "https://search.yahoo.com/", "https://www.ecosia.org/search",
    "https://search.brave.com/search", "https://www.startpage.com/", "https://kagi.com/search", "https://www.baidu.com/", "https://yandex.ru/", "https://yandex.com.tr/",
    "https://search.aol.com/", "https://www.qwant.com/", "android-app://com.google.android.googlequicksearchbox/",
  ])
    assert.equal(src(h), "search", h);
  for (const h of ["https://docs.google.com/document/d/1", "https://sites.google.com/x", "https://maps-not.google.example.com/"])
    assert.notEqual(src(h), "search", h);
});

test("social networks", () => {
  for (const h of [
    "https://www.facebook.com/", "https://m.facebook.com/", "https://l.facebook.com/l.php?u=x", "https://lm.facebook.com/", "https://fb.com/", "https://www.instagram.com/",
    "https://l.instagram.com/", "https://t.co/abc", "https://x.com/", "https://twitter.com/", "https://www.linkedin.com/feed", "https://lnkd.in/abc", "https://www.youtube.com/",
    "https://m.youtube.com/", "https://youtu.be/x", "https://www.reddit.com/r/bayarea", "https://out.reddit.com/", "https://www.tiktok.com/", "https://www.threads.net/",
    "https://bsky.app/", "https://www.pinterest.com/", "https://www.pinterest.co.uk/", "https://nextdoor.com/", "https://mastodon.social/", "https://sfba.social.mastodon.example/",
  ].slice(0, -1))
    assert.equal(src(h), "social", h);
});

test("webmail is email; own site and nothing are direct; everything else is a referral", () => {
  for (const h of ["https://mail.google.com/", "https://outlook.live.com/mail/0/", "https://mail.yahoo.com/", "https://outlook.office.com/"]) assert.equal(src(h), "email", h);
  for (const h of ["", "https://tritone-productions.com/shows", "https://www.tritone-productions.com/", "not a url"]) assert.equal(src(h), "direct", h);
  assert.equal(T.classifySource("https://tritone-productions.com/x", "", OWN).ref, "", "own host is never stored");
  for (const h of ["https://sfjazz.org/", "https://www.clubdeluxe.co/", "https://docs.google.com/"]) assert.equal(src(h), "referral", h);
  assert.equal(src("", "?gclid=abc"), "search");
  assert.equal(src("", "?fbclid=abc"), "social");
});

test("only the referrer hostname is kept", () => {
  const a = T.classifySource("https://www.Example.com/private/path?email=a@b.c#x", "", OWN);
  assert.deepEqual(a, { src: "referral", ref: "example.com", us: "", um: "", uc: "", ux: "" });
  assert.equal(T.classifySource("https://" + "a".repeat(200) + ".com/", "", OWN).ref.length, 100);
});

test("paths lose query and hash; devices by width; bots and hosts", () => {
  assert.equal(T.cleanPath("/shows/x?utm_source=y#z"), "/shows/x");
  assert.equal(T.cleanPath(""), "/");
  assert.deepEqual([320, 639, 640, 1023, 1024, 1920].map(T.deviceOf), ["m", "m", "t", "t", "d", "d"]);
  assert.equal(T.isLikelyBot("Mozilla/5.0 (compatible; Googlebot/2.1)"), true);
  assert.equal(T.isLikelyBot("Mozilla/5.0 HeadlessChrome/120"), true);
  assert.equal(T.isLikelyBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1"), false);
  assert.equal(T.isLikelyBot("Mozilla/5.0 Safari", true), true, "navigator.webdriver");
  assert.equal(T.hostTracked("tritone-productions.com"), true);
  assert.equal(T.hostTracked("www.tritone-productions.com"), true);
  for (const h of ["tritone-site.web.app", "localhost", "127.0.0.1", "evil-tritone-productions.com"]) assert.equal(T.hostTracked(h), false, h);
  assert.equal(T.hostTracked("localhost", true), true, "dev + debug flag");
});

const base = { k: "pv", sid: "abc", path: "/", first: true, src: "ai", ref: "chatgpt.com", us: "", um: "", uc: "", ux: "", land: "/", dev: "m", tz: "America/Los_Angeles", lang: "en-US", ev: "", lbl: "" };

test("the REST write fits firestore.rules and the shared schema", () => {
  const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");
  const block = rules.slice(rules.indexOf("function validHit"));
  const keys = JSON.parse(block.match(/hasOnly\((\[[^\]]+\])\)/)[1].replace(/'/g, '"'));
  const limits = Object.fromEntries([...block.matchAll(/str\(d\.(\w+), (\d+)\)/g)].map((m) => [m[1], Number(m[2])]));
  const long = "x".repeat(500);
  const body = T.commitBody({ ...base, k: "ev", ev: "outbound", sid: long, path: "/" + long + "?q", ref: long, us: long, um: long, uc: long, ux: long, land: long, tz: long, lang: long, lbl: long }, "docid");
  assert.equal(body.writes.length, 1);
  const w = body.writes[0];
  assert.equal(w.update.name, "projects/tritone-site/databases/(default)/documents/hits/docid");
  assert.deepEqual(w.currentDocument, { exists: false });
  assert.deepEqual(w.updateTransforms, [{ fieldPath: "t", setToServerValue: "REQUEST_TIME" }]);
  assert.deepEqual([...Object.keys(w.update.fields), "t"].sort(), [...keys].sort());
  // Every schema field is either written or server-set.
  assert.deepEqual([...keys].sort(), Object.keys(T.hitFields(base)).concat("t").sort());
  for (const [k, max] of Object.entries(limits)) assert.ok(w.update.fields[k].stringValue.length <= max, `${k} <= ${max}`);
  assert.deepEqual(w.update.fields.first, { booleanValue: true });
  assert.equal(w.update.fields.path.stringValue.includes("?"), false);
  // Sources and events in the rules match the schema.
  assert.deepEqual(JSON.parse(block.match(/d\.src in (\[[^\]]+\])/)[1].replace(/'/g, '"')), S.SOURCES);
  const evs = JSON.parse(block.match(/d\.ev in (\[[^\]]+\])/)[1].replace(/'/g, '"').replace(/\s+/g, ""));
  assert.deepEqual(evs.sort(), Object.keys(S.EVENT_LABELS).sort());
  assert.deepEqual([...T.EVENTS].sort(), Object.keys(S.EVENT_LABELS).sort());
  // Admins in the rules match the schema.
  for (const e of S.ADMIN_EMAILS) assert.ok(rules.includes(`'${e}'`), e);
  // Page views carry no event fields; bad values are coerced into the allowed sets.
  const pv = T.hitFields({ ...base, ev: "play", lbl: "x", src: "bogus", dev: "x" });
  assert.equal(pv.ev.stringValue, "");
  assert.equal(pv.lbl.stringValue, "");
  assert.equal(pv.src.stringValue, "direct");
  assert.equal(pv.dev.stringValue, "d");
  assert.equal(T.COMMIT_URL, `${S.FIRESTORE_DOCS}:commit`);
  assert.match(T.randomId(), /^[A-Za-z0-9]{20}$/);
});

test("link rules turn clicks into interest events", () => {
  const c = (href, page = "/") => T.classifyLink(href, page, OWN);
  assert.deepEqual(c("mailto:scott@tritone-productions.com"), [{ ev: "contact_click", lbl: "email" }]);
  assert.deepEqual(c("mailto:scott@tritone-productions.com", "/book-the-hut"), [{ ev: "book_earlier", lbl: "email" }, { ev: "contact_click", lbl: "email" }]);
  assert.deepEqual(c("mailto:scott@tritone-productions.com?subject=Request%20an%20earlier%20time"), [{ ev: "book_earlier", lbl: "email" }, { ev: "contact_click", lbl: "email" }]);
  assert.deepEqual(c("tel:+14155550100"), [{ ev: "contact_click", lbl: "phone" }]);
  assert.deepEqual(c("/shows/franco-nero-2026-11-01"), [{ ev: "show_click", lbl: "franco-nero-2026-11-01" }]);
  assert.deepEqual(c("/shows/franco-nero-2026-11-01", "/shows/franco-nero-2026-11-01"), [], "same page");
  assert.deepEqual(c("/shows/x.ics"), [{ ev: "calendar_add", lbl: "x" }]);
  assert.deepEqual(c("/gallery#hard-bop"), [{ ev: "poster_click", lbl: "hard-bop" }]);
  assert.deepEqual(c("https://calendar.google.com/calendar/render?action=TEMPLATE"), [{ ev: "calendar_add", lbl: "google" }]);
  assert.deepEqual(c("https://www.instagram.com/tritone"), [{ ev: "outbound", lbl: "instagram.com" }]);
  assert.deepEqual(c("https://tritone-productions.com/bands"), []);
  assert.deepEqual(c("/bands/lucky-7"), []);
  assert.deepEqual(c("javascript:void(0)"), []);
});

// ---- aggregation ----
const NOW = new Date("2026-10-26T15:00:00Z");
let n = 0;
const hit = (daysAgo, h) => ({ ...base, first: false, t: new Date(NOW - daysAgo * 86_400_000).toISOString(), id: String(n++), ...h });
function visit(daysAgo, sid, src, ref, pages, events = [], extra = {}) {
  const out = pages.map((p, i) => hit(daysAgo, { sid, src, ref, k: "pv", path: p, first: i === 0, land: pages[0], ...extra }));
  for (const [ev, lbl] of events) out.push(hit(daysAgo, { sid, src, ref, k: "ev", ev, lbl, path: pages.at(-1), land: pages[0], ...extra }));
  return out;
}
const HITS = [
  // this week: 5 visits
  ...visit(1, "a", "ai", "chatgpt.com", ["/", "/book-the-hut"], [["book_submit", "4h Sat"]]),
  ...visit(2, "b", "ai", "perplexity.ai", ["/hummingbird-hut"]),
  ...visit(2, "c", "search", "google.com", ["/shows", "/shows/x"], [["show_click", "x"], ["ticket_click", "x"]]),
  ...visit(3, "d", "campaign", "", ["/listen"], [["play", "spotify: Fault Line Trio"]], { us: "instagram", um: "social", uc: "fall-show" }),
  ...visit(6, "e", "direct", "", ["/"], [], { dev: "d" }),
  // last week: 2 visits
  ...visit(8, "f", "search", "bing.com", ["/"], [["book_submit", "2h Mon"]]),
  ...visit(10, "g", "direct", "", ["/shows"]),
  // too old
  ...visit(20, "h", "ai", "claude.ai", ["/"]),
];

test("decodeDoc reads Firestore REST documents", () => {
  const d = A.decodeDoc({ name: "projects/p/databases/(default)/documents/hits/abc", fields: { k: { stringValue: "pv" }, first: { booleanValue: true }, t: { timestampValue: "2026-10-20T00:00:00Z" } } });
  assert.deepEqual(d, { id: "abc", k: "pv", first: true, t: "2026-10-20T00:00:00Z" });
});

test("weeks split and summarise", () => {
  const { cur, prev } = A.splitWeeks(HITS, NOW);
  const c = A.summarize(cur), p = A.summarize(prev);
  assert.equal(c.visits, 5);
  assert.equal(c.pageViews, 7);
  assert.equal(p.visits, 2);
  assert.deepEqual(c.bySource, { ai: 2, search: 1, social: 0, email: 0, campaign: 1, referral: 0, direct: 1 });
  assert.deepEqual([...c.aiRefs].sort(), [["chatgpt.com", 1], ["perplexity.ai", 1]]);
  assert.equal(c.events.get("book_submit"), 1);
  assert.deepEqual([...c.bookingsBySource], [["ai", 1]]);
  assert.deepEqual([...c.campaigns], [["fall-show · instagram / social", 1]]);
  assert.equal(c.pages.get("/"), 2);
  assert.equal(A.change(5, 2), "+150%");
  assert.equal(A.change(1, 2), "-50%");
  assert.equal(A.change(3, 0), "new");
  assert.equal(A.change(0, 0), "—");
});

test("insights are 3-5 plain sentences and the digest has every section", () => {
  const { cur, prev } = A.splitWeeks(HITS, NOW);
  const lines = A.insights(A.summarize(cur), A.summarize(prev));
  assert.ok(lines.length >= 3 && lines.length <= 5, lines.join("\n"));
  for (const l of lines) assert.match(l, /^[A-Z0-9/“].*\.$/);
  assert.match(lines[0], /up 150% at 5 \(from 2\)/);
  assert.ok(lines.some((l) => /AI assistants/.test(l)), "AI line");
  assert.ok(lines.some((l) => /Book the Hut request/.test(l)), "booking line");
  const md = A.renderDigest(HITS, NOW);
  for (const h of ["What changed", "Where visits came from", "AI assistants", "Top pages", "Outreach links", "Interest", "Booking requests by source"]) assert.ok(md.includes(`### ${h}`), h);
  assert.ok(md.includes("| AI assistants | 2 | 0 | new | 40% |"), md);
  assert.ok(!/claude\.ai/.test(md), "hits older than 14 days are ignored");
  assert.deepEqual(A.insights(A.summarize([]), A.summarize([])).length, 1);
});

// ---- dist/ ----
const DIST = join(ROOT, "dist");
const built = existsSync(join(DIST, "index.html"));
test("the tracker is bundled and posts to the Firestore commit endpoint", { skip: !built && "dist/ not built" }, () => {
  const js = readdirSync(join(DIST, "_astro")).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(DIST, "_astro", f), "utf8"));
  // The endpoint host lives in the shared analytics-schema chunk (the admin page imports it too).
  const all = js.join("\n");
  assert.ok(js.some((s) => s.includes(":commit") && s.includes("REQUEST_TIME")), "tracker bundled");
  assert.ok(all.includes("firestore.googleapis.com"), "Firestore host bundled");
});
