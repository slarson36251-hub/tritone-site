// Checks the built show pages (run after a build, e.g. with SHOWS_FIXTURE=tests/fixtures/music.ics):
// every show page carries one Google-ready MusicEvent, addresses only for listed public venues,
// and nothing private from the calendar reaches dist/.
//   SHOWS_FIXTURE=tests/fixtures/music.ics npx astro build && node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const { VENUES } = await import("../src/data/venues.ts");
const DIST = new URL("../dist/", import.meta.url);
const read = (p) => readFileSync(new URL(p, DIST), "utf8");
const ld = (html) =>
  [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap((m) => [JSON.parse(m[1])].flat());
const OFFSET = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})?$/;

const built = existsSync(new URL("shows.html", DIST));
const pages = built
  ? readdirSync(new URL("shows/", DIST)).filter((f) => f.endsWith(".html")).map((f) => ({ f, html: read(`shows/${f}`) }))
  : [];
const showPages = pages.filter((p) => !/http-equiv="refresh"/.test(p.html));
const fixture = !!process.env.SHOWS_FIXTURE || existsSync(new URL("shows/hard-bop-quintet-dawn-club-san-francisco-2026-11-05.html", DIST));

test("dist/ is built", () => assert.ok(built, "run astro build first"));

test("each show page has exactly one valid MusicEvent", () => {
  for (const { f, html } of showPages) {
    const events = ld(html).filter((o) => o["@type"] === "MusicEvent");
    assert.equal(events.length, 1, `${f}: one MusicEvent`);
    const e = events[0];
    assert.ok(e.name, `${f}: name`);
    assert.match(e.startDate, OFFSET, `${f}: startDate with offset`);
    assert.doesNotMatch(e.startDate, /Z$/, `${f}: startDate not UTC Z`);
    assert.match(e.endDate, OFFSET, `${f}: endDate`);
    assert.match(e.eventStatus, /^https:\/\/schema\.org\/Event(Scheduled|Cancelled|Rescheduled)$/, `${f}: eventStatus`);
    assert.equal(e.eventAttendanceMode, "https://schema.org/OfflineEventAttendanceMode");
    assert.equal(e.location?.["@type"], "Place");
    assert.ok(e.location?.name, `${f}: location.name`);
    assert.ok(e.location?.address?.addressLocality, `${f}: location.address.addressLocality`);
    assert.ok(Array.isArray(e.image) && e.image[0]?.startsWith("https://"), `${f}: image`);
    assert.ok(e.performer?.name, `${f}: performer`);
    assert.equal(e.organizer?.name, "Tritone Productions");
    if (e.offers) assert.ok(e.offers.url?.startsWith("http"), `${f}: offers.url`);
  }
});

test("street addresses only for listed public venues; never for the Hut", () => {
  const ok = new Set(VENUES.filter((v) => v.street).map((v) => `${v.name}|${v.street}|${v.postalCode}`));
  for (const { f, html } of showPages) {
    const e = ld(html).find((o) => o["@type"] === "MusicEvent");
    const a = e.location.address;
    if (a.streetAddress || a.postalCode) assert.ok(ok.has(`${e.location.name}|${a.streetAddress}|${a.postalCode}`), `${f}: unlisted address`);
    if (/hummingbird/i.test(e.location.name)) assert.ok(!a.streetAddress && !a.postalCode, `${f}: Hut address`);
    assert.doesNotMatch(html, /hummingbird[^<]{0,80}\d+\s+\w+\s+(st|ave|way|blvd|rd)\b/i, `${f}: Hut near a street`);
  }
});

test("/shows lists show pages as an ItemList", () => {
  const list = ld(read("shows.html")).find((o) => o["@type"] === "ItemList");
  assert.ok(list, "ItemList");
  for (const item of list.itemListElement) {
    const slug = new URL(item.url).pathname.replace(/^\//, "");
    assert.ok(existsSync(new URL(`${slug}.html`, DIST)), `${item.url} is built`);
  }
});

test("legacy /shows/nick-culp-quartet forwards", () => {
  const html = read("shows/nick-culp-quartet.html");
  const to = html.match(/content="0;url=([^"]+)"/)?.[1];
  assert.ok(to, "meta refresh");
  assert.ok(to === "/shows" || existsSync(new URL(`${to.slice(1)}.html`, DIST)), `target ${to} exists`);
});

test("fixture: private and personal entries never reach dist/", { skip: !fixture }, () => {
  const all = readdirSync(DIST, { recursive: true })
    .filter((f) => /\.(html|ics|xml|txt|json)$/.test(f))
    .map((f) => read(f))
    .join("\n");
  for (const bad of ["Pick up Madi", "Evergreen", "Antigen", "Private Way", "4321 Example", "Holiday Party", "Rehearsal", "[TEMPLATE]", "Terry's", "94618", "94619", "94610"])
    assert.ok(!all.includes(bad), `found "${bad}" in dist`);
  assert.ok(existsSync(new URL("shows/scott-larson-quartet-club-deluxe-san-francisco-2026-11-08.html", DIST)));
  const deluxe = ld(read("shows/scott-larson-quartet-club-deluxe-san-francisco-2026-11-08.html")).find((o) => o["@type"] === "MusicEvent");
  assert.equal(deluxe.location.address.streetAddress, "1511 Haight St");
  assert.equal(deluxe.offers.price, "5.00");
  const moved = ld(read("shows/nick-culp-quartet-low-bar-oakland-2026-12-03.html")).find((o) => o["@type"] === "MusicEvent");
  assert.equal(moved.eventStatus, "https://schema.org/EventRescheduled");
  assert.equal(moved.sameAs, "https://www.example.com/lowbar/nick-culp-quartet");
  assert.equal(moved.offers.url, moved.sameAs);
  assert.match(read("shows/hard-bop-quintet-ivy-room-albany-2025-08-15.html"), /<meta name="robots" content="noindex"/);
  assert.ok(!read("sitemap-0.xml").includes("2025-08-15"), "old past show not in sitemap");
});
