// Cross-checks each upcoming show against the venue's own listing.
// For every built show page whose event has a "venue page:" line (Event sameAs),
// fetch that page and report whether the band's name appears on it.
//
// Run on a Mac with network, after a build:
//   npm run build && node scripts/check-venue-listings.mjs
// Read-only: it only fetches public venue pages. Exit code 1 if any listing is missing the band.
import { readdirSync, readFileSync } from "node:fs";

const DIST = new URL("../dist/shows/", import.meta.url);
const now = Date.now();
const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&amp;|&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

const shows = [];
for (const f of readdirSync(DIST).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(new URL(f, DIST), "utf8");
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    for (const o of [JSON.parse(m[1])].flat()) {
      if (o["@type"] === "MusicEvent" && o.sameAs && new Date(o.endDate).getTime() > now) shows.push(o);
    }
  }
}
if (!shows.length) {
  console.log("No upcoming shows with a 'venue page:' line. Add one to an event's description to cross-check it.");
  process.exit(0);
}

let missing = 0;
for (const e of shows.sort((a, b) => a.startDate.localeCompare(b.startDate))) {
  const band = e.performer?.name ?? e.name;
  let status;
  try {
    const res = await fetch(e.sameAs, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "TritoneVenueCheck/1.0 (+https://tritone-productions.com)" } });
    const text = norm((await res.text()).replace(/<[^>]+>/g, " "));
    if (!res.ok) status = `HTTP ${res.status}`;
    else status = text.includes(norm(band)) ? "listed" : "BAND NOT FOUND";
  } catch (err) {
    status = `fetch failed (${err.cause?.code ?? err.message})`;
  }
  if (status !== "listed") missing++;
  console.log(`${status.padEnd(16)} ${e.startDate.slice(0, 10)}  ${band} @ ${e.location?.name}  ${e.sameAs}`);
}
console.log(`\n${shows.length - missing}/${shows.length} venue listings mention the band.`);
process.exit(missing ? 1 : 0);
