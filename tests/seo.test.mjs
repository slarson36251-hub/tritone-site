// Site-wide SEO checks on the built site (run after a build, e.g. with SHOWS_FIXTURE=tests/fixtures/music.ics):
// titles, descriptions, canonicals, share images, parseable JSON-LD, one h1, and no studio address.
//   SHOWS_FIXTURE=tests/fixtures/music.ics npm run build && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { VENUES } = await import("../src/data/venues.ts");
const SITE = "https://tritone-productions.com";
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const built = existsSync(join(DIST, "index.html"));
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const pages = built
  ? walk(DIST)
      .filter((f) => f.endsWith(".html"))
      .map((f) => ({ f: f.slice(DIST.length), html: readFileSync(f, "utf8") }))
      .filter((p) => !/http-equiv="refresh"/.test(p.html)) // legacy show redirects
  : [];
const attr = (html, re) => html.match(re)?.[1];
const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const nodes = (o) => (Array.isArray(o) ? o.flatMap(nodes) : o && typeof o === "object" ? [o, ...Object.values(o).flatMap(nodes)] : []);
const fileFor = (url) => join(DIST, decodeURI(new URL(url).pathname));
const venueAddr = new Set(VENUES.filter((v) => v.street).map((v) => `${v.street}|${v.postalCode}`));

test("dist/ is built", () => assert.ok(built, "run npm run build first"));

test("every page has one title, a 70-170 char description and a clean canonical", () => {
  const titles = new Map();
  for (const { f, html } of pages) {
    const t = [...html.matchAll(/<title>([^<]*)<\/title>/g)];
    assert.equal(t.length, 1, `${f}: exactly one <title>`);
    assert.ok(t[0][1].trim().length >= 15, `${f}: title too short`);
    const d = [...html.matchAll(/<meta name="description" content="([^"]*)"/g)];
    assert.equal(d.length, 1, `${f}: one meta description`);
    const len = decode(d[0][1]).length;
    assert.ok(len >= 70 && len <= 170, `${f}: description is ${len} chars`);
    const canon = attr(html, /<link rel="canonical" href="([^"]+)"/);
    assert.ok(canon?.startsWith(SITE), `${f}: canonical on ${SITE}`);
    assert.doesNotMatch(canon, /\.html$|.\/$/, `${f}: canonical has no .html or trailing slash`);
    assert.equal(attr(html, /<meta property="og:url" content="([^"]+)"/), canon, `${f}: og:url = canonical`);
    if (f !== "404.html") {
      assert.ok(!titles.has(t[0][1]), `${f}: title duplicates ${titles.get(t[0][1])}`);
      titles.set(t[0][1], f);
    }
  }
});

test("canonicals match built files", () => {
  for (const { f, html } of pages) {
    if (f === "404.html") continue;
    const path = new URL(attr(html, /<link rel="canonical" href="([^"]+)"/)).pathname;
    assert.equal(path === "/" ? "index.html" : `${path.slice(1)}.html`, f, `${f}: canonical points at itself`);
  }
});

test("every page has social tags and an og:image that exists in dist/", () => {
  for (const { f, html } of pages) {
    const img = attr(html, /<meta property="og:image" content="([^"]+)"/);
    assert.ok(img, `${f}: og:image`);
    if (img.startsWith(SITE)) assert.ok(existsSync(fileFor(img)), `${f}: og:image ${img} missing from dist/`);
    else assert.match(img, /^https:\/\//, `${f}: og:image absolute https`);
    for (const re of [/<meta name="twitter:card" content="summary_large_image"/, /<meta property="og:locale" content="en_US"/,
      /<meta property="og:site_name" content="Tritone Productions"/, /<meta name="theme-color"/, /<html lang="en"/])
      assert.match(html, re, `${f}: ${re}`);
  }
});

test("generated share cards are 1200x630 PNGs", () => {
  const cards = walk(join(DIST, "og/pages"));
  assert.ok(cards.length >= 10, "page cards generated");
  for (const c of cards) {
    const b = readFileSync(c);
    assert.equal(b.readUInt32BE(16), 1200, `${c}: width`);
    assert.equal(b.readUInt32BE(20), 630, `${c}: height`);
  }
});

// TODO: drop once the /sessions rebuild lands (the current page has one <h1> per session).
const H1_PENDING = new Set([]);

test("every page has exactly one h1 and no skipped heading levels", () => {
  for (const { f, html } of pages) {
    if (H1_PENDING.has(f)) continue;
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    const h1s = levels.filter((l) => l === 1).length;
    // noindex utility pages (e.g. /upload) may swap between panels that each carry their own h1.
    if (/<meta name="robots" content="noindex/.test(html)) assert.ok(h1s >= 1, `${f}: an <h1>`);
    else assert.equal(h1s, 1, `${f}: one <h1>`);
    assert.equal(levels[0], 1, `${f}: h1 comes first`);
    levels.forEach((l, i) => i && assert.ok(l <= levels[i - 1] + 1, `${f}: h${levels[i - 1]} followed by h${l}`));
  }
});

test("every <img> has alt text", () => {
  for (const { f, html } of pages)
    for (const [img] of html.matchAll(/<img\b[^>]*>/g)) assert.match(img, /\balt(=|[\s>])/, `${f}: ${img.slice(0, 80)}`);
});

test("JSON-LD parses, and every page has the Organization and WebSite", () => {
  for (const { f, html } of pages) {
    const all = nodes(ldBlocks(html).map((b) => JSON.parse(b)));
    const org = all.find((n) => n["@type"] === "Organization" && n.name === "Tritone Productions");
    assert.ok(org, `${f}: Organization`);
    assert.deepEqual(org.address, { "@type": "PostalAddress", addressLocality: "Oakland", addressRegion: "CA", addressCountry: "US" });
    assert.ok(existsSync(fileFor(org.logo.url)), `${f}: logo file`);
    assert.ok(org.sameAs.length >= 3, `${f}: sameAs socials`);
    assert.ok(all.some((n) => n["@type"] === "WebSite"), `${f}: WebSite`);
    assert.ok(all.filter((n) => n["@type"] === "BreadcrumbList").length <= 1, `${f}: at most one BreadcrumbList`);
  }
});

test("no street address, postal code or geo outside public-venue MusicEvents", () => {
  for (const { f, html } of pages) {
    for (const b of ldBlocks(html)) {
      const check = (o, inVenue) => {
        if (Array.isArray(o)) return o.forEach((x) => check(x, inVenue));
        if (!o || typeof o !== "object") return;
        assert.ok(!("geo" in o), `${f}: geo`);
        if ("streetAddress" in o || "postalCode" in o) {
          assert.ok(inVenue, `${f}: address outside a MusicEvent location`);
          assert.ok(venueAddr.has(`${o.streetAddress}|${o.postalCode}`), `${f}: ${o.streetAddress} is not in src/data/venues.ts`);
        }
        for (const [k, v] of Object.entries(o)) check(v, inVenue || (o["@type"] === "MusicEvent" && k === "location"));
      };
      check(JSON.parse(b), false);
    }
    const text = html.replace(/<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, "");
    assert.doesNotMatch(text, /"(streetAddress|postalCode|geo)"\s*:/, `${f}: address keys outside JSON-LD`);
  }
});

test("the Hummingbird Hut page describes the studio as a service, city only", () => {
  const html = pages.find((p) => p.f === "hummingbird-hut.html").html;
  const hut = nodes(ldBlocks(html).map((b) => JSON.parse(b))).find((n) => n["@type"] === "ProfessionalService");
  assert.equal(hut?.name, "Hummingbird Hut");
  assert.equal(hut.address.addressLocality, "Oakland");
  assert.deepEqual(Object.keys(hut.address).sort(), ["@type", "addressCountry", "addressLocality", "addressRegion"]);
  assert.ok(hut.parentOrganization, "parentOrganization");
  assert.ok(existsSync(fileFor(hut.image)), "studio image in dist/");
  const offers = hut.makesOffer.map((o) => o.itemOffered.name);
  for (const s of ["Tracking", "Overdubs", "Mixing", "Mastering prep"]) assert.ok(offers.includes(s), s);
});

test("band pages carry a MusicGroup with members, tracks with real audio, and breadcrumbs", () => {
  const bandPages = pages.filter((p) => /^bands\/[^/]+\.html$/.test(p.f));
  assert.ok(bandPages.length >= 5);
  for (const { f, html } of bandPages) {
    const all = nodes(ldBlocks(html).map((b) => JSON.parse(b)));
    const groups = all.filter((n) => n["@type"] === "MusicGroup");
    assert.equal(groups.length, 1, `${f}: one MusicGroup`);
    const g = groups[0];
    assert.ok(g.name && g.url && g.image, `${f}: name, url, image`);
    assert.ok(existsSync(fileFor(g.image)), `${f}: MusicGroup image ${g.image} missing from dist/`);
    for (const t of g.track ?? []) {
      assert.equal(t["@type"], "MusicRecording");
      if (t.audio) assert.ok(existsSync(fileFor(t.audio.contentUrl)), `${f}: ${t.audio.contentUrl} missing`);
    }
    const crumbs = all.find((n) => n["@type"] === "BreadcrumbList");
    assert.equal(crumbs?.itemListElement.length, 3, `${f}: Home > Bands > band`);
  }
});

test("sitemap lists the real pages and none of the noindex ones", () => {
  const xml = readdirSync(DIST).filter((f) => /^sitemap-\d+\.xml$/.test(f)).map((f) => readFileSync(join(DIST, f), "utf8")).join("");
  const locs = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  for (const p of ["", "/hummingbird-hut", "/book-the-hut", "/bands", "/gallery", "/contact", "/shows", "/bands/hard-bop-quintet"])
    assert.ok(locs.has(SITE + p), `sitemap has ${SITE + p}`);
  for (const p of ["/upload", "/free-track", "/404"]) assert.ok(!locs.has(SITE + p), `sitemap omits ${p}`);
  for (const { f, html } of pages)
    if (/<meta name="robots" content="noindex/.test(html)) assert.ok(![...locs].some((l) => l.endsWith("/" + f.replace(/\.html$/, ""))), `${f} is noindex but in the sitemap`);
});

test("llms.txt is published and names Oakland, CA only", () => {
  const txt = readFileSync(join(DIST, "llms.txt"), "utf8");
  assert.match(txt, /^# Tritone Productions/);
  assert.match(txt, /Oakland, CA/);
  assert.doesNotMatch(txt, /\b9\d{4}\b|\b\d+\s+\w+\s+(St|Street|Ave|Avenue|Blvd|Way|Rd|Road)\b/i);
});
