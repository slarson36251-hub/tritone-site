// Pure aggregation for the weekly analytics digest (scripts/analytics-digest.mjs) and its tests.
// Input: hits as plain objects in the shape of src/lib/analytics-schema.ts (t as an ISO string).
// Nothing here touches the network or the file system.
import { EVENT_LABELS, SOURCES, SOURCE_LABELS } from "../../src/lib/analytics-schema.ts";

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

/** Totals for one period. A visit is one sid; its source comes from its first hit. */
export function summarize(hits) {
  const visits = new Map(); // sid -> first hit
  const sorted = [...hits].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  for (const h of sorted) if (h.sid && !visits.has(h.sid)) visits.set(h.sid, h);

  const bySource = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  const aiRefs = new Map(), campaigns = new Map(), referrers = new Map(), devices = new Map(), landings = new Map();
  for (const v of visits.values()) {
    const src = SOURCES.includes(v.src) ? v.src : "direct";
    bySource[src]++;
    if (src === "ai") inc(aiRefs, v.ref || v.us || "(unknown assistant)");
    if (src === "referral" && v.ref) inc(referrers, v.ref);
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
      if (h.lbl) inc(eventLabels, `${h.ev}\u0000${h.lbl}`);
      if (h.ev === "book_submit") inc(bookingsBySource, SOURCES.includes(h.src) ? h.src : "direct");
    }
  }
  return {
    visits: visits.size,
    pageViews,
    bySource,
    aiRefs,
    campaigns,
    referrers,
    devices,
    landings,
    pages,
    events,
    eventLabels,
    bookingsBySource,
  };
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
    if (s === "ai" && cur.aiRefs.size) line += `; ${top(cur.aiRefs, 1)[0][0]} led`;
    if (s === "referral" && cur.referrers.size) line += `; ${top(cur.referrers, 1)[0][0]} led`;
    out.push(line + ".");
  }

  // 3. AI share, when it is meaningful and not already the mover.
  if (cur.bySource.ai && movers[0]?.[0] !== "ai")
    out.push(`AI assistants accounted for ${pctOf(cur.bySource.ai, cur.visits)}% of visits (${cur.bySource.ai}), mostly from ${top(cur.aiRefs, 1)[0][0]}.`);

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
    out.push(`${p} got ${plural(n, "view")}, up from ${prev.pages.get(p) ?? 0}, the biggest jump of any page.`);
  }

  // 6. Outreach.
  if (cur.campaigns.size && out.length < 5) {
    const [k, n] = top(cur.campaigns, 1)[0];
    out.push(`The best outreach link was “${k}”, with ${plural(n, "visit")}.`);
  }

  // 7. Listening and shows, as filler.
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

/** The whole digest as Markdown. */
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
  L.push(table(["Assistant", "Visits", "Last week"], top(cur.aiRefs, 10).map(([k, n]) => [k, n, prev.aiRefs.get(k) ?? 0])), "");

  L.push("### Top pages", "");
  L.push(table(["Page", "Views", "Last week", "Change"], top(cur.pages, 10).map(([p, n]) => [p, n, prev.pages.get(p) ?? 0, change(n, prev.pages.get(p) ?? 0)])), "");

  L.push("### Outreach links (UTM)", "");
  L.push(table(["Campaign · source / medium", "Visits", "Last week"], top(cur.campaigns, 10).map(([k, n]) => [k, n, prev.campaigns.get(k) ?? 0])), "");

  if (cur.referrers.size) {
    L.push("### Other sites linking in", "");
    L.push(table(["Site", "Visits"], top(cur.referrers, 8)), "");
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
    for (const [title, rows] of details) L.push(`**${title}:** ${rows.map(([k, n]) => `${k} (${n})`).join(", ")}`, "");
  }
  const dev = ["m", "t", "d"].map((d) => `${{ m: "phone", t: "tablet", d: "desktop" }[d]} ${pctOf(cur.devices.get(d) ?? 0, cur.visits)}%`).join(" · ");
  L.push(`_Devices: ${dev}. Visits are counted without cookies: one visit per page load and its in-site navigation. Scott's own devices are excluded once he has opened /admin._`, "");
  return L.join("\n");
}
