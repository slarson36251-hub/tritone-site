// Pure aggregation for the weekly analytics digest (scripts/analytics-digest.mjs) and its tests.
// Input: hits as plain objects in the shape of src/lib/analytics-schema.ts (t as an ISO string).
// Nothing here touches the network or the file system.
//
// Public API (kept stable for the digest script and the dashboard):
//   splitWeeks(hits, now) -> { cur, prev }      summarize(hits) -> Summary (Maps inside)
//   insights(cur, prev) -> string[]              renderDigest(hits, now) -> Markdown
//   digestSummary(hits, now) -> plain JSON (DigestSummary, below), what the digests collection stores
import { EVENT_LABELS, SOURCES, SOURCE_LABELS } from "../../src/lib/analytics-schema.ts";
import { isPrivateHost } from "../../src/lib/track.ts";

const DAY = 86_400_000;

/** A Firestore REST document ({name, fields}) -> a plain hit. */
export function decodeDoc(doc) {
  const out = { id: String(doc?.name ?? "").split("/").pop() };
  for (const [k, v] of Object.entries(doc?.fields ?? {})) {
    if ("stringValue" in v) out[k] = v.stringValue;
    else if ("booleanValue" in v) out[k] = v.booleanValue;
    else if ("timestampValue" in v) out[k] = v.timestampValue;
    else if ("integerValue" in v) out[k] = Number(v.integerValue);
    else out[k] = Object.values(v)[0];
  }
  return out;
}

/** [prevStart, curStart, end) as Dates: the last 7 days and the 7 before them. */
export function weekWindows(now = new Date()) {
  const end = new Date(now);
  return { prevStart: new Date(end - 14 * DAY), curStart: new Date(end - 7 * DAY), end };
}

/** YYYY-MM-DD (UTC) of the Monday starting the ISO week that contains `d`: the digest document id. */
export function isoWeekStart(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

/** Split hits into this week and last week. */
export function splitWeeks(hits, now = new Date()) {
  const { prevStart, curStart, end } = weekWindows(now);
  const cur = [], prev = [];
  for (const h of hits) {
    const t = Date.parse(h.t);
    if (!Number.isFinite(t)) continue;
    if (t >= curStart && t < end) cur.push(h);
    else if (t >= prevStart && t < curStart) prev.push(h);
  }
  return { cur, prev };
}

const inc = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const top = (m, n = 10) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);

/** A stored host that should never have been recorded (older hits, before the filter) -> "". */
const safeHost = (h) => (isPrivateHost(h) ? "" : String(h ?? ""));
/** An event label that is a private host (outbound) -> "file upload". */
const safeLabel = (ev, lbl) => (ev === "outbound" && isPrivateHost(lbl) ? "file upload" : String(lbl ?? ""));

/**
 * Totals for one period. A visit is a sid whose landing page view has first:true; a sid with only
 * first:false page views (reload, back/forward, a new tab from an in-site link) is "continued" and
 * is not counted as a visit, though its page views and events still count.
 */
export function summarize(hits) {
  const sorted = [...hits].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const firstOf = new Map(); // sid -> first hit seen
  const landed = new Set(); // sids with a first:true page view
  for (const h of sorted) {
    if (!h.sid) continue;
    if (!firstOf.has(h.sid)) firstOf.set(h.sid, h);
    if (h.k === "pv" && h.first === true) landed.add(h.sid);
  }
  const visits = new Map();
  let continued = 0;
  for (const [sid, h] of firstOf) {
    if (landed.has(sid)) visits.set(sid, h);
    else continued++;
  }

  const bySource = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  const aiRefs = new Map(), campaigns = new Map(), referrers = new Map(), devices = new Map(), landings = new Map();
  for (const v of visits.values()) {
    const src = SOURCES.includes(v.src) ? v.src : "direct";
    const ref = safeHost(v.ref);
    bySource[src]++;
    if (src === "ai") inc(aiRefs, ref || v.us || "(unknown assistant)");
    if (src === "referral" && ref) inc(referrers, ref);
    if (v.uc || v.us) inc(campaigns, campaignKey(v));
    inc(devices, v.dev || "d");
    inc(landings, v.land || v.path || "/");
  }

  const pages = new Map(), events = new Map(), bookingsBySource = new Map(), eventLabels = new Map();
  let pageViews = 0;
  for (const h of hits) {
    if (h.k === "pv") {
      pageViews++;
      inc(pages, h.path || "/");
    } else if (h.k === "ev" && h.ev) {
      inc(events, h.ev);
      const lbl = safeLabel(h.ev, h.lbl);
      if (lbl) inc(eventLabels, `${h.ev}\u0000${lbl}`);
      if (h.ev === "book_submit") inc(bookingsBySource, SOURCES.includes(h.src) ? h.src : "direct");
    }
  }
  return { visits: visits.size, continued, pageViews, bySource, aiRefs, campaigns, referrers, devices, landings, pages, events, eventLabels, bookingsBySource };
}

/** "spring-show · instagram / social" style key for an outreach link. */
export function campaignKey(h) {
  const via = [h.us, h.um].filter(Boolean).join(" / ");
  return h.uc ? (via ? `${h.uc} · ${via}` : h.uc) : via || "(untagged)";
}

/** Week-over-week change as text: "+25%", "-10%", "new", "—". */
export function change(cur, prev) {
  if (!prev && !cur) return "—";
  if (!prev) return "new";
  const p = Math.round(((cur - prev) / prev) * 100);
  return p === 0 ? "±0%" : `${p > 0 ? "+" : ""}${p}%`;
}

const pctOf = (n, total) => (total ? Math.round((n / total) * 100) : 0);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const label = (s) => SOURCE_LABELS[s] ?? s;

/**
 * Anything that came from a visitor's browser (referrer hosts, UTM values, paths, event labels) is
 * shown as a code span so it cannot render as Markdown or HTML; backticks and line breaks are removed.
 */
export const code = (s) => "`" + String(s ?? "").replace(/[`\r\n]/g, "").replace(/\|/g, "\u2502").trim().slice(0, 160) + "`";

/** 3-5 plain-English sentences on what changed. */
export function insights(cur, prev) {
  const out = [];
  if (!cur.visits && !prev.visits) return ["No visits were recorded in the last two weeks. Check that the site is deployed with the FEEDBACK_API_KEY variable."];

  // 1. Overall.
  if (!prev.visits) out.push(`The site had ${plural(cur.visits, "visit")} and ${plural(cur.pageViews, "page view")} this week (nothing recorded the week before to compare).`);
  else {
    const c = change(cur.visits, prev.visits);
    const dir = cur.visits > prev.visits ? "up" : cur.visits < prev.visits ? "down" : "flat";
    out.push(`Visits were ${dir === "flat" ? "flat" : `${dir} ${c.replace(/^[+-]/, "")}`} at ${cur.visits} (from ${prev.visits}), with ${plural(cur.pageViews, "page view")}.`);
  }

  // 2. Biggest mover among sources.
  const movers = SOURCES.map((s) => [s, cur.bySource[s] - (prev.bySource?.[s] ?? 0)]).filter(([, d]) => d !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (movers.length) {
    const [s, d] = movers[0];
    let line = `${label(s)} ${d > 0 ? "brought" : "sent"} ${plural(cur.bySource[s], "visit")}, ${d > 0 ? "up" : "down"} from ${prev.bySource?.[s] ?? 0}`;
    if (s === "ai" && cur.aiRefs.size) line += `; ${code(top(cur.aiRefs, 1)[0][0])} led`;
    if (s === "referral" && cur.referrers.size) line += `; ${code(top(cur.referrers, 1)[0][0])} led`;
    out.push(line + ".");
  }

  // 3. AI share, when it is meaningful and not already the mover.
  if (cur.bySource.ai && movers[0]?.[0] !== "ai")
    out.push(`AI assistants accounted for ${pctOf(cur.bySource.ai, cur.visits)}% of visits (${cur.bySource.ai}), mostly from ${code(top(cur.aiRefs, 1)[0][0])}.`);

  // 4. Bookings.
  const books = cur.events.get("book_submit") ?? 0;
  const earlier = cur.events.get("book_earlier") ?? 0;
  if (books) {
    const srcs = top(cur.bookingsBySource, 3).map(([s, n]) => `${n} from ${label(s)}`).join(", ");
    out.push(`${plural(books, "Book the Hut request")} came in (${srcs})${prev.events.get("book_submit") ? `, against ${prev.events.get("book_submit")} the week before` : ""}.`);
  } else if (earlier) out.push(`No booking requests, but ${plural(earlier, "person", "people")} asked about an earlier or special time.`);
  else if (prev.events.get("book_submit")) out.push(`No booking requests this week, after ${prev.events.get("book_submit")} the week before.`);

  // 5. Page with the biggest jump.
  const jumps = [...cur.pages.entries()].map(([p, n]) => [p, n - (prev.pages.get(p) ?? 0), n]).filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]);
  if (jumps.length && out.length < 5) {
    const [p, , n] = jumps[0];
    out.push(`${code(p)} got ${plural(n, "view")}, up from ${prev.pages.get(p) ?? 0}, the biggest jump of any page.`);
  }

  // 6. Outreach.
  if (cur.campaigns.size && out.length < 5) {
    const [k, n] = top(cur.campaigns, 1)[0];
    out.push(`The best outreach link was ${code(k)}, with ${plural(n, "visit")}.`);
  }

  // 7. Listening and devices, as filler.
  const plays = cur.events.get("play") ?? 0;
  if (out.length < 3 && plays) out.push(`Visitors started ${plural(plays, "play")} (${change(plays, prev.events.get("play") ?? 0)} on last week).`);
  const phones = cur.devices.get("m") ?? 0;
  if (out.length < 3 && cur.visits) out.push(`${pctOf(phones, cur.visits)}% of visits were on a phone.`);
  return out.slice(0, 5);
}

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const table = (head, rows) =>
  rows.length
    ? [`| ${head.join(" | ")} |`, `| ${head.map((_, i) => (i ? "---:" : "---")).join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n")
    : "_None this week._";

const fmtDay = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" }).format(d);

/** The whole digest as Markdown. Visitor-derived strings are shown as code spans (see `code`). */
export function renderDigest(hits, now = new Date()) {
  const { cur: ch, prev: ph } = splitWeeks(hits, now);
  const cur = summarize(ch), prev = summarize(ph);
  const { curStart, end } = weekWindows(now);
  const L = [];
  L.push(`## Site analytics: ${fmtDay(curStart)} to ${fmtDay(new Date(end - 1))}`, "");
  L.push(`**${cur.visits} visits** (${change(cur.visits, prev.visits)}) · **${cur.pageViews} page views** (${change(cur.pageViews, prev.pageViews)}) · **${cur.events.get("book_submit") ?? 0} booking requests**`, "");
  L.push("### What changed", "", ...insights(cur, prev).map((s) => `- ${s}`), "");

  L.push("### Where visits came from", "");
  L.push(table(["Source", "Visits", "Last week", "Change", "Share"], SOURCES.filter((s) => cur.bySource[s] || prev.bySource[s]).sort((a, b) => cur.bySource[b] - cur.bySource[a]).map((s) => [
    label(s), cur.bySource[s], prev.bySource[s], change(cur.bySource[s], prev.bySource[s]), `${pctOf(cur.bySource[s], cur.visits)}%`,
  ])), "");

  L.push("### AI assistants", "");
  L.push(table(["Assistant", "Visits", "Last week"], top(cur.aiRefs, 10).map(([k, n]) => [code(k), n, prev.aiRefs.get(k) ?? 0])), "");

  L.push("### Top pages", "");
  L.push(table(["Page", "Views", "Last week", "Change"], top(cur.pages, 10).map(([p, n]) => [code(p), n, prev.pages.get(p) ?? 0, change(n, prev.pages.get(p) ?? 0)])), "");

  L.push("### Outreach links (UTM)", "");
  L.push(table(["Campaign · source / medium", "Visits", "Last week"], top(cur.campaigns, 10).map(([k, n]) => [code(k), n, prev.campaigns.get(k) ?? 0])), "");

  if (cur.referrers.size) {
    L.push("### Other sites linking in", "");
    L.push(table(["Site", "Visits"], top(cur.referrers, 8).map(([k, n]) => [code(k), n])), "");
  }

  L.push("### Interest", "");
  const evs = Object.keys(EVENT_LABELS).filter((e) => cur.events.get(e) || prev.events.get(e));
  L.push(table(["Action", "This week", "Last week", "Change"], evs.map((e) => [EVENT_LABELS[e], cur.events.get(e) ?? 0, prev.events.get(e) ?? 0, change(cur.events.get(e) ?? 0, prev.events.get(e) ?? 0)])), "");

  L.push("### Booking requests by source", "");
  L.push(table(["Source", "Requests", "Last week"], top(cur.bookingsBySource, 10).map(([s, n]) => [label(s), n, prev.bookingsBySource.get(s) ?? 0])), "");

  const topLabels = (ev, n = 5) => top(new Map([...cur.eventLabels].filter(([k]) => k.startsWith(ev + "\u0000")).map(([k, v]) => [k.split("\u0000")[1], v])), n);
  const details = [["play", "Most played"], ["show_click", "Most clicked shows"], ["outbound", "Top outbound sites"]]
    .map(([ev, title]) => [title, topLabels(ev)]).filter(([, rows]) => rows.length);
  if (details.length) {
    L.push("### Details", "");
    for (const [title, rows] of details) L.push(`**${title}:** ${rows.map(([k, n]) => `${code(k)} (${n})`).join(", ")}`, "");
  }
  const dev = ["m", "t", "d"].map((d) => `${{ m: "phone", t: "tablet", d: "desktop" }[d]} ${pctOf(cur.devices.get(d) ?? 0, cur.visits)}%`).join(" · ");
  L.push(`_Devices: ${dev}. Visits are counted without cookies: one visit per page load and its in-site navigation (${cur.continued} continued from a reload or an in-site new tab). Scott's own devices are excluded once he has opened /admin._`, "");
  return L.join("\n");
}

/** A Map of counts -> sorted [{key, n}] (plain JSON). */
const rows = (m, n = 25) => top(m, n).map(([key, count]) => ({ key, n: count }));

/** One period's Summary as plain JSON (what `digests` stores under cur / prev). */
export function serializeSummary(s) {
  const labelsOf = (ev) => rows(new Map([...s.eventLabels].filter(([k]) => k.startsWith(ev + "\u0000")).map(([k, v]) => [k.split("\u0000")[1], v])), 10);
  return {
    visits: s.visits,
    continued: s.continued,
    pageViews: s.pageViews,
    bySource: { ...s.bySource },
    aiRefs: rows(s.aiRefs),
    referrers: rows(s.referrers),
    campaigns: rows(s.campaigns),
    devices: Object.fromEntries(s.devices),
    landings: rows(s.landings),
    pages: rows(s.pages),
    events: Object.fromEntries(s.events),
    bookingsBySource: Object.fromEntries(s.bookingsBySource),
    eventLabels: Object.fromEntries(["play", "show_click", "ticket_click", "calendar_add", "poster_click", "outbound", "book_submit"].map((ev) => [ev, labelsOf(ev)])),
  };
}

/**
 * The Firestore REST document for one digest, written to digests/<week> by scripts/analytics-digest.mjs:
 *   week (string, = the id), from / to / generatedAt (timestamp), visits / pageViews / bookings (integer,
 *   this week's headline numbers), md (string, the Markdown), summary (string, JSON of DigestSummary).
 */
/**
 * DigestSummary: the JSON stored in Firestore collection `digests` (field `summary`, as a JSON string).
 * { week: "YYYY-MM-DD" (ISO week start, the document id), from, to: ISO times of the current 7 days,
 *   generatedAt: ISO time, cur: serializeSummary(this week), prev: serializeSummary(last week),
 *   insights: string[] (Markdown: visitor strings are in code spans) }
 */
export function digestDoc(summary, md) {
  const s = (v) => ({ stringValue: String(v) });
  const ts = (v) => ({ timestampValue: v });
  const int = (v) => ({ integerValue: String(v) });
  return {
    fields: {
      week: s(summary.week),
      from: ts(summary.from),
      to: ts(summary.to),
      generatedAt: ts(summary.generatedAt),
      visits: int(summary.cur.visits),
      pageViews: int(summary.cur.pageViews),
      bookings: int(summary.cur.events.book_submit ?? 0),
      md: s(md),
      summary: s(JSON.stringify(summary)),
    },
  };
}

export function digestSummary(hits, now = new Date()) {
  const { cur: ch, prev: ph } = splitWeeks(hits, now);
  const cur = summarize(ch), prev = summarize(ph);
  const { curStart, end } = weekWindows(now);
  return {
    week: isoWeekStart(curStart),
    from: curStart.toISOString(),
    to: end.toISOString(),
    generatedAt: new Date(now).toISOString(),
    cur: serializeSummary(cur),
    prev: serializeSummary(prev),
    insights: insights(cur, prev),
  };
}
