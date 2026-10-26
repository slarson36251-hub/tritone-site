// Every number on Scott's dashboard comes from these pure functions over "hits" documents
// (src/lib/analytics-schema.ts). No DOM, no network: tests/admin.test.mjs runs them under Node.
import { EVENT_LABELS, SOURCES, SOURCE_LABELS } from "../analytics-schema.ts";
import type { EventName, Hit, Source } from "../analytics-schema.ts";

// ------------------------------------------------------------------ visits

export interface VisitEvent { ev: string; lbl: string; path: string; t: number }
export interface Visit {
  sid: string;
  start: number;
  end: number;
  src: Source;
  ref: string;
  us: string;
  um: string;
  uc: string;
  ux: string;
  land: string;
  dev: Hit["dev"];
  tz: string;
  lang: string;
  pages: { path: string; t: number }[];
  events: VisitEvent[];
}

export const ms = (iso: string): number => Date.parse(iso);

/**
 * Group hits into visits (one per sid), oldest first. Visit attributes come from its landing hit.
 * A visit counts only when its sid has a first:true page view; a sid without one is a reload or a
 * new tab of a visit already counted (the tracker marks those first:false), so its pages and
 * events fold into the "continued" set that splitVisits() reports instead of inflating the totals.
 */
export function buildVisits(hits: Hit[]): Visit[] {
  return splitVisits(hits).counted;
}

/** Every sid grouped, split into counted visits and continued ones (no landing page view). */
export function splitVisits(hits: Hit[]): { counted: Visit[]; continued: Visit[] } {
  const all = groupVisits(hits);
  const counted: Visit[] = [], continued: Visit[] = [];
  for (const v of all) (v.landed ? counted : continued).push(v);
  return { counted, continued };
}

function groupVisits(hits: Hit[]): (Visit & { landed: boolean })[] {
  const sorted = [...hits].sort((a, b) => ms(a.t) - ms(b.t));
  const bySid = new Map<string, Visit & { landed: boolean }>();
  for (const h of sorted) {
    const t = ms(h.t);
    if (!Number.isFinite(t) || !h.sid) continue;
    let v = bySid.get(h.sid);
    if (!v) {
      v = {
        landed: false,
        sid: h.sid, start: t, end: t, src: (SOURCES as string[]).includes(h.src) ? h.src : "direct",
        ref: h.ref || "", us: h.us || "", um: h.um || "", uc: h.uc || "", ux: h.ux || "",
        land: h.land || h.path || "/", dev: h.dev || "d", tz: h.tz || "", lang: h.lang || "", pages: [], events: [],
      };
      bySid.set(h.sid, v);
    }
    v.end = Math.max(v.end, t);
    if (h.k === "pv" && h.first === true) v.landed = true;
    if (h.k === "pv") v.pages.push({ path: h.path, t });
    else if (h.k === "ev" && h.ev) v.events.push({ ev: h.ev, lbl: h.lbl || "", path: h.path, t });
  }
  return [...bySid.values()].sort((a, b) => a.start - b.start);
}

export const inRange = (v: Visit, from: number, to: number) => v.start >= from && v.start < to;
export const isInterested = (v: Visit) => v.events.length > 0;
export const hasBooking = (v: Visit) => v.events.some((e) => e.ev === "book_submit");

// ------------------------------------------------------------------ summary / KPIs

export interface Summary {
  visits: number;
  pageViews: number;
  pagesPerVisit: number;
  interest: number; // interest actions (events)
  interestedVisits: number;
  bookings: number; // book_submit events
  conversion: number; // share of visits with at least one interest action, 0..1
}

export function summarize(visits: Visit[]): Summary {
  let pageViews = 0, interest = 0, interestedVisits = 0, bookings = 0;
  for (const v of visits) {
    pageViews += v.pages.length;
    interest += v.events.length;
    if (v.events.length) interestedVisits++;
    bookings += v.events.filter((e) => e.ev === "book_submit").length;
  }
  const n = visits.length;
  return {
    visits: n, pageViews, pagesPerVisit: n ? pageViews / n : 0, interest, interestedVisits, bookings,
    conversion: n ? interestedVisits / n : 0,
  };
}

/** Relative change, or null when there is nothing to compare against. */
export function change(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0;
  return (cur - prev) / prev;
}

// ------------------------------------------------------------------ time bins

export type BinUnit = "hour" | "day";

/** Bin start times (local clock) covering [from, to). Hours for a day or less, else days. */
export function makeBins(from: number, to: number, unit?: BinUnit): { unit: BinUnit; starts: number[] } {
  const u: BinUnit = unit ?? (to - from <= 36 * 3600e3 ? "hour" : "day");
  const d = new Date(from);
  if (u === "hour") d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  const starts: number[] = [];
  while (d.getTime() < to && starts.length < 2000) {
    starts.push(d.getTime());
    if (u === "hour") d.setHours(d.getHours() + 1);
    else d.setDate(d.getDate() + 1);
  }
  return { unit: u, starts };
}

export function binIndex(starts: number[], t: number): number {
  let lo = 0, hi = starts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export interface KpiSeries { visits: number[]; pageViews: number[]; pagesPerVisit: number[]; interest: number[]; bookings: number[]; conversion: number[] }

export function kpiSeries(visits: Visit[], starts: number[]): KpiSeries {
  const n = starts.length;
  const z = () => new Array<number>(n).fill(0);
  const s = { visits: z(), pageViews: z(), interest: z(), bookings: z(), interested: z() };
  for (const v of visits) {
    const i = binIndex(starts, v.start);
    if (i < 0) continue;
    s.visits[i]++;
    s.pageViews[i] += v.pages.length;
    s.interest[i] += v.events.length;
    if (v.events.length) s.interested[i]++;
    s.bookings[i] += v.events.filter((e) => e.ev === "book_submit").length;
  }
  return {
    visits: s.visits, pageViews: s.pageViews, interest: s.interest, bookings: s.bookings,
    pagesPerVisit: s.visits.map((x, i) => (x ? s.pageViews[i] / x : 0)),
    conversion: s.visits.map((x, i) => (x ? s.interested[i] / x : 0)),
  };
}

/** Visits per bin, stacked by source. */
export function trafficBySource(visits: Visit[], starts: number[]): Record<Source, number[]> {
  const out = Object.fromEntries(SOURCES.map((s) => [s, new Array<number>(starts.length).fill(0)])) as Record<Source, number[]>;
  for (const v of visits) {
    const i = binIndex(starts, v.start);
    if (i >= 0) out[v.src][i]++;
  }
  return out;
}

// ------------------------------------------------------------------ hosts, AI, sources

const AI_HOSTS: [RegExp, string][] = [
  [/(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com)$/, "ChatGPT"],
  [/(^|\.)perplexity\.ai$/, "Perplexity"],
  [/(^|\.)claude\.ai$|(^|\.)anthropic\.com$/, "Claude"],
  [/(^|\.)(gemini\.google\.com|bard\.google\.com)$/, "Gemini"],
  [/(^|\.)copilot\.(microsoft|cloud\.microsoft)\.com$|^copilot\.microsoft\.com$|(^|\.)copilot\.cloud\.microsoft$/, "Copilot"],
  [/(^|\.)(chat\.)?deepseek\.com$/, "DeepSeek"],
  [/(^|\.)(grok\.com|x\.ai)$/, "Grok"],
  [/(^|\.)meta\.ai$/, "Meta AI"],
  [/(^|\.)(chat\.)?mistral\.ai$/, "Mistral"],
  [/(^|\.)you\.com$/, "You.com"],
  [/(^|\.)phind\.com$/, "Phind"],
  [/(^|\.)poe\.com$/, "Poe"],
  [/(^|\.)kagi\.com$/, "Kagi"],
];

/** "chatgpt.com" or utm_source "chatgpt.com" -> "ChatGPT"; null when not a known assistant. */
export function aiName(hostOrSource: string): string | null {
  const h = cleanHost(hostOrSource);
  if (!h) return null;
  for (const [re, name] of AI_HOSTS) if (re.test(h)) return name;
  if (/^(chatgpt|openai)$/.test(h)) return "ChatGPT";
  if (/^(perplexity|claude|gemini|copilot|deepseek|grok)$/.test(h)) return h[0].toUpperCase() + h.slice(1);
  return null;
}

const FRIENDLY: [RegExp, string][] = [
  [/(^|\.)google\.[a-z.]+$/, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)yahoo\.[a-z.]+$/, "Yahoo"],
  [/(^|\.)ecosia\.org$/, "Ecosia"],
  [/(^|\.)search\.brave\.com$/, "Brave Search"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "Facebook"],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "X / Twitter"],
  [/(^|\.)threads\.(net|com)$/, "Threads"],
  [/(^|\.)bsky\.app$/, "Bluesky"],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "LinkedIn"],
  [/(^|\.)reddit\.com$/, "Reddit"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube"],
  [/(^|\.)tiktok\.com$/, "TikTok"],
  [/(^|\.)bandcamp\.com$/, "Bandcamp"],
  [/(^|\.)soundcloud\.com$/, "SoundCloud"],
  [/(^|\.)spotify\.com$/, "Spotify"],
  [/(^|\.)linktr\.ee$/, "Linktree"],
  [/(^|\.)mail\.google\.com$/, "Gmail"],
  [/(^|\.)(outlook\.live\.com|outlook\.office\.com)$/, "Outlook"],
];

export function cleanHost(h: string): string {
  return (h || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^(www\.|m\.|l\.|lm\.)/, "");
}

export const HIDDEN_HOST = "hidden";

/**
 * Hosts the dashboard must never print: anything that could point at the studio's own network
 * (the Hut's NAS, DDNS names, IPs, localhost). Mirrors isPrivateHost in the tracker, applied here
 * as well so an old or hand-written hit can't leak one. Returns true for "hide this".
 */
export function isPrivateHost(host: string): boolean {
  const h = cleanHost(host).replace(/:\d+$/, "");
  if (!h) return false;
  if (/hummingbird/.test(h)) return true;
  if (/(^|\.)(synology\.me|quickconnect\.to|myds\.me|direct\.quickconnect\.to)$/.test(h)) return true;
  if (/ddns/.test(h)) return true;
  if (/^local(host)?$|(^|\.)(local(host)?|lan|home|internal)$/.test(h)) return true; // never the literal word: tests/feedback.test.mjs forbids it in bundles
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4
  if (/^\[?[0-9a-f:]*:[0-9a-f:]*\]?$/.test(h)) return true; // IPv6
  return false;
}

/** A readable name for a referrer host ("l.instagram.com" -> "Instagram"). Unknown hosts stay as hosts; private ones are hidden. */
export function hostLabel(host: string): string {
  const h = cleanHost(host);
  if (!h) return "No referrer";
  if (isPrivateHost(h)) return HIDDEN_HOST;
  const ai = aiName(h);
  if (ai) return ai;
  for (const [re, name] of FRIENDLY) if (re.test(h)) return name;
  return h;
}

/** Where a visit came from, in a few words: "ChatGPT", "Instagram · deluxe-nov", "Google", "Direct". */
export function visitOrigin(v: Visit): string {
  if (v.src === "ai") return aiName(v.ref) ?? aiName(v.us) ?? (v.ref ? hostLabel(v.ref) : "AI assistant");
  if (v.src === "campaign" || v.src === "email") {
    const who = v.us ? prettySource(v.us, v.um) : v.ref ? hostLabel(v.ref) : "";
    return [who, v.uc].filter(Boolean).join(" · ") || SOURCE_LABELS[v.src];
  }
  if (v.src === "direct") return "Direct / typed";
  return v.ref ? hostLabel(v.ref) : v.us || SOURCE_LABELS[v.src];
}

const UTM_SOURCES: Record<string, string> = {
  instagram: "Instagram", facebook: "Facebook", newsletter: "Newsletter", sms: "Text message", flyer: "Flyer", poster: "Poster", card: "Business card",
  linktree: "Linktree", youtube: "YouTube", tiktok: "TikTok", bandcamp: "Bandcamp", email: "Email",
};
/** utm_source as people say it: "instagram" -> "Instagram", "flyer" + medium "qr" -> "Flyer QR", "the-deluxe" -> "The Deluxe". */
export function prettySource(us: string, um = ""): string {
  const k = us.trim().toLowerCase();
  const name = UTM_SOURCES[k] ?? (/\./.test(k) ? hostLabel(k) : titleFromSlug(k));
  return um.toLowerCase() === "qr" && !/qr/i.test(name) ? `${name} QR` : name;
}

export interface Row { key: string; label: string; visits: number; interested: number; bookings: number; pageViews: number; prev?: number; share?: number; sub?: string }

function rowsBy(visits: Visit[], keyOf: (v: Visit) => string | null, labelOf: (k: string) => string = (k) => k): Row[] {
  const m = new Map<string, Row>();
  for (const v of visits) {
    const k = keyOf(v);
    if (k == null) continue;
    let r = m.get(k);
    if (!r) m.set(k, (r = { key: k, label: labelOf(k), visits: 0, interested: 0, bookings: 0, pageViews: 0 }));
    r.visits++;
    r.pageViews += v.pages.length;
    if (isInterested(v)) r.interested++;
    if (hasBooking(v)) r.bookings++;
  }
  return [...m.values()].sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label));
}

/** One row per source (all seven, in the fixed order), with share of visits and the previous period. */
export function sourceBreakdown(cur: Visit[], prev: Visit[]): (Row & { src: Source; share: number; prev: number })[] {
  const c = new Map(rowsBy(cur, (v) => v.src).map((r) => [r.key, r]));
  const p = new Map(rowsBy(prev, (v) => v.src).map((r) => [r.key, r]));
  return SOURCES.map((s) => {
    const r = c.get(s) ?? { key: s, label: "", visits: 0, interested: 0, bookings: 0, pageViews: 0 };
    return { ...r, src: s, label: SOURCE_LABELS[s], share: cur.length ? r.visits / cur.length : 0, prev: p.get(s)?.visits ?? 0 };
  });
}

/** Referring sites (by friendly name), with which source bucket they fall in. */
export function referrers(visits: Visit[], prev: Visit[] = []): (Row & { src: Source; isNew: boolean })[] {
  const keyOf = (v: Visit) => (v.ref ? hostLabel(v.ref) : null);
  const before = new Set(prev.map(keyOf).filter(Boolean));
  // A site can feed several buckets (Instagram: tagged outreach links and plain social); show the main one.
  const srcCount = new Map<string, Map<Source, number>>();
  for (const v of visits) {
    const k = keyOf(v);
    if (!k) continue;
    const m = srcCount.get(k) ?? new Map<Source, number>();
    m.set(v.src, (m.get(v.src) ?? 0) + 1);
    srcCount.set(k, m);
  }
  const mainSrc = (k: string): Source => [...(srcCount.get(k)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "referral";
  return rowsBy(visits, keyOf).map((r) => ({ ...r, src: mainSrc(r.key), isNew: prev.length > 0 && !before.has(r.key) }));
}

/** AI assistants by name, with the page each one most often sent people to. */
export function aiAssistants(visits: Visit[], prev: Visit[] = []): (Row & { topLanding: string })[] {
  const nameOf = (v: Visit) => (v.src === "ai" ? aiName(v.ref) ?? aiName(v.us) ?? (v.ref ? hostLabel(v.ref) : "Other assistant") : null);
  const prevRows = new Map(rowsBy(prev, nameOf).map((r) => [r.key, r.visits]));
  return rowsBy(visits, nameOf).map((r) => {
    const lands = new Map<string, number>();
    for (const v of visits) if (nameOf(v) === r.key) lands.set(v.land, (lands.get(v.land) ?? 0) + 1);
    const topLanding = [...lands.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "/";
    return { ...r, prev: prevRows.get(r.key) ?? 0, topLanding };
  });
}

// ------------------------------------------------------------------ outreach

export interface CampaignRow extends Row { campaign: string; sources: { source: string; medium: string; visits: number }[]; tickets: number }

/** Outreach links: one row per utm_campaign (or utm_source when no campaign), with sources inside. */
export function campaigns(visits: Visit[]): CampaignRow[] {
  // ChatGPT and friends add utm_source themselves; those visits belong to the AI card, not outreach.
  const tagged = visits.filter((v) => v.src !== "ai" && (v.uc || v.us));
  const rows = rowsBy(tagged, (v) => (v.uc || `(${v.us})`).toLowerCase());
  return rows.map((r) => {
    const mine = tagged.filter((v) => (v.uc || `(${v.us})`).toLowerCase() === r.key);
    const src = new Map<string, { source: string; medium: string; visits: number }>();
    for (const v of mine) {
      const k = `${v.us}|${v.um}`;
      const e = src.get(k) ?? { source: v.us || "(no source)", medium: v.um, visits: 0 };
      e.visits++;
      src.set(k, e);
    }
    return {
      ...r,
      campaign: mine[0]?.uc || mine[0]?.us || r.key,
      label: mine[0]?.uc || mine[0]?.us || r.key,
      sources: [...src.values()].sort((a, b) => b.visits - a.visits),
      tickets: mine.reduce((n, v) => n + v.events.filter((e) => e.ev === "ticket_click" || e.ev === "calendar_add").length, 0),
    };
  });
}

// ------------------------------------------------------------------ interest

const HUT_PATH = /^\/(hummingbird-hut|book-the-hut|sessions)(\/|$)/;
const BOOK_PATH = /^\/book-the-hut(\/|$)/;

export interface FunnelStep { label: string; visits: number; rate: number }

/** Visit -> looked at the Hut -> opened the booking form -> asked for a time. */
export function funnel(visits: Visit[]): FunnelStep[] {
  const n = visits.length;
  const hut = visits.filter((v) => v.pages.some((p) => HUT_PATH.test(p.path)));
  const book = hut.filter((v) => v.pages.some((p) => BOOK_PATH.test(p.path)));
  const asked = book.filter((v) => v.events.some((e) => e.ev === "book_submit" || e.ev === "book_earlier"));
  const step = (label: string, c: number) => ({ label, visits: c, rate: n ? c / n : 0 });
  return [step("Visited the site", n), step("Looked at the Hut", hut.length), step("Opened Book the Hut", book.length), step("Asked for a time", asked.length)];
}

export interface EventRow { ev: string; label: string; count: number; visits: number; prev: number }

export function eventCounts(visits: Visit[], prev: Visit[] = []): EventRow[] {
  const count = (vs: Visit[]) => {
    const m = new Map<string, { count: number; visits: number }>();
    for (const v of vs) {
      const seen = new Set<string>();
      for (const e of v.events) {
        const r = m.get(e.ev) ?? { count: 0, visits: 0 };
        r.count++;
        if (!seen.has(e.ev)) { r.visits++; seen.add(e.ev); }
        m.set(e.ev, r);
      }
    }
    return m;
  };
  const c = count(visits), p = count(prev);
  return [...c.entries()]
    .map(([ev, r]) => ({ ev, label: EVENT_LABELS[ev as EventName] ?? ev, ...r, prev: p.get(ev)?.count ?? 0 }))
    .sort((a, b) => b.count - a.count);
}

export interface AttentionRow { key: string; label: string; count: number; detail: string }

/** Which shows, posters and tracks got attention (by event label). */
export function attention(visits: Visit[], showName: (slug: string) => string | undefined = () => undefined) {
  const tally = (evs: string[], labelOf: (lbl: string) => string) => {
    const m = new Map<string, { count: number; by: Map<string, number> }>();
    for (const v of visits) for (const e of v.events) {
      if (!evs.includes(e.ev) || !e.lbl) continue;
      const r = m.get(e.lbl) ?? { count: 0, by: new Map() };
      r.count++;
      r.by.set(e.ev, (r.by.get(e.ev) ?? 0) + 1);
      m.set(e.lbl, r);
    }
    return [...m.entries()]
      .map(([key, r]) => ({
        key, label: labelOf(key), count: r.count,
        detail: [...r.by.entries()].sort((a, b) => b[1] - a[1]).map(([ev, n]) => `${n} ${shortEvent(ev, n)}`).join(" · "),
      }))
      .sort((a, b) => b.count - a.count);
  };
  const pretty = (s: string) => showName(s) ?? titleFromSlug(s);
  return {
    shows: tally(["show_click", "ticket_click", "calendar_add"], pretty),
    posters: tally(["poster_click"], pretty),
    plays: tally(["play"], (s) => s),
    outbound: tally(["outbound"], hostLabel),
  };
}

function shortEvent(ev: string, n: number): string {
  const one: Record<string, string> = { show_click: "open", ticket_click: "ticket click", calendar_add: "calendar add", poster_click: "view", play: "play", outbound: "click" };
  const w = one[ev] ?? ev;
  return n === 1 ? w : w + "s";
}

export function titleFromSlug(s: string): string {
  return s.replace(/^\/+/, "").replace(/[-_/]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || s;
}

/** "Why": share of visits that took an interest action, by source and by landing page. */
export function interestBySource(visits: Visit[]) {
  return SOURCES.map((s) => {
    const vs = visits.filter((v) => v.src === s);
    const interested = vs.filter(isInterested).length;
    return { src: s, label: SOURCE_LABELS[s], visits: vs.length, interested, rate: vs.length ? interested / vs.length : 0, bookings: vs.filter(hasBooking).length };
  }).filter((r) => r.visits > 0).sort((a, b) => b.rate - a.rate || b.visits - a.visits);
}

/** What booking requests ask for: session lengths and weekdays, from book_submit labels ("4h Thu"). */
export function bookingDetails(visits: Visit[]) {
  const hours = new Map<string, number>(), days = new Map<string, number>();
  for (const v of visits) for (const e of v.events) {
    if (e.ev !== "book_submit") continue;
    const m = e.lbl.match(/(\d+(?:\.\d+)?)\s*h/i);
    const d = e.lbl.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\b/i);
    if (m) hours.set(`${m[1]} h`, (hours.get(`${m[1]} h`) ?? 0) + 1);
    if (d) { const k = d[1][0].toUpperCase() + d[1].slice(1, 3).toLowerCase(); days.set(k, (days.get(k) ?? 0) + 1); }
  }
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    hours: [...hours.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => parseFloat(a.label) - parseFloat(b.label)),
    days: order.map((label) => ({ label, count: days.get(label) ?? 0 })),
  };
}

/** Visits by weekday (0 = Monday) and hour of day, on the viewer's clock: when to post. */
export function weekHourGrid(visits: Visit[]): number[][] {
  const g = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const v of visits) {
    const d = new Date(v.start);
    g[(d.getDay() + 6) % 7][d.getHours()]++;
  }
  return g;
}

// ------------------------------------------------------------------ pages

export interface PageRow { path: string; views: number; visits: number; actions: number; prev: number }

export function topPages(visits: Visit[], prev: Visit[] = []): PageRow[] {
  const tally = (vs: Visit[]) => {
    const m = new Map<string, { views: number; visits: number; actions: number }>();
    for (const v of vs) {
      const seen = new Set<string>();
      for (const p of v.pages) {
        const r = m.get(p.path) ?? { views: 0, visits: 0, actions: 0 };
        r.views++;
        if (!seen.has(p.path)) { r.visits++; seen.add(p.path); }
        m.set(p.path, r);
      }
      for (const e of v.events) {
        const r = m.get(e.path) ?? { views: 0, visits: 0, actions: 0 };
        r.actions++;
        m.set(e.path, r);
      }
    }
    return m;
  };
  const c = tally(visits), p = tally(prev);
  return [...c.entries()]
    .filter(([, r]) => r.views > 0)
    .map(([path, r]) => ({ path, ...r, prev: p.get(path)?.views ?? 0 }))
    .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path));
}

export interface LandingRow { path: string; visits: number; pagesPerVisit: number; interested: number; rate: number; topSource: Source }

export function landingPages(visits: Visit[]): LandingRow[] {
  const m = new Map<string, Visit[]>();
  for (const v of visits) m.set(v.land, [...(m.get(v.land) ?? []), v]);
  return [...m.entries()].map(([path, vs]) => {
    const interested = vs.filter(isInterested).length;
    const bySrc = new Map<Source, number>();
    for (const v of vs) bySrc.set(v.src, (bySrc.get(v.src) ?? 0) + 1);
    return {
      path, visits: vs.length, interested, rate: interested / vs.length,
      pagesPerVisit: vs.reduce((n, v) => n + v.pages.length, 0) / vs.length,
      topSource: [...bySrc.entries()].sort((a, b) => b[1] - a[1])[0][0],
    };
  }).sort((a, b) => b.visits - a.visits || a.path.localeCompare(b.path));
}

// ------------------------------------------------------------------ audience

export function devices(visits: Visit[]) {
  const names = { m: "Phone", t: "Tablet", d: "Desktop" } as const;
  return (["m", "t", "d"] as const).map((k) => {
    const n = visits.filter((v) => v.dev === k).length;
    return { key: k, label: names[k], visits: n, share: visits.length ? n / visits.length : 0 };
  });
}

const US_WEST = /^America\/(Los_Angeles|Tijuana|Vancouver|Dawson|Whitehorse)$|^US\/Pacific$|^PST8PDT$/;
const US_MOUNTAIN = /^America\/(Denver|Phoenix|Boise|Edmonton|Yellowknife|Ojinaga|Hermosillo|Cambridge_Bay|Inuvik)$|^US\/(Mountain|Arizona)$|^MST/;
const US_CENTRAL = /^America\/(Chicago|Winnipeg|Regina|Menominee|Indiana\/(Knox|Tell_City)|North_Dakota\/.+)$|^US\/Central$|^CST6CDT$/;
const US_EAST = /^America\/(New_York|Detroit|Toronto|Montreal|Nassau|Indiana\/.+|Kentucky\/.+|Louisville|Iqaluit)$|^US\/(Eastern|Michigan)$|^EST/;
const CANADA_ATL = /^America\/(Halifax|St_Johns|Moncton|Glace_Bay|Goose_Bay)$/;

/** Friendly, deliberately coarse region for an IANA time zone. Never finer than a time-zone band. */
export function regionForTz(tz: string): string {
  if (!tz) return "Unknown";
  if (US_WEST.test(tz)) return "US West (Pacific)";
  if (US_MOUNTAIN.test(tz)) return "US Mountain";
  if (US_CENTRAL.test(tz)) return "US Central";
  if (US_EAST.test(tz)) return "US East";
  if (/^America\/(Anchorage|Juneau|Sitka|Nome|Yakutat|Metlakatla)$|^US\/Alaska$/.test(tz)) return "Alaska";
  if (/^Pacific\/Honolulu$|^US\/Hawaii$/.test(tz)) return "Hawaii";
  if (CANADA_ATL.test(tz)) return "Canada (Atlantic)";
  if (/^America\/(Mexico_City|Monterrey|Merida|Cancun|Chihuahua|Mazatlan|Bahia_Banderas|Matamoros)$/.test(tz)) return "Mexico";
  if (/^America\/(Puerto_Rico|Havana|Jamaica|Santo_Domingo|Port_of_Spain|Barbados)$/.test(tz)) return "Caribbean";
  if (/^America\/(Guatemala|Costa_Rica|El_Salvador|Tegucigalpa|Managua|Panama|Belize)$/.test(tz)) return "Central America";
  if (/^America\//.test(tz)) return "South America";
  if (/^Europe\/(London|Dublin|Belfast|Guernsey|Isle_of_Man|Jersey)$/.test(tz)) return "UK & Ireland";
  if (/^Europe\//.test(tz)) return "Europe";
  if (/^Asia\/(Tokyo|Seoul)$/.test(tz)) return "Japan & Korea";
  if (/^Asia\/(Kolkata|Calcutta|Karachi|Dhaka|Kathmandu|Colombo)$/.test(tz)) return "South Asia";
  if (/^Asia\/(Dubai|Riyadh|Tehran|Jerusalem|Tel_Aviv|Baghdad|Qatar|Beirut|Amman)$/.test(tz)) return "Middle East";
  if (/^Asia\//.test(tz)) return "Asia";
  if (/^Australia\//.test(tz)) return "Australia";
  if (/^Pacific\/(Auckland|Chatham)$/.test(tz)) return "New Zealand";
  if (/^Africa\//.test(tz)) return "Africa";
  if (/^Pacific\//.test(tz)) return "Pacific Islands";
  return "Other";
}

export function regions(visits: Visit[]) {
  return rowsBy(visits, (v) => regionForTz(v.tz)).map((r) => ({ ...r, share: visits.length ? r.visits / visits.length : 0 }));
}

export function languages(visits: Visit[]) {
  return rowsBy(visits, (v) => (v.lang || "unknown").split("-")[0].toLowerCase());
}

// ------------------------------------------------------------------ live + feed

export const LIVE_WINDOW = 5 * 60e3;

/** Visits with any hit in the last five minutes, newest activity first. */
export function liveNow(hits: Hit[], now: number) {
  const recent = hits.filter((h) => now - ms(h.t) <= LIVE_WINDOW && ms(h.t) <= now + 60e3);
  const visits = groupVisits(recent);
  return visits
    .map((v) => ({ sid: v.sid, origin: visitOrigin(v), src: v.src, dev: v.dev, page: v.pages.at(-1)?.path ?? v.land, last: v.end, region: regionForTz(v.tz), actions: v.events.length }))
    .sort((a, b) => b.last - a.last);
}

export interface Journey { sid: string; start: number; src: Source; origin: string; dev: Hit["dev"]; region: string; steps: { kind: "page" | "event"; text: string }[]; interested: boolean; booked: boolean }

/** Anonymized journeys for the activity feed: where from, which pages, what they did. No personal data exists to show. */
export function journeys(visits: Visit[], limit = 25): Journey[] {
  return [...visits].sort((a, b) => b.start - a.start).slice(0, limit).map((v) => {
    const steps = [
      ...v.pages.map((p) => ({ kind: "page" as const, text: p.path, t: p.t })),
      ...v.events.map((e) => ({ kind: "event" as const, text: (EVENT_LABELS[e.ev as EventName] ?? e.ev).replace(/s$/, "") + (e.lbl && e.ev !== "book_submit" ? `: ${e.ev === "outbound" ? hostLabel(e.lbl) : e.lbl}` : ""), t: e.t + 0.5 })),
    ].sort((a, b) => a.t - b.t).map(({ kind, text }) => ({ kind, text }));
    return { sid: v.sid, start: v.start, src: v.src, origin: visitOrigin(v), dev: v.dev, region: regionForTz(v.tz), steps, interested: isInterested(v), booked: hasBooking(v) };
  });
}

// ------------------------------------------------------------------ insights

export interface ShowDate { slug: string; title: string; start: number }
export interface Insight { tone: "up" | "down" | "new" | "info"; text: string; score: number }

const SOURCE_PHRASE: Record<Source, string> = { ai: "AI assistants", search: "search", social: "social media", email: "email", campaign: "outreach links", referral: "other sites", direct: "direct visits" };
const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Three to six plain-English sentences on what changed against the previous period. */
export function insights(cur: Visit[], prev: Visit[], opts: { starts?: number[]; unit?: BinUnit; shows?: ShowDate[]; showName?: (s: string) => string | undefined; periodLabel?: string } = {}): Insight[] {
  const out: Insight[] = [];
  const period = opts.periodLabel ?? "the previous period";
  const sc = summarize(cur), sp = summarize(prev);

  if (sc.visits === 0) {
    return [{ tone: "info", score: 1, text: prev.length ? `No visits yet in this range (there were ${sp.visits} in ${period}).` : "No visits recorded in this range yet." }];
  }

  // Overall
  const dv = change(sc.visits, sp.visits);
  if (dv === null) out.push({ tone: "new", score: 5, text: `${plural(sc.visits, "visit")} this period, the first since tracking began.` });
  else if (Math.abs(dv) >= 0.1) out.push({ tone: dv > 0 ? "up" : "down", score: 4 + Math.abs(dv), text: `Visits are ${dv > 0 ? "up" : "down"} ${pct(dv)} on ${period} (${sp.visits} → ${sc.visits}).` });

  // Biggest source mover
  const sources = sourceBreakdown(cur, prev);
  const movers = sources.map((s) => ({ ...s, d: s.visits - s.prev })).filter((s) => Math.abs(s.d) >= 3).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  if (movers[0]) {
    const m = movers[0];
    const rel = change(m.visits, m.prev);
    out.push({
      tone: m.d > 0 ? "up" : "down", score: 6 + Math.abs(m.d) / Math.max(4, sc.visits) * 10,
      text: `${m.label} ${m.d > 0 ? "brought" : "sent"} ${m.d > 0 ? Math.abs(m.d) + " more" : Math.abs(m.d) + " fewer"} visits than ${period}${rel !== null ? ` (${m.d > 0 ? "+" : "−"}${pct(rel)})` : ""}.`,
    });
  }

  // AI share trend
  const aiNow = sc.visits ? sources.find((s) => s.src === "ai")!.visits / sc.visits : 0;
  const aiPrev = sp.visits ? sources.find((s) => s.src === "ai")!.prev / sp.visits : 0;
  const aiTop = aiAssistants(cur)[0];
  if (aiNow > 0 && (Math.abs(aiNow - aiPrev) >= 0.03 || aiNow >= 0.1)) {
    const trend = !sp.visits ? "" : aiNow > aiPrev + 0.01 ? `, up from ${pct(aiPrev)}` : aiNow < aiPrev - 0.01 ? `, down from ${pct(aiPrev)}` : ", about the same as before";
    out.push({ tone: aiNow >= aiPrev ? "up" : "down", score: 5 + aiNow * 10, text: `AI assistants sent ${pct(aiNow)} of visits${trend}${aiTop ? `; ${aiTop.label} leads with ${plural(aiTop.visits, "visit")}` : ""}.` });
  }

  // New referrers
  const fresh = referrers(cur, prev).filter((r) => r.isNew && r.visits >= 2);
  if (fresh.length) {
    const names = fresh.slice(0, 3).map((r) => `${r.label} (${r.visits})`);
    out.push({ tone: "new", score: 5 + fresh[0].visits / 2, text: `New ${fresh.length === 1 ? "referrer" : "referrers"} this period: ${names.join(", ")}.` });
  }

  // A campaign that's working
  const minVisits = Math.max(5, Math.round(sc.visits * 0.02));
  const camp = campaigns(cur).filter((c) => c.visits >= minVisits).sort((a, b) => (b.interested * b.interested) / b.visits - (a.interested * a.interested) / a.visits)[0];
  if (camp && camp.interested > 0) {
    const r = camp.interested / camp.visits;
    const bits = [`${plural(camp.visits, "visit")}`, `${pct(r)} took action`];
    if (camp.bookings) bits.push(plural(camp.bookings, "booking request"));
    else if (camp.tickets) bits.push(plural(camp.tickets, "ticket or calendar click"));
    out.push({ tone: "up", score: 6 + r * 4, text: `The “${camp.label}” link is working: ${bits.join(", ")}${r > sc.conversion + 0.05 ? `, above the site's ${pct(sc.conversion)}` : ""}.` });
  }

  // Page spiking
  const spike = topPages(cur, prev).filter((p) => p.views >= 5 && p.views >= 2 * Math.max(1, p.prev)).sort((a, b) => b.views - b.prev - (a.views - a.prev))[0];
  if (spike && prev.length) {
    out.push({ tone: "up", score: 5 + Math.min(4, spike.views / Math.max(1, spike.prev)), text: `${pageName(spike.path, opts.showName)} is spiking: ${spike.views} views${spike.prev ? `, up from ${spike.prev}` : ", new this period"}.` });
  }

  // Show-date spikes
  if (opts.starts && opts.shows?.length && opts.unit === "day") {
    const series = kpiSeries(cur, opts.starts).visits;
    const sorted = [...series].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    let best: { i: number; show: ShowDate } | null = null;
    series.forEach((n, i) => {
      if (n < 4 || n < 1.8 * Math.max(1, median)) return;
      const day = opts.starts![i];
      const show = opts.shows!.find((s) => s.start >= day - 2 * 864e5 && s.start < day + 864e5);
      if (show && (!best || n > series[best.i])) best = { i, show };
    });
    if (best) {
      const b = best as { i: number; show: ShowDate };
      const day = new Date(opts.starts[b.i]);
      const showDay = new Date(b.show.start);
      const same = day.toDateString() === showDay.toDateString();
      const rel = same ? "the day of" : b.show.start > day.getTime() ? "ahead of" : "right after";
      const when = day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      out.push({ tone: "info", score: 7, text: `Visits jumped to ${series[b.i]} on ${when}, ${rel} ${b.show.title} (usually about ${median} a day).` });
    }
  }

  // Bookings
  if (sc.bookings > 0) {
    const bySrc = interestBySource(cur).filter((r) => r.bookings > 0).sort((a, b) => b.bookings - a.bookings)[0];
    out.push({ tone: "up", score: 6.5, text: `${plural(sc.bookings, "booking request")} came in${sp.bookings ? ` (${sp.bookings} in ${period})` : ""}${bySrc ? `; most came from ${SOURCE_PHRASE[bySrc.src]}` : ""}.` });
  }

  out.sort((a, b) => b.score - a.score);
  const top = out.slice(0, 6);
  if (top.length < 3) {
    const best = interestBySource(cur).filter((r) => r.visits >= 3).sort((a, b) => b.rate - a.rate)[0];
    if (best) top.push({ tone: "info", score: 0, text: `${best.label} visitors are the most engaged: ${pct(best.rate)} of them took an interest action.` });
    const land = landingPages(cur)[0];
    if (land && top.length < 3) top.push({ tone: "info", score: 0, text: `Most visits start on ${pageName(land.path, opts.showName)} (${plural(land.visits, "visit")}).` });
  }
  return top;
}

const PAGE_NAMES: Record<string, string> = {
  "/": "The home page", "/book-the-hut": "Book the Hut", "/hummingbird-hut": "The Hummingbird Hut page", "/shows": "The shows page",
  "/listen": "Listen", "/bands": "The bands page", "/sessions": "The sessions shelf", "/gallery": "The gallery", "/contact": "Contact", "/free-track": "The free track page",
};

export function pageName(path: string, showName?: (s: string) => string | undefined): string {
  if (PAGE_NAMES[path]) return PAGE_NAMES[path];
  const show = path.match(/^\/shows\/([^/]+)$/)?.[1];
  if (show) return showName?.(show) ?? titleFromSlug(show);
  const band = path.match(/^\/bands\/([^/]+)$/)?.[1];
  if (band) return titleFromSlug(band);
  return path;
}

// ------------------------------------------------------------------ CSV

const CSV_COLS: (keyof Hit)[] = ["t", "k", "sid", "path", "ev", "lbl", "src", "ref", "us", "um", "uc", "ux", "land", "first", "dev", "tz", "lang"];
const CSV_HEAD = ["time", "kind", "visit", "page", "event", "detail", "source", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_content", "landing", "first", "device", "time_zone", "language"];

export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(hits: Hit[]): string {
  const rows = [...hits].sort((a, b) => ms(a.t) - ms(b.t)).map((h) => CSV_COLS.map((c) => csvCell(h[c])).join(","));
  return [CSV_HEAD.join(","), ...rows].join("\r\n") + "\r\n";
}
