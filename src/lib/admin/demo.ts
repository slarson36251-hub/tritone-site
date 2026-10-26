// ?demo=1: a realistic, generated sample of "hits" so the dashboard can be previewed and
// screenshotted without signing in. Deterministic for a given seed and clock. Nothing here is real.
import type { EventName, Hit, Source } from "../analytics-schema.ts";

export interface DemoShow { slug: string; title: string; band: string; venue: string; start: number }
export interface DemoInput { now: number; days?: number; seed?: number; shows?: DemoShow[]; bands?: { slug: string; name: string }[]; tracks?: string[] }

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickW<T>(r: () => number, items: [T, number][]): T {
  const total = items.reduce((n, [, w]) => n + w, 0);
  let x = r() * total;
  for (const [it, w] of items) if ((x -= w) <= 0) return it;
  return items[items.length - 1][0];
}

const DAY = 864e5;

/** Shows to use in the demo: the real calendar's when there are any near now, else plausible ones. */
export function demoShows(now: number, real: DemoShow[] = [], bands: { slug: string; name: string }[] = []): DemoShow[] {
  const near = real.filter((s) => s.start > now - 120 * DAY && s.start < now + 60 * DAY);
  if (near.length >= 3) return near;
  const b = (i: number) => bands[i % Math.max(1, bands.length)]?.name ?? ["Franco Nero", "Hard Bop Quintet", "Lucky 7"][i % 3];
  const mk = (days: number, band: string, venue: string): DemoShow => {
    const d = new Date(now + days * DAY);
    d.setHours(20, 0, 0, 0);
    const iso = d.toISOString().slice(0, 10);
    const slug = `${band}-${venue}-${iso}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return { slug, title: `${band} at ${venue}`, band, venue, start: d.getTime() };
  };
  return [mk(-75, b(0), "The DeLuxe"), mk(-47, b(1), "Low Bar"), mk(-19, b(2), "The Sound Room"), mk(-4, b(0), "Rite Spot Cafe"), mk(9, b(1), "The DeLuxe"), mk(23, b(3), "Ivy Room")];
}

const AI: [string, number][] = [["chatgpt.com", 52], ["perplexity.ai", 18], ["claude.ai", 13], ["gemini.google.com", 9], ["copilot.microsoft.com", 6], ["chat.deepseek.com", 2]];
const SEARCH: [string, number][] = [["www.google.com", 82], ["www.bing.com", 7], ["duckduckgo.com", 8], ["search.yahoo.com", 3]];
const SOCIAL: [string, number][] = [["l.instagram.com", 52], ["m.facebook.com", 26], ["www.reddit.com", 7], ["www.youtube.com", 9], ["t.co", 3], ["www.threads.net", 3]];
const REFERRAL: [string, number][] = [["bandcamp.com", 22], ["do510.com", 18], ["thedeluxesf.com", 16], ["www.lowbaroakland.com", 10], ["soundcloud.com", 10], ["linktr.ee", 14], ["sfstation.com", 10]];
const TZ: [string, number][] = [
  ["America/Los_Angeles", 70], ["America/New_York", 8], ["America/Chicago", 5], ["America/Denver", 3], ["America/Phoenix", 1],
  ["Europe/London", 3], ["Europe/Berlin", 2], ["America/Toronto", 2], ["Asia/Tokyo", 1], ["Australia/Sydney", 1], ["America/Mexico_City", 1], ["Pacific/Honolulu", 1],
];

/** Sample weekly digests for ?demo=1, in the shape scripts/analytics-digest.mjs writes. */
export function demoDigests(now: number): { id: string; week: string; md: string; createdAt: string; summary: Record<string, unknown>; visits: number; pageViews: number; bookings: number }[] {
  const out = [];
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const r = rng(11);
  for (let w = 1; w <= 5; w++) {
    const start = new Date(monday.getTime() - w * 7 * DAY);
    const end = new Date(start.getTime() + 6 * DAY);
    const id = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const visits = Math.round(190 + (5 - w) * 22 + r() * 30), prev = Math.round(visits * (0.78 + r() * 0.3));
    const pv = Math.round(visits * 2.1), books = Math.round(2 + r() * 4), ai = Math.round(visits * (0.11 + w * 0.004));
    const pct = (a: number, b: number) => `${a >= b ? "+" : "-"}${Math.round((Math.abs(a - b) / Math.max(1, b)) * 100)}%`;
    const md = `## Site analytics: ${f(start)} to ${f(end)}

**${visits} visits** (${pct(visits, prev)}) · **${pv} page views** (${pct(pv, Math.round(prev * 2.1))}) · **${books} booking requests**

### What changed

- Visits were ${visits >= prev ? "up" : "down"} ${pct(visits, prev).slice(1)} at ${visits} (from ${prev}), with ${pv} page views.
- Search brought ${Math.round(visits * 0.24)} visits, ${visits >= prev ? "up" : "down"} from ${Math.round(prev * 0.22)}.
- AI assistants accounted for ${Math.round((ai / visits) * 100)}% of visits (${ai}), mostly from chatgpt.com.
- ${books} Book the Hut requests came in (${Math.ceil(books / 2)} from AI assistants, ${Math.floor(books / 2)} from Outreach links), against ${Math.max(0, books - 1)} the week before.
- /hummingbird-hut got ${Math.round(visits * 0.3)} views, up from ${Math.round(prev * 0.26)}, the biggest jump of any page.

### Where visits came from

| Source | Visits | Last week | Change | Share |
| --- | ---: | ---: | ---: | ---: |
| Search | ${Math.round(visits * 0.24)} | ${Math.round(prev * 0.22)} | ${pct(visits * 0.24, prev * 0.22)} | 24% |
| Direct / typed | ${Math.round(visits * 0.2)} | ${Math.round(prev * 0.21)} | ${pct(visits * 0.2, prev * 0.21)} | 20% |
| Outreach links | ${Math.round(visits * 0.18)} | ${Math.round(prev * 0.15)} | ${pct(visits * 0.18, prev * 0.15)} | 18% |
| Social | ${Math.round(visits * 0.15)} | ${Math.round(prev * 0.16)} | ${pct(visits * 0.15, prev * 0.16)} | 15% |
| AI assistants | ${ai} | ${Math.round(prev * 0.1)} | ${pct(ai, prev * 0.1)} | ${Math.round((ai / visits) * 100)}% |
| Other sites | ${Math.round(visits * 0.08)} | ${Math.round(prev * 0.1)} | ${pct(visits * 0.08, prev * 0.1)} | 8% |
| Email | ${Math.round(visits * 0.03)} | ${Math.round(prev * 0.04)} | ${pct(visits * 0.03, prev * 0.04)} | 3% |

### AI assistants

| Assistant | Visits | Last week |
| --- | ---: | ---: |
| chatgpt.com | ${Math.round(ai * 0.5)} | ${Math.round(prev * 0.05)} |
| perplexity.ai | ${Math.round(ai * 0.2)} | ${Math.round(prev * 0.02)} |
| claude.ai | ${Math.round(ai * 0.15)} | ${Math.round(prev * 0.015)} |
| gemini.google.com | ${Math.round(ai * 0.1)} | ${Math.round(prev * 0.01)} |

### Top pages

| Page | Views | Last week | Change |
| --- | ---: | ---: | ---: |
| / | ${Math.round(pv * 0.22)} | ${Math.round(prev * 0.45)} | ${pct(pv * 0.22, prev * 0.45)} |
| /hummingbird-hut | ${Math.round(visits * 0.3)} | ${Math.round(prev * 0.26)} | ${pct(visits * 0.3, prev * 0.26)} |
| /book-the-hut | ${Math.round(pv * 0.12)} | ${Math.round(prev * 0.24)} | ${pct(pv * 0.12, prev * 0.24)} |
| /shows | ${Math.round(pv * 0.11)} | ${Math.round(prev * 0.25)} | ${pct(pv * 0.11, prev * 0.25)} |
| /listen | ${Math.round(pv * 0.08)} | ${Math.round(prev * 0.17)} | ${pct(pv * 0.08, prev * 0.17)} |

### Interest

| Action | This week | Last week | Change |
| --- | ---: | ---: | ---: |
| Booking requests | ${books} | ${Math.max(0, books - 1)} | ${books - 1 > 0 ? pct(books, books - 1) : "new"} |
| Show clicks | ${Math.round(visits * 0.13)} | ${Math.round(prev * 0.11)} | ${pct(visits * 0.13, prev * 0.11)} |
| Ticket / venue clicks | ${Math.round(visits * 0.09)} | ${Math.round(prev * 0.08)} | ${pct(visits * 0.09, prev * 0.08)} |
| Listening plays | ${Math.round(visits * 0.1)} | ${Math.round(prev * 0.1)} | ${pct(visits * 0.1, prev * 0.1)} |
| Poster views | ${Math.round(visits * 0.12)} | ${Math.round(prev * 0.1)} | ${pct(visits * 0.12, prev * 0.1)} |

### Details

**Most played:** Caffeine (${Math.round(8 + r() * 6)}), Pacifica (${Math.round(4 + r() * 5)}), Garden of Love (${Math.round(2 + r() * 4)})

**Top outbound sites:** bandcamp.com (${Math.round(3 + r() * 4)}), www.instagram.com (${Math.round(1 + r() * 3)})

_Devices: phone ${60 + Math.round(r() * 8)}% · tablet 5% · desktop ${30 + Math.round(r() * 5)}%. Visits are counted without cookies: one visit per page load and its in-site navigation. Scott's own devices are excluded once he has opened /admin._
`;
    out.push({ id, week: id, md, createdAt: new Date(start.getTime() + 7 * DAY + 6 * 3600e3).toISOString(), summary: { visits, pageViews: pv, bookings: books }, visits, pageViews: pv, bookings: books });
  }
  return out;
}

export function generateDemo(input: DemoInput): { hits: Hit[]; shows: DemoShow[] } {
  const r = rng(input.seed ?? 7);
  const now = input.now;
  const days = input.days ?? 190;
  const bands = input.bands?.length ? input.bands : [{ slug: "franco-nero", name: "Franco Nero" }, { slug: "hard-bop-quintet", name: "Hard Bop Quintet" }];
  const tracks = input.tracks?.length ? input.tracks : ["Uptown Dub", "Blue Monk", "Lucky 7 Stomp", "Slow Burn"];
  const shows = demoShows(now, input.shows, bands);
  const hits: Hit[] = [];
  const sidChars = "abcdefghijkmnpqrstuvwxyz23456789";
  const sid = () => Array.from({ length: 12 }, () => sidChars[Math.floor(r() * sidChars.length)]).join("");

  const campaignsFor = (t: number): { uc: string; us: string; um: string; path: string; w: number }[] => {
    const out: { uc: string; us: string; um: string; path: string; w: number }[] = [];
    for (const s of shows) {
      const until = s.start - t;
      if (until > -DAY && until < 21 * DAY) {
        const venue = s.venue.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        out.push({ uc: venue, us: "instagram", um: "social", path: `/shows/${s.slug}`, w: 6 });
        out.push({ uc: venue, us: "poster", um: "qr", path: `/shows/${s.slug}`, w: 2.5 });
        out.push({ uc: venue, us: venue, um: "referral", path: `/shows/${s.slug}`, w: 1.5 });
      }
    }
    if (now - t < 40 * DAY) out.push({ uc: "hut-open-house", us: "flyer", um: "qr", path: "/book-the-hut", w: 3 });
    if (now - t < 100 * DAY) out.push({ uc: "fall-recording-special", us: "instagram", um: "bio", path: "/hummingbird-hut", w: 2 });
    out.push({ uc: "linktree", us: "instagram", um: "bio", path: "/", w: 1 });
    return out;
  };

  const start0 = new Date(now - days * DAY);
  start0.setHours(0, 0, 0, 0);
  for (let day = start0.getTime(); day < now; day += DAY) {
    const progress = (day - start0.getTime()) / (now - start0.getTime());
    const dow = new Date(day).getDay();
    let n = 9 + 15 * progress + (dow === 5 || dow === 6 ? 5 : dow === 0 ? 2 : 0);
    let showBoost: DemoShow | undefined;
    for (const s of shows) {
      const until = (s.start - day) / DAY;
      if (until >= -0.5 && until < 1) { n *= 2.1; showBoost = s; }
      else if (until >= 1 && until < 4) { n *= 1.35; showBoost = s; }
    }
    n = Math.round(n * (0.8 + r() * 0.4));
    const isToday = now - day < DAY;
    if (isToday) n = Math.round((n * (now - day)) / DAY);
    const aiW = 5 + 14 * progress;

    for (let i = 0; i < n; i++) {
      // time of day: afternoon/evening heavy, local clock
      const hour = pickW(r, [[9, 2], [11, 4], [13, 5], [15, 5], [17, 6], [19, 7], [21, 6], [23, 2], [1, 1], [7, 1]]);
      let t = day + (hour + r() * 2) * 3600e3;
      if (t >= now) t = now - r() * 6 * 3600e3;
      if (t < day) continue;
      const camps = campaignsFor(t);
      const src = pickW<Source>(r, [["ai", aiW], ["search", 30], ["social", 18], ["email", 3], ["campaign", camps.length ? 6 + camps.reduce((a, c) => a + c.w, 0) * 0.8 : 0], ["referral", 8], ["direct", 22]]);
      let ref = "", us = "", um = "", uc = "", ux = "", land = "/";
      const showLand = showBoost && r() < 0.6 ? `/shows/${showBoost.slug}` : "/shows";
      switch (src) {
        case "ai":
          ref = pickW(r, AI);
          if (ref === "chatgpt.com" && r() < 0.5) { us = "chatgpt.com"; ref = r() < 0.5 ? "" : ref; }
          land = pickW(r, [["/hummingbird-hut", 40], ["/book-the-hut", 18], ["/", 16], ["/sessions", 10], ["/bands", 6], ["/shows", 6], ["/contact", 4]]);
          break;
        case "search":
          ref = pickW(r, SEARCH);
          land = pickW(r, [["/", 34], ["/hummingbird-hut", 24], [`/bands/${bands[0].slug}`, 10], ["/shows", 10], ["/sessions", 8], ["/listen", 6], ["/book-the-hut", 8]]);
          break;
        case "social":
          ref = pickW(r, SOCIAL);
          land = pickW(r, [[showLand, 40], ["/listen", 16], ["/", 18], ["/sessions", 12], ["/gallery", 8], ["/hummingbird-hut", 6]]);
          break;
        case "email":
          us = "newsletter"; um = "email"; uc = progress > 0.7 ? "october-news" : "summer-news";
          ref = r() < 0.4 ? "mail.google.com" : "";
          land = pickW(r, [["/shows", 50], ["/free-track", 30], ["/", 20]]);
          break;
        case "campaign": {
          const c = pickW(r, camps.map((x) => [x, x.w] as [typeof x, number]));
          uc = c.uc; us = c.us; um = c.um; land = c.path;
          if (us === "poster" && r() < 0.5) ux = "window-poster";
          ref = us === "instagram" ? "l.instagram.com" : um === "referral" ? "thedeluxesf.com" : "";
          break;
        }
        case "referral":
          ref = pickW(r, REFERRAL);
          land = /bandcamp|soundcloud/.test(ref) ? "/listen" : /deluxe|lowbar|do510|sfstation/.test(ref) ? showLand : "/";
          break;
        default:
          land = pickW(r, [["/", 70], ["/book-the-hut", 12], ["/shows", 10], ["/hummingbird-hut", 8]]);
      }
      const dev = pickW<Hit["dev"]>(r, [["m", src === "ai" || src === "search" ? 50 : 70], ["d", src === "ai" ? 44 : 26], ["t", 5]]);
      const tz = pickW(r, TZ);
      const lang = tz.startsWith("Europe/Berlin") ? "de-DE" : tz.startsWith("Asia/Tokyo") ? "ja-JP" : tz.startsWith("America/Mexico") ? "es-MX" : pickW(r, [["en-US", 92], ["en-GB", 3], ["es-US", 3], ["fr-FR", 2]]);
      const id = sid();
      const base = { sid: id, src, ref, us, um, uc, ux, land, dev, tz, lang };
      // Hut-curious traffic converts better; AI visitors arrive already asking about recording.
      const intent = (src === "ai" ? 0.3 : src === "campaign" ? 0.26 : src === "email" ? 0.24 : src === "search" ? 0.15 : 0.1) * (0.8 + progress * 0.4);

      let path = land;
      let tt = t;
      let first = true;
      const pv = (p: string) => { hits.push({ ...base, k: "pv", t: new Date(tt).toISOString(), path: p, first, ev: "", lbl: "" }); first = false; };
      const ev = (name: EventName, lbl: string) => { tt += 4e3 + r() * 40e3; hits.push({ ...base, k: "ev", t: new Date(tt).toISOString(), path, first: false, ev: name, lbl }); };
      const seen = new Set<string>();
      for (let step = 0; step < 7; step++) {
        pv(path);
        seen.add(path);
        // interest on this page
        if (path.startsWith("/shows/")) {
          const slug = path.slice(7);
          if (r() < 0.3) ev("poster_click", slug);
          if (r() < intent * 1.1) ev("ticket_click", slug);
          if (r() < intent * 0.5) ev("calendar_add", slug);
        } else if (path === "/shows" && r() < 0.4) {
          const s = shows.filter((x) => x.start > t - DAY)[0] ?? shows[shows.length - 1];
          ev("show_click", s.slug);
          path = `/shows/${s.slug}`;
          tt += 15e3 + r() * 60e3;
          continue;
        } else if ((path === "/listen" || path.startsWith("/bands/")) && r() < 0.35) {
          ev("play", tracks[Math.floor(r() * tracks.length)]);
          if (r() < 0.15) ev("outbound", pickW(r, [["bandcamp.com", 3], ["open.spotify.com", 2], ["www.instagram.com", 2]]));
        } else if (path === "/book-the-hut") {
          if (r() < intent * 0.3) ev("book_submit", `${pickW(r, [["3", 3], ["4", 4], ["6", 2], ["2", 1]])}h ${pickW(r, [["Tue", 2], ["Wed", 3], ["Thu", 3], ["Sat", 2], ["Mon", 1]])}`);
          else if (r() < intent * 0.15) ev("book_earlier", "");
        } else if (path === "/contact" && r() < 0.4) {
          ev("contact_click", pickW(r, [["email", 3], ["form", 2], ["phone", 1]]));
        } else if (path === "/free-track" && r() < 0.35) {
          ev("free_track", "");
        } else if (path === "/gallery" && r() < 0.3) {
          ev("poster_click", pickW(r, [["return-of-otis-boom-boom-room", 2], ["hard-bop-quintet-club-deluxe", 2], ["dub-cember-holi-daze-ivy-room", 1]]));
        }
        if (r() > (src === "ai" ? 0.62 : 0.52)) break;
        tt += 20e3 + r() * 120e3;
        if (tt > now) break;
        const next: [string, number][] =
          path === "/hummingbird-hut" ? [["/book-the-hut", 5 + intent * 20], ["/sessions", 4], ["/", 1], ["/contact", 1]]
          : path === "/sessions" || path.startsWith("/sessions/") ? [["/book-the-hut", 3 + intent * 10], ["/hummingbird-hut", 3], ["/listen", 2]]
          : path === "/" ? [["/hummingbird-hut", 4], ["/shows", 3], ["/bands", 2], ["/listen", 2], ["/sessions", 2], ["/book-the-hut", 1 + intent * 4]]
          : path === "/bands" ? bands.map((b) => [`/bands/${b.slug}`, 1] as [string, number])
          : path === "/shows" ? [["/", 1], ["/listen", 2], ["/bands", 2], ["/hummingbird-hut", 1]]
          : path.startsWith("/shows/") ? [["/shows", 3], [`/bands/${bands[Math.floor(r() * bands.length)].slug}`, 2], ["/listen", 2], ["/", 1]]
          : [["/", 2], ["/shows", 2], ["/hummingbird-hut", 2], ["/listen", 1], ["/contact", 1], ["/free-track", 0.5], ["/gallery", 0.7]];
        let p = pickW(r, next);
        if (seen.has(p) && r() < 0.7) p = pickW(r, next);
        path = p;
      }
    }
  }
  // Reloads and new tabs: the tracker gives them a fresh sid with first=false, so they must not count.
  for (let i = 0; i < Math.round(hits.length * 0.012); i++) {
    const src = hits[Math.floor(r() * hits.length)];
    if (src.k !== "pv") continue;
    hits.push({ ...src, sid: sid(), first: false, t: new Date(Date.parse(src.t) + 30e3 + r() * 600e3).toISOString() });
  }
  // One stray hit with a referrer the dashboard must never print (it shows "hidden").
  hits.push({ ...hits[0], sid: sid(), first: true, src: "referral", ref: "studio-nas.quickconnect.to", t: new Date(now - 3 * DAY).toISOString() });
  // A few people on the site right now, so "Live now" has something to show.
  for (let i = 0; i < 4; i++) {
    const t = now - (30 + i * 55) * 1e3;
    const id = sid();
    const src = (["ai", "social", "search", "campaign"] as Source[])[i];
    const ref = ["chatgpt.com", "l.instagram.com", "www.google.com", "l.instagram.com"][i];
    const land = ["/hummingbird-hut", shows.find((s) => s.start > now)?.slug ? `/shows/${shows.find((s) => s.start > now)!.slug}` : "/shows", "/", "/book-the-hut"][i];
    const base = { sid: id, src, ref, us: i === 3 ? "instagram" : "", um: i === 3 ? "social" : "", uc: i === 3 ? "hut-open-house" : "", ux: "", land, dev: (i % 2 ? "m" : "d") as Hit["dev"], tz: "America/Los_Angeles", lang: "en-US" };
    hits.push({ ...base, k: "pv", t: new Date(t - 90e3).toISOString(), path: land, first: true, ev: "", lbl: "" });
    if (i === 0) hits.push({ ...base, k: "pv", t: new Date(t).toISOString(), path: "/book-the-hut", first: false, ev: "", lbl: "" });
  }
  hits.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { hits, shows };
}
