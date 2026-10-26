// Scott's dashboard (/admin): the pure pieces. Aggregation (src/lib/admin/aggregate.ts), Firestore
// REST parsing and queries (firestore.ts), the outreach link builder (links.ts), sign-in error
// messages (auth.ts) and the demo generator (demo.ts). Plus: /admin stays private in the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const A = await import("../src/lib/admin/aggregate.ts");
const F = await import("../src/lib/admin/firestore.ts");
const L = await import("../src/lib/admin/links.ts");
const { friendlyAuthError, isAdminEmail, jwtPayload } = await import("../src/lib/admin/auth.ts");
const { generateDemo } = await import("../src/lib/admin/demo.ts");
const { niceMax, stackedBars, sparkline } = await import("../src/lib/admin/charts.ts");
const { SOURCES, ADMIN_EMAILS } = await import("../src/lib/analytics-schema.ts");
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const T0 = Date.parse("2026-10-01T18:00:00Z");
const min = 60e3;
let n = 0;
function hit(o) {
  return { k: "pv", t: new Date(T0 + (o.at ?? 0) * min).toISOString(), sid: o.sid, path: o.path ?? "/", first: !!o.first, src: o.src ?? "direct", ref: o.ref ?? "", us: o.us ?? "", um: o.um ?? "", uc: o.uc ?? "", ux: "", land: o.land ?? "/", dev: o.dev ?? "m", tz: o.tz ?? "America/Los_Angeles", lang: "en-US", ev: o.ev ?? "", lbl: o.lbl ?? "", ...(o.ev ? { k: "ev" } : {}), id: String(n++) };
}
// Four visits: ChatGPT -> Hut -> book request; Instagram outreach link -> show -> ticket; Google -> home; direct -> home.
const HITS = [
  hit({ sid: "a", at: 0, path: "/hummingbird-hut", first: true, src: "ai", ref: "chatgpt.com", land: "/hummingbird-hut", dev: "d" }),
  hit({ sid: "a", at: 2, path: "/book-the-hut", src: "ai", ref: "chatgpt.com", land: "/hummingbird-hut", dev: "d" }),
  hit({ sid: "a", at: 5, path: "/book-the-hut", src: "ai", ref: "chatgpt.com", land: "/hummingbird-hut", dev: "d", ev: "book_submit", lbl: "4h Thu" }),
  hit({ sid: "b", at: 60, path: "/shows/x-at-the-deluxe", first: true, src: "campaign", ref: "l.instagram.com", us: "instagram", um: "social", uc: "the-deluxe", land: "/shows/x-at-the-deluxe" }),
  hit({ sid: "b", at: 61, path: "/shows/x-at-the-deluxe", src: "campaign", ref: "l.instagram.com", us: "instagram", um: "social", uc: "the-deluxe", land: "/shows/x-at-the-deluxe", ev: "ticket_click", lbl: "x-at-the-deluxe" }),
  hit({ sid: "c", at: 1500, path: "/", first: true, src: "search", ref: "www.google.com", tz: "Europe/London" }),
  hit({ sid: "c", at: 1501, path: "/listen", src: "search", ref: "www.google.com", tz: "Europe/London", dev: "m" }),
  hit({ sid: "d", at: 1502, path: "/", first: true, src: "direct", tz: "America/New_York" }),
];

test("hits group into visits with landing attributes and ordered pages / events", () => {
  const v = A.buildVisits([...HITS].reverse());
  assert.deepEqual(v.map((x) => x.sid), ["a", "b", "c", "d"]);
  assert.deepEqual(v[0].pages.map((p) => p.path), ["/hummingbird-hut", "/book-the-hut"]);
  assert.deepEqual(v[0].events.map((e) => e.ev), ["book_submit"]);
  assert.equal(v[0].src, "ai");
  assert.equal(v[0].end - v[0].start, 5 * min);
});

test("summary: visits, page views, pages/visit, interest, bookings, conversion", () => {
  const s = A.summarize(A.buildVisits(HITS));
  assert.deepEqual({ ...s, pagesPerVisit: +s.pagesPerVisit.toFixed(2) }, { visits: 4, pageViews: 6, pagesPerVisit: 1.5, interest: 2, interestedVisits: 2, bookings: 1, conversion: 0.5 });
  assert.deepEqual(A.summarize([]), { visits: 0, pageViews: 0, pagesPerVisit: 0, interest: 0, interestedVisits: 0, bookings: 0, conversion: 0 });
  assert.equal(A.change(15, 10), 0.5);
  assert.equal(A.change(5, 0), null);
  assert.equal(A.change(0, 0), 0);
});

test("time bins: hours for a day, days otherwise; binIndex finds the bin", () => {
  const from = new Date(2026, 9, 1).getTime();
  const day = A.makeBins(from, from + 24 * 3600e3);
  assert.equal(day.unit, "hour");
  assert.equal(day.starts.length, 24);
  const month = A.makeBins(from, from + 30 * 864e5);
  assert.equal(month.unit, "day");
  assert.equal(month.starts.length, 30);
  assert.equal(A.binIndex(month.starts, from - 1), -1);
  assert.equal(A.binIndex(month.starts, from + 2.5 * 864e5), 2);
  const visits = A.buildVisits(HITS);
  const bins = A.makeBins(T0 - 864e5, T0 + 3 * 864e5, "day");
  const stacked = A.trafficBySource(visits, bins.starts);
  assert.equal(SOURCES.reduce((n, s) => n + stacked[s].reduce((a, b) => a + b, 0), 0), 4);
  const k = A.kpiSeries(visits, bins.starts);
  assert.equal(k.visits.reduce((a, b) => a + b, 0), 4);
  assert.equal(k.bookings.reduce((a, b) => a + b, 0), 1);
});

test("AI assistants are recognised by referrer or utm_source; hosts get friendly names", () => {
  for (const [h, name] of [["chatgpt.com", "ChatGPT"], ["chat.openai.com", "ChatGPT"], ["www.perplexity.ai", "Perplexity"], ["claude.ai", "Claude"], ["gemini.google.com", "Gemini"], ["copilot.microsoft.com", "Copilot"], ["chat.deepseek.com", "DeepSeek"]])
    assert.equal(A.aiName(h), name, h);
  assert.equal(A.aiName("www.google.com"), null);
  assert.equal(A.hostLabel("l.instagram.com"), "Instagram");
  assert.equal(A.hostLabel("lm.facebook.com"), "Facebook");
  assert.equal(A.hostLabel("www.google.co.uk"), "Google");
  assert.equal(A.hostLabel("thedeluxesf.com"), "thedeluxesf.com");
  assert.equal(A.prettySource("flyer", "qr"), "Flyer QR");
  const [a, b] = A.buildVisits(HITS);
  assert.equal(A.visitOrigin(a), "ChatGPT");
  assert.equal(A.visitOrigin(b), "Instagram · the-deluxe");
});

test("sources, referrers, AI card, outreach campaigns", () => {
  const v = A.buildVisits(HITS);
  const src = A.sourceBreakdown(v, v.slice(0, 1));
  assert.deepEqual(src.map((s) => s.src), SOURCES);
  assert.equal(src.find((s) => s.src === "ai").share, 0.25);
  assert.equal(src.find((s) => s.src === "ai").prev, 1);
  const refs = A.referrers(v, v.slice(0, 1));
  assert.deepEqual(refs.map((r) => [r.label, r.src, r.isNew]), [["ChatGPT", "ai", false], ["Google", "search", true], ["Instagram", "campaign", true]]);
  const ai = A.aiAssistants(v);
  assert.deepEqual(ai.map((r) => [r.label, r.visits, r.bookings, r.topLanding]), [["ChatGPT", 1, 1, "/hummingbird-hut"]]);
  const c = A.campaigns(v);
  assert.equal(c.length, 1);
  assert.equal(c[0].label, "the-deluxe");
  assert.equal(c[0].tickets, 1);
  assert.deepEqual(c[0].sources, [{ source: "instagram", medium: "social", visits: 1 }]);
  // ChatGPT's own utm_source=chatgpt.com is not an outreach link
  const gpt = A.buildVisits([hit({ sid: "z", first: true, src: "ai", us: "chatgpt.com" })]);
  assert.equal(A.campaigns(gpt).length, 0);
  assert.equal(A.aiAssistants(gpt)[0].label, "ChatGPT");
});

test("interest: funnel, event counts, attention, why", () => {
  const v = A.buildVisits(HITS);
  assert.deepEqual(A.funnel(v).map((s) => s.visits), [4, 1, 1, 1]);
  const ev = A.eventCounts(v);
  assert.deepEqual(ev.map((e) => [e.ev, e.label, e.count]).sort(), [["book_submit", "Booking requests", 1], ["ticket_click", "Ticket / venue clicks", 1]]);
  const at = A.attention(v, (s) => (s === "x-at-the-deluxe" ? "X at The DeLuxe" : undefined));
  assert.deepEqual(at.shows.map((r) => [r.label, r.count, r.detail]), [["X at The DeLuxe", 1, "1 ticket click"]]);
  const why = A.interestBySource(v);
  assert.deepEqual(why.slice(0, 2).map((w) => [w.src, w.rate]), [["ai", 1], ["campaign", 1]]);
  assert.deepEqual(A.bookingDetails(v).hours, [{ label: "4 h", count: 1 }]);
  assert.equal(A.bookingDetails(v).days.find((d) => d.label === "Thu").count, 1);
});

test("pages, landing pages, devices, regions (time zone only), languages", () => {
  const v = A.buildVisits(HITS);
  const pages = A.topPages(v);
  assert.deepEqual([pages[0].path, pages[0].views, pages[0].visits], ["/", 2, 2]);
  assert.equal(pages.reduce((n, p) => n + p.views, 0), 6);
  assert.equal(pages.find((p) => p.path === "/book-the-hut").actions, 1);
  const land = A.landingPages(v);
  assert.equal(land[0].path, "/");
  assert.equal(land[0].visits, 2);
  assert.deepEqual(A.devices(v).map((d) => d.visits), [3, 0, 1]);
  assert.equal(A.regionForTz("America/Los_Angeles"), "US West (Pacific)");
  assert.equal(A.regionForTz("America/Denver"), "US Mountain");
  assert.equal(A.regionForTz("America/Chicago"), "US Central");
  assert.equal(A.regionForTz("America/New_York"), "US East");
  assert.equal(A.regionForTz("Europe/London"), "UK & Ireland");
  assert.equal(A.regionForTz("Europe/Berlin"), "Europe");
  assert.equal(A.regionForTz("Asia/Tokyo"), "Japan & Korea");
  assert.equal(A.regionForTz(""), "Unknown");
  assert.deepEqual(A.regions(v).map((r) => r.label), ["US West (Pacific)", "UK & Ireland", "US East"]);
  assert.equal(A.weekHourGrid(v).flat().reduce((a, b) => a + b, 0), 4);
});

test("live now and anonymous journeys", () => {
  const now = T0 + 1503 * min;
  const live = A.liveNow(HITS, now);
  assert.deepEqual(live.map((l) => l.sid).sort(), ["c", "d"]);
  assert.equal(live.find((l) => l.sid === "c").page, "/listen");
  const j = A.journeys(A.buildVisits(HITS), 10);
  assert.equal(j[0].sid, "d");
  const a = j.find((x) => x.sid === "a");
  assert.deepEqual(a.steps.map((s) => s.kind), ["page", "page", "event"]);
  assert.equal(a.steps[2].text, "Booking request");
  assert.equal(a.booked, true);
});

test("insights are plain sentences about what changed", () => {
  const demo = generateDemo({ now: Date.parse("2026-10-25T20:00:00Z"), seed: 3 });
  const v = A.buildVisits(demo.hits);
  const now = Date.parse("2026-10-25T20:00:00Z");
  const cur = v.filter((x) => A.inRange(x, now - 30 * 864e5, now));
  const prev = v.filter((x) => A.inRange(x, now - 60 * 864e5, now - 30 * 864e5));
  const bins = A.makeBins(now - 30 * 864e5, now);
  const out = A.insights(cur, prev, { starts: bins.starts, unit: bins.unit, shows: demo.shows, periodLabel: "the 30 days before" });
  assert.ok(out.length >= 3 && out.length <= 6, `${out.length} insights`);
  for (const i of out) assert.match(i.text, /^[A-Z0-9“"].+[.]$/, i.text);
  assert.ok(out.some((i) => /AI assistants/.test(i.text)));
  assert.deepEqual(A.insights([], [], {}).map((i) => i.tone), ["info"]);
  const first = A.insights(A.buildVisits(HITS), [], {});
  assert.ok(first.length >= 1 && first.length <= 6);
});

test("CSV export: header, one row per hit, quoting, no formula injection", () => {
  const csv = A.toCsv([hit({ sid: "q", path: '/a,"b"', ev: "outbound", lbl: "=HYPERLINK(1)" })]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^time,kind,visit,page,event,detail,source/);
  assert.ok(lines[1].includes('"/a,""b"""'));
  assert.ok(lines[1].includes("'=HYPERLINK(1)"));
});

test("Firestore: typed values, hits, query shape, cursor paging", () => {
  assert.equal(F.fromValue({ stringValue: "x" }), "x");
  assert.equal(F.fromValue({ integerValue: "42" }), 42);
  assert.equal(F.fromValue({ booleanValue: true }), true);
  assert.equal(F.fromValue({ timestampValue: "2026-10-01T00:00:00.123Z" }), "2026-10-01T00:00:00.123Z");
  assert.deepEqual(F.fromValue({ mapValue: { fields: { a: { doubleValue: 1.5 } } } }), { a: 1.5 });
  assert.deepEqual(F.fromValue({ arrayValue: { values: [{ nullValue: null }] } }), [null]);
  const doc = (i, k = "pv") => ({
    name: `projects/tritone-site/databases/(default)/documents/hits/id${i}`,
    fields: { k: { stringValue: k }, t: { timestampValue: `2026-10-01T00:00:0${i}Z` }, sid: { stringValue: "s" }, path: { stringValue: "/" }, first: { booleanValue: i === 0 }, src: { stringValue: "ai" }, dev: { stringValue: "x" } },
  });
  const h = F.docToHit(doc(0));
  assert.equal(h.id, "id0");
  assert.equal(h.first, true);
  assert.equal(h.dev, "d"); // unknown device falls back
  assert.equal(h.ref, "");
  assert.equal(F.docToHit({ fields: { k: { stringValue: "zz" }, t: { timestampValue: "2026-10-01T00:00:00Z" } } }), null);
  const page = F.parseRunQuery([{ document: doc(1) }, { document: doc(2, "ev") }, { readTime: "x" }], 2);
  assert.equal(page.hits.length, 2);
  assert.deepEqual(page.next, { t: "2026-10-01T00:00:02Z", name: doc(2).name });
  assert.equal(F.parseRunQuery([{ document: doc(1) }], 2).next, null);
  const q = F.hitsQuery("2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", page.next).structuredQuery;
  assert.deepEqual(q.from, [{ collectionId: "hits" }]);
  assert.deepEqual(q.orderBy.map((o) => o.field.fieldPath), ["t", "__name__"]);
  assert.deepEqual(q.where.compositeFilter.filters.map((f) => f.fieldFilter.op), ["GREATER_THAN_OR_EQUAL", "LESS_THAN"]);
  assert.deepEqual(q.startAt, { values: [{ timestampValue: page.next.t }, { referenceValue: page.next.name }], before: false });
  assert.match(F.friendlyFirestoreError(403, "PERMISSION_DENIED"), /isn't allowed/);
});

test("fetchHits pages through runQuery with the bearer token", async () => {
  const calls = [];
  const mk = (i) => ({ document: { name: `p/hits/${i}`, fields: { k: { stringValue: "pv" }, t: { timestampValue: new Date(T0 + i * 1000).toISOString() }, sid: { stringValue: "s" } } } });
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    assert.equal(init.headers.authorization, "Bearer TOKEN");
    assert.match(url, /documents:runQuery$/);
    const start = calls.length === 1 ? 0 : 1000;
    const count = calls.length === 1 ? 1000 : 5;
    return new Response(JSON.stringify(Array.from({ length: count }, (_, i) => mk(start + i))), { status: 200 });
  };
  const hits = await F.fetchHits("TOKEN", new Date(T0), new Date(T0 + 864e5), { fetchImpl });
  assert.equal(hits.length, 1005);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].structuredQuery.startAt);
  const denied = async () => new Response(JSON.stringify([{ error: { code: 403, status: "PERMISSION_DENIED", message: "Missing or insufficient permissions." } }]), { status: 403 });
  await assert.rejects(F.fetchHits("TOKEN", new Date(T0), new Date(T0 + 1), { fetchImpl: denied }), /isn't allowed to read/);
});

test("link builder: clean tagged URLs per channel", () => {
  assert.equal(L.slugify("The DeLuxe, Nov 8!"), "the-deluxe-nov-8");
  assert.equal(L.slugify("Toot's Tavern & Café"), "toots-tavern-and-cafe");
  assert.equal(L.buildLink({ path: "/shows/x", name: "The DeLuxe", channel: "instagram" }), "https://tritone-productions.com/shows/x?utm_source=instagram&utm_medium=social&utm_campaign=the-deluxe");
  assert.equal(L.buildLink({ path: "/", name: "Hut open house", channel: "flyer", content: "Window Poster" }), "https://tritone-productions.com/?utm_source=flyer&utm_medium=qr&utm_campaign=hut-open-house&utm_content=window-poster");
  assert.equal(L.buildLink({ path: "/book-the-hut", name: "Low Bar", channel: "venue" }), "https://tritone-productions.com/book-the-hut?utm_source=low-bar&utm_medium=referral&utm_campaign=low-bar");
  assert.equal(L.buildLink({ path: "/", name: "  ", channel: "instagram" }), null);
  assert.equal(L.buildLink({ path: "/", name: "x", channel: "nope" }), null);
  for (const c of L.CHANNELS) assert.ok(L.buildLink({ path: "/listen", name: "Test", channel: c.id }).startsWith("https://tritone-productions.com/listen?utm_source="));
});

test("sign-in: admin list and friendly errors (incl. sign-in not switched on)", () => {
  assert.ok(ADMIN_EMAILS.every(isAdminEmail));
  assert.ok(isAdminEmail(" SLARSON36251@gmail.com "));
  assert.equal(isAdminEmail("someone@example.com"), false);
  assert.match(friendlyAuthError("OPERATION_NOT_ALLOWED"), /isn't switched on yet in Firebase/);
  assert.match(friendlyAuthError("CONFIGURATION_NOT_FOUND"), /isn't switched on yet in Firebase/);
  assert.match(friendlyAuthError("INVALID_OOB_CODE"), /already been used/);
  assert.match(friendlyAuthError("TOO_MANY_ATTEMPTS_TRY_LATER : Too many"), /Too many tries/);
  const tok = `x.${Buffer.from(JSON.stringify({ email: "a@b.c" })).toString("base64url")}.y`;
  assert.equal(jwtPayload(tok).email, "a@b.c");
  assert.deepEqual(jwtPayload("junk"), {});
});

test("demo data is deterministic, schema-shaped and anonymous", () => {
  const now = Date.parse("2026-10-25T20:00:00Z");
  const a = generateDemo({ now, seed: 5, days: 40 }), b = generateDemo({ now, seed: 5, days: 40 });
  assert.deepEqual(a.hits.slice(0, 50), b.hits.slice(0, 50));
  const keys = ["k", "t", "sid", "path", "first", "src", "ref", "us", "um", "uc", "ux", "land", "dev", "tz", "lang", "ev", "lbl"].sort();
  for (const h of a.hits) {
    assert.deepEqual(Object.keys(h).sort(), keys);
    assert.ok(SOURCES.includes(h.src));
    assert.ok(Date.parse(h.t) <= now);
  }
  assert.ok(A.liveNow(a.hits, now).length >= 1);
  assert.ok(!/@|\d{3}[-.\s]\d{4}|street|\bst\b|ave/i.test(JSON.stringify(a.hits.map((h) => [h.lbl, h.ref, h.uc]))));
});

test("charts: round axis tops, SVG output", () => {
  assert.deepEqual([1, 5, 9, 37, 113, 150, 333].map(niceMax), [4, 8, 12, 40, 120, 160, 400]);
  const starts = [0, 1, 2].map((i) => T0 + i * 864e5);
  const series = Object.fromEntries(SOURCES.map((s) => [s, [1, 2, 0]]));
  const svg = stackedBars({ width: 360, height: 240, starts, unit: "day", series, visible: SOURCES, now: T0, shows: [{ start: T0 + 864e5 + 3600e3, title: "A & B", past: false }] });
  assert.match(svg, /^<svg[^>]+viewBox="0 0 360 240"/);
  assert.match(svg, /<title>A &amp; B<\/title>/);
  assert.match(sparkline([1, 2, 3]), /<svg class="spark"/);
});

// ---- built page (CI builds before npm test) ----
const DIST = join(ROOT, "dist");
const built = existsSync(join(DIST, "admin.html"));
test("/admin is noindex, unlinked, and kept out of the sitemap and llms files", { skip: !built && "dist/ not built" }, () => {
  const html = readFileSync(join(DIST, "admin.html"), "utf8");
  assert.match(html, /<meta name="robots" content="noindex"/);
  for (const f of ["sitemap-0.xml", "llms.txt", "llms-full.txt"]) {
    if (existsSync(join(DIST, f))) assert.ok(!/\/admin\b/.test(readFileSync(join(DIST, f), "utf8")), `${f} mentions /admin`);
  }
  for (const f of ["index.html", "hummingbird-hut.html", "shows.html", "404.html"]) {
    if (existsSync(join(DIST, f))) assert.ok(!/href="\/admin/.test(readFileSync(join(DIST, f), "utf8")), `${f} links /admin`);
  }
  // The embedded build data carries show names and dates only, never a venue street address.
  const data = html.match(/<script type="application\/json" id="adm-data">([\s\S]*?)<\/script>/)[1];
  assert.ok(!/street|postalCode|\b9\d{4}\b/.test(data));
});

// ---- follow-up: private hosts, continued visits, the weekly report ----
const MD = await import("../src/lib/admin/markdown.ts");
const DG = await import("../src/lib/admin/digests.ts");
const { demoDigests } = await import("../src/lib/admin/demo.ts");

test("hosts that could point at the studio's own network are never shown", () => {
  for (const h of ["hummingbird-nas.synology.me", "HummingbirdHut.local", "studio.quickconnect.to", "nas.myds.me", "scott.ddns.net", "something-ddns.example.com",
    "192.168.1.20", "10.0.0.5:5000", "localhost", "localhost:4321", "[::1]", "fe80::1", "router.lan", "nas.home"]) {
    assert.equal(A.isPrivateHost(h), true, h);
    assert.equal(A.hostLabel(h), "hidden", h);
  }
  for (const h of ["www.google.com", "thedeluxesf.com", "do510.com", "chatgpt.com", "l.instagram.com", "", "bandcamp.com"]) assert.equal(A.isPrivateHost(h), false, h);
  const v = A.buildVisits([hit({ sid: "p", first: true, src: "referral", ref: "hummingbird-nas.synology.me" }), hit({ sid: "p", at: 1, ev: "outbound", lbl: "192.168.1.9" })]);
  assert.equal(A.visitOrigin(v[0]), "hidden");
  assert.deepEqual(A.referrers(v).map((r) => r.label), ["hidden"]);
  assert.deepEqual(A.attention(v).outbound.map((r) => r.label), ["hidden"]);
  assert.equal(A.journeys(v)[0].steps[1].text, "Outbound link: hidden");
  assert.equal(A.prettySource("nas.myds.me"), "hidden");
});

test("a visit counts only when its sid has a first:true page view; reloads are continued visits", () => {
  const hits = [
    ...HITS,
    hit({ sid: "reload1", at: 3, path: "/book-the-hut", first: false, src: "ai", ref: "chatgpt.com", land: "/hummingbird-hut" }),
    hit({ sid: "reload1", at: 4, path: "/book-the-hut", first: false, src: "ai", ev: "play", lbl: "x" }),
    hit({ sid: "tab2", at: 70, path: "/shows", first: false, src: "campaign", us: "instagram", uc: "the-deluxe" }),
  ];
  const s = A.splitVisits(hits);
  assert.deepEqual(s.counted.map((v) => v.sid), ["a", "b", "c", "d"]);
  assert.deepEqual(s.continued.map((v) => v.sid), ["reload1", "tab2"]);
  assert.equal(A.buildVisits(hits).length, 4, "buildVisits returns counted visits only");
  assert.equal(A.summarize(A.buildVisits(hits)).visits, 4);
  assert.equal(A.summarize(A.buildVisits(hits)).interest, 2, "events on a continued sid don't inflate interest");
  // but someone reloading is still on the site right now
  assert.ok(A.liveNow(hits, T0 + 71 * min).some((l) => l.sid === "tab2"));
  // a hit with no usable first flag is not counted either
  assert.equal(A.buildVisits([{ ...hit({ sid: "q" }), first: "yes" }]).length, 0);
});

test("Markdown digest renders safely: headings, tables, lists, bold; HTML escaped; only http(s) links", () => {
  const html = MD.renderMarkdown([
    "## Site analytics: Oct 18 to Oct 25", "", "**233 visits** (+88%) · _quiet_", "", "### What changed", "", "- Visits were up 88%.", "- <script>alert(1)</script> stays text.", "",
    "| Source | Visits | Change |", "| --- | ---: | :---: |", "| Search | 54 | +74% |", "| AI & friends | 30 | +150% |", "",
    "1. first", "2. second", "", "[good](https://example.com/x?a=1) [bad](javascript:alert(1)) <a href=\"x\">raw</a>", "", "---", "", "> quoted",
  ].join("\n"));
  assert.match(html, /<h3>Site analytics: Oct 18 to Oct 25<\/h3>/);
  assert.match(html, /<h4>What changed<\/h4>/);
  assert.match(html, /<strong>233 visits<\/strong> \(\+88%\) · <em>quiet<\/em>/);
  assert.match(html, /<ul><li>Visits were up 88%\.<\/li><li>&lt;script&gt;alert\(1\)&lt;\/script&gt; stays text\.<\/li><\/ul>/);
  assert.match(html, /<th>Source<\/th><th style="text-align:right">Visits<\/th><th style="text-align:center">Change<\/th>/);
  assert.match(html, /<td>AI &amp; friends<\/td><td style="text-align:right">30<\/td>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<a href="https:\/\/example.com\/x\?a=1" rel="noopener" target="_blank">good<\/a>/);
  assert.ok(html.includes("[bad](javascript:alert(1))"), "javascript: link stays plain text");
  assert.ok(html.includes("&lt;a href=&quot;x&quot;&gt;raw&lt;/a&gt;"), "raw HTML is escaped");
  assert.ok(!/<script|onerror|javascript:/.test(html.replace(/\[bad\]\(javascript:alert\(1\)\)/, "")));
  assert.match(html, /<hr>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.equal(MD.renderMarkdown(""), "");
  // visitor strings arrive in code spans: nothing inside them is formatted or linked
  assert.equal(MD.inline("Played `**Blue_Monk** [x](https://e.com) <b>`"), "Played <code>**Blue_Monk** [x](https://e.com) &lt;b&gt;</code>");
  assert.match(MD.renderMarkdown("| Track | Plays |\n| --- | ---: |\n| `a|b` | 3 |"), /<td>/);
  // the sample digests (same shape as scripts/analytics-digest.mjs writes) render without leftovers
  const sample = demoDigests(Date.parse("2026-10-25T20:00:00Z"));
  assert.equal(sample.length, 5);
  assert.match(sample[0].id, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(sample[0].id > sample[1].id, "newest first");
  const out = MD.renderMarkdown(sample[0].md);
  assert.ok(!/\|\s*---|\*\*|^#/m.test(out), "no raw Markdown left");
  assert.ok((out.match(/<table>/g) ?? []).length >= 4);
});

test("digests: query, parsing, week labels", () => {
  const q = DG.digestsQuery(10).structuredQuery;
  assert.deepEqual(q.from, [{ collectionId: "digests" }]);
  assert.deepEqual(q.orderBy, [{ field: { fieldPath: "week" }, direction: "DESCENDING" }]);
  assert.equal(DG.digestsQuery().structuredQuery.limit, 12);
  // the shape scripts/analytics-digest.mjs writes
  const doc = (id, md = "## Week\n\ntext", summary = '{"visits":12}') => ({ document: { name: `projects/p/databases/(default)/documents/digests/${id}`, fields: {
    week: { stringValue: id }, from: { timestampValue: `${id}T07:00:00Z` }, to: { timestampValue: "2026-10-20T07:00:00Z" }, generatedAt: { timestampValue: "2026-10-20T06:00:00Z" },
    visits: { integerValue: "12" }, pageViews: { integerValue: "30" }, bookings: { integerValue: "1" }, md: { stringValue: md }, summary: { stringValue: summary } } } });
  const list = DG.parseDigests([doc("2026-10-06", undefined, "not json"), doc("2026-10-13"), doc("2026-09-29", "   "), { readTime: "x" }]);
  assert.deepEqual(list.map((d) => d.id), ["2026-10-13", "2026-10-06"]);
  assert.deepEqual(list[0].summary, { visits: 12 });
  assert.deepEqual(list[1].summary, {}, "bad JSON summary is ignored");
  assert.equal(list[0].createdAt, "2026-10-20T06:00:00Z");
  assert.deepEqual([list[0].visits, list[0].pageViews, list[0].bookings], [12, 30, 1]);
  assert.equal(DG.weekLabel("2026-10-19"), "Oct 19 – Oct 25, 2026");
  assert.equal(DG.weekLabel("latest"), "latest");
});
