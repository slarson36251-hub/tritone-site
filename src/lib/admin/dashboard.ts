// Client controller for /admin: sign-in, loading hits, and drawing every section.
// All numbers come from ./aggregate (pure, tested); this file only fetches and renders.
import { SELF_FLAG, SOURCES, SOURCE_LABELS } from "../analytics-schema.ts";
import type { Hit, Source } from "../analytics-schema.ts";
import * as A from "./aggregate.ts";
import { createAuth, type Auth } from "./auth.ts";
import { fetchHits, FirestoreError } from "./firestore.ts";
import { demoDigests, generateDemo } from "./demo.ts";
import { fetchDigests, weekLabel, type Digest } from "./digests.ts";
import { renderMarkdown } from "./markdown.ts";
import { buildLink, CHANNELS, slugify } from "./links.ts";
import { encodeQr, qrSvg } from "./qr.ts";
import { bar, donut, esc, heatmap, SOURCE_FILL, sparkline, stackedBars, STACK_ORDER } from "./charts.ts";

const API_KEY = (import.meta.env.PUBLIC_FEEDBACK_API_KEY as string | undefined)?.trim() || "";
const COUNT_ME = "tritone:admin-count-me";
const LINKS_KEY = "tritone:admin-links";
const RANGE_KEY = "tritone:admin-range";
const DAY = 864e5;

type RangeKey = "today" | "7d" | "30d" | "90d" | "custom";
interface PageData { shows: { slug: string; title: string; band: string; venue: string; start: string; cancelled: boolean }[]; bands: { slug: string; name: string; tracks: string[] }[]; venues: string[] }
interface SavedLink { url: string; name: string; channel: string; path: string; at: number }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

// ------------------------------------------------------------------ state
let wired = false;
let demo = false;
let auth: Auth;
let page: PageData;
let showsAll: A.ShowDate[] = [];
let rangeKey: RangeKey = "30d";
let custom = { from: "", to: "" };
let compare = true;
let hits: Hit[] = [];
let loadedSpan = { from: 0, to: 0 };
let liveHits: Hit[] = [];
let focus: Source | null = null;
let feedLimit = 12;
let pollTimer: number | undefined;
let resizeTimer: number | undefined;
let abort: AbortController | null = null;
let view: ReturnType<typeof compute> | null = null;
let digests: Digest[] = [];
let digestsLoaded = false;
let digestId = "";
let tipIndex = -1;

// ------------------------------------------------------------------ formatting
const nf = new Intl.NumberFormat("en-US");
const fmtN = (n: number) => nf.format(Math.round(n));
const fmtP = (x: number) => `${Math.round(x * 100)}%`;
const fmt1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const ago = (t: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(t);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};
const dayIso = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const localMidnight = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const showName = (slug: string) => page.shows.find((s) => s.slug === slug)?.title ?? showsAll.find((s) => s.slug === slug)?.title;
const DEV_LABEL = { m: "Phone", t: "Tablet", d: "Desktop" } as const;
const sw = (s: Source) => `<span class="adm-sw" style="background:${SOURCE_FILL[s].css}"></span>`;

function chg(cur: number, prev: number, invert = false, abs = false): string {
  if (!compare) return "";
  if (abs) {
    const d = cur - prev;
    if (Math.abs(d) < 0.005) return `<span class="adm-chg">±0 pts</span>`;
    return `<span class="adm-chg ${d > 0 !== invert ? "is-up" : "is-down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(Math.round(d * 100))} pts</span>`;
  }
  const c = A.change(cur, prev);
  if (c === null) return `<span class="adm-chg is-up">new</span>`;
  if (Math.abs(c) < 0.005) return `<span class="adm-chg">±0%</span>`;
  return `<span class="adm-chg ${c > 0 !== invert ? "is-up" : "is-down"}">${c > 0 ? "▲" : "▼"} ${Math.round(Math.abs(c) * 100)}%</span>`;
}

// ------------------------------------------------------------------ ranges
function rangeFor(key: RangeKey, now = Date.now()) {
  const today = localMidnight(now);
  let from: number, to = now, label: string, prevLabel: string;
  switch (key) {
    case "today": from = today; label = "Today"; prevLabel = "yesterday"; break;
    case "7d": from = today - 6 * DAY; label = "Last 7 days"; prevLabel = "the 7 days before"; break;
    case "90d": from = today - 89 * DAY; label = "Last 90 days"; prevLabel = "the 90 days before"; break;
    case "custom": {
      const f = custom.from ? new Date(custom.from + "T00:00").getTime() : today - 29 * DAY;
      const t = custom.to ? new Date(custom.to + "T00:00").getTime() + DAY : now;
      from = Math.min(f, t - 3600e3);
      to = Math.min(t, now);
      const days = Math.max(1, Math.round((to - from) / DAY));
      label = `${new Date(from).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(to - 1).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
      prevLabel = `the ${days} days before`;
      break;
    }
    default: from = today - 29 * DAY; label = "Last 30 days"; prevLabel = "the 30 days before";
  }
  const len = to - from;
  return { from, to, prevFrom: from - (key === "today" ? DAY : len), prevTo: key === "today" ? to - DAY : from, label, prevLabel };
}

// ------------------------------------------------------------------ compute everything for the current range
function compute() {
  const r = rangeFor(rangeKey);
  const split = A.splitVisits(hits);
  const visits = split.counted;
  const continued = split.continued.filter((v) => A.inRange(v, r.from, r.to)).length;
  const cur = visits.filter((v) => A.inRange(v, r.from, r.to));
  const prev = compare ? visits.filter((v) => A.inRange(v, r.prevFrom, r.prevTo)) : [];
  const bins = A.makeBins(r.from, r.to, rangeKey === "today" ? "hour" : undefined);
  const series = A.trafficBySource(cur, bins.starts);
  const offset = r.from - r.prevFrom;
  const prevSeries = compare ? A.kpiSeries(prev.map((v) => ({ ...v, start: v.start + offset })), bins.starts).visits : undefined;
  return {
    r, cur, prev, bins, series, prevSeries, continued,
    sum: A.summarize(cur), psum: A.summarize(prev),
    kseries: A.kpiSeries(cur, bins.starts),
    sources: A.sourceBreakdown(cur, prev),
  };
}

// ------------------------------------------------------------------ render
function renderAll() {
  view = compute();
  const v = view;
  $("adm-traffic-sub").textContent = `${v.r.label}${compare ? ` · compared with ${v.r.prevLabel}` : ""}`;
  $("adm-continued").textContent = v.continued ? `Plus ${fmtN(v.continued)} continued visit${v.continued === 1 ? "" : "s"} (reloads and new tabs of visits already counted) kept out of the totals.` : "";
  renderKpis();
  renderInsights();
  renderLegend();
  renderTraffic();
  renderSources();
  renderOutreach();
  renderInterest();
  renderPages();
  renderAudience();
  renderFeed();
  renderSaved();
}

function renderKpis() {
  const { sum, psum, kseries } = view!;
  const tiles = [
    { l: "Visitors", v: fmtN(sum.visits), c: chg(sum.visits, psum.visits), s: kseries.visits, lead: true },
    { l: "Page views", v: fmtN(sum.pageViews), c: chg(sum.pageViews, psum.pageViews), s: kseries.pageViews },
    { l: "Pages / visit", v: fmt1(sum.pagesPerVisit), c: chg(sum.pagesPerVisit, psum.pagesPerVisit), s: kseries.pagesPerVisit },
    { l: "Interest actions", v: fmtN(sum.interest), c: chg(sum.interest, psum.interest), s: kseries.interest },
    { l: "Booking requests", v: fmtN(sum.bookings), c: chg(sum.bookings, psum.bookings), s: kseries.bookings },
    { l: "Conversion", v: fmtP(sum.conversion), c: chg(sum.conversion, psum.conversion, false, true), s: kseries.conversion, hint: "visits that took an interest action" },
  ];
  $("adm-kpis").innerHTML = tiles.map((t) => `
    <div class="adm-card adm-kpi${t.lead ? " adm-kpi-lead" : ""}">
      <span class="adm-kpi-l">${t.l}</span>
      <span class="adm-kpi-v">${t.v}</span>
      <span class="adm-kpi-c">${t.c}${compare ? `<span>vs ${esc(view!.r.prevLabel.replace(/^the /, ""))}</span>` : t.hint ? `<span>${t.hint}</span>` : ""}</span>
      ${sparkline(t.s, 120, 34, `${t.l} trend`)}
    </div>`).join("");
}

function renderInsights() {
  const { cur, prev, bins, r } = view!;
  const list = A.insights(cur, prev, { starts: bins.starts, unit: bins.unit, shows: showsAll, showName, periodLabel: compare ? r.prevLabel : "before" });
  const icon = { up: "↑", down: "↓", new: "★", info: "♪" };
  const items = compare || !prev.length ? list : list;
  $("adm-insights").innerHTML = items.map((i) => `<li><span class="adm-ins-i is-${i.tone}" aria-hidden="true">${icon[i.tone]}</span><span>${esc(i.text)}</span></li>`).join("");
}

function renderLegend() {
  const { cur } = view!;
  const counts = Object.fromEntries(SOURCES.map((s) => [s, cur.filter((v) => v.src === s).length]));
  const order = [...STACK_ORDER].reverse();
  $("adm-legend").innerHTML = order.map((s) => `<button type="button" data-src="${s}" aria-pressed="${focus === s}" class="${focus && focus !== s ? "is-dim" : ""}">${sw(s)}${esc(SOURCE_LABELS[s])} <span class="n">${fmtN(counts[s])}</span></button>`).join("");
}

function renderTraffic() {
  const { bins, series, prevSeries, r } = view!;
  const box = $("adm-traffic");
  const width = Math.round(box.clientWidth || 340);
  const height = width < 500 ? 240 : 300;
  const now = Date.now();
  const shows = showsAll.filter((s) => s.start >= r.from - DAY && s.start < r.to + DAY).map((s) => ({ start: s.start, title: s.title, past: s.start < now }));
  const svg = stackedBars({ width, height, starts: bins.starts, unit: bins.unit, series, visible: SOURCES, focus, previous: prevSeries, shows, now });
  const tip = $("adm-tip");
  box.innerHTML = svg;
  box.append(tip);
  tip.hidden = true;
  tipIndex = -1;
  // table view
  const head = `<tr><th>${bins.unit === "hour" ? "Hour" : "Day"}</th>${STACK_ORDER.slice().reverse().map((s) => `<th>${esc(SOURCE_LABELS[s])}</th>`).join("")}<th>Total</th></tr>`;
  const rows = bins.starts.map((t, i) => {
    const vals = STACK_ORDER.slice().reverse().map((s) => series[s][i]);
    return `<tr><td>${esc(binLabel(t))}</td>${vals.map((x) => `<td>${x}</td>`).join("")}<td><b>${vals.reduce((a, b) => a + b, 0)}</b></td></tr>`;
  }).reverse().join("");
  $("adm-traffic-table").innerHTML = `<table>${head}${rows}</table>`;
}

function binLabel(t: number) {
  const d = new Date(t);
  return view!.bins.unit === "hour"
    ? d.toLocaleTimeString("en-US", { hour: "numeric" })
    : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function showTip(i: number) {
  if (!view) return;
  const { bins, series, prevSeries } = view;
  const box = $("adm-traffic");
  const svg = box.querySelector("svg");
  const hit = svg?.querySelector<SVGRectElement>(".hit");
  const cursor = svg?.querySelector<SVGRectElement>(".cursor");
  if (!svg || !hit || !cursor) return;
  i = Math.max(0, Math.min(bins.starts.length - 1, i));
  tipIndex = i;
  const padL = Number(hit.dataset.padl), bw = Number(hit.dataset.bw);
  cursor.setAttribute("x", String(padL + i * bw));
  cursor.setAttribute("visibility", "visible");
  const rows = STACK_ORDER.slice().reverse().filter((s) => series[s][i] > 0);
  const total = SOURCES.reduce((a, s) => a + series[s][i], 0);
  const t0 = bins.starts[i], t1 = bins.starts[i + 1] ?? t0 + (bins.unit === "hour" ? 3600e3 : DAY);
  const show = showsAll.find((s) => s.start >= t0 && s.start < t1);
  const tip = $("adm-tip");
  tip.innerHTML = `<h4>${esc(binLabel(t0))}</h4>${rows.map((s) => `<div class="r"><span>${sw(s)}${esc(SOURCE_LABELS[s])}</span><b>${series[s][i]}</b></div>`).join("") || `<div class="r"><span>No visits</span></div>`}<div class="r t"><span>Total</span><span>${total}</span></div>${prevSeries ? `<div class="r"><span>Previous period</span><span>${prevSeries[i]}</span></div>` : ""}${show ? `<div class="show">♪ ${esc(show.title)}</div>` : ""}`;
  tip.hidden = false;
  const scale = svg.getBoundingClientRect().width / Number(svg.getAttribute("width"));
  const x = (padL + (i + 0.5) * bw) * scale;
  const w = tip.offsetWidth, bwPx = box.clientWidth;
  tip.style.left = `${Math.max(0, Math.min(bwPx - w, x - w / 2))}px`;
  tip.style.top = `${Math.max(0, 30 * scale)}px`;
}
function hideTip() {
  $("adm-tip").hidden = true;
  $("adm-traffic").querySelector(".cursor")?.setAttribute("visibility", "hidden");
  tipIndex = -1;
}

function srcRows<T extends { label: string; visits: number }>(rows: T[], total: number, extra: (r: T) => string, sub: (r: T) => string = () => "", fill: (r: T) => string = () => "#fff", limit = 10): string {
  if (!rows.length) return `<p class="adm-empty">Nothing yet in this range.</p>`;
  const max = Math.max(...rows.map((r) => r.visits), 1);
  const shown = rows.slice(0, limit);
  const fold = shown.length > 6 ? `<button type="button" class="adm-btn adm-btn-ghost adm-more-btn" data-more>Show all ${shown.length}</button>` : "";
  return `<ul class="adm-list">${shown.map((r, i) => `<li class="adm-row${i >= 5 && shown.length > 6 ? " is-extra" : ""}"><span class="adm-row-l"><span class="txt">${esc(r.label)}</span></span><span class="adm-row-v">${extra(r)}</span>${bar(r.visits / max, fill(r))}${sub(r) ? `<span class="adm-row-s">${sub(r)}</span>` : ""}</li>`).join("")}</ul>${fold}`;
}

function renderSources() {
  const { sources, cur, prev } = view!;
  const total = cur.length;
  const stack = `<div class="adm-share-stack" aria-hidden="true">${STACK_ORDER.slice().reverse().filter((s) => sources.find((x) => x.src === s)!.visits).map((s) => `<span style="flex:${sources.find((x) => x.src === s)!.visits};background:${SOURCE_FILL[s].css}"></span>`).join("")}</div>`;
  const rows = [...sources].sort((a, b) => b.visits - a.visits);
  const max = Math.max(1, ...rows.map((r) => r.visits));
  $("adm-sources").innerHTML = total ? stack + rows.map((r) => `
    <div class="adm-src">
      <span class="adm-row-l">${sw(r.src)}<span class="txt">${esc(r.label)}</span></span>
      <span class="adm-row-v">${fmtN(r.visits)}<small>${fmtP(r.share)}</small> ${chg(r.visits, r.prev)}</span>
      <span class="bar"><span style="width:${((r.visits / max) * 100).toFixed(1)}%;background:${SOURCE_FILL[r.src].css}"></span></span>
      <span class="adm-row-s"><span>${fmtN(r.interested)} interested (${r.visits ? fmtP(r.interested / r.visits) : "0%"})</span>${r.bookings ? `<span>${r.bookings} booking${r.bookings === 1 ? "" : "s"}</span>` : ""}<span>${r.visits ? fmt1(r.pageViews / r.visits) : "0"} pages/visit</span></span>
    </div>`).join("") : `<p class="adm-empty">No visits in this range yet.</p>`;

  const ai = A.aiAssistants(cur, prev);
  const aiTotal = ai.reduce((n, r) => n + r.visits, 0);
  const aiPrevShare = prev.length ? prev.filter((v) => v.src === "ai").length / prev.length : 0;
  const share = total ? aiTotal / total : 0;
  $("adm-ai").innerHTML = `<div class="adm-ai-hero"><b>${fmtP(share)}</b><span>of all visits${compare && prev.length ? `, ${share >= aiPrevShare ? "up" : "down"} from ${fmtP(aiPrevShare)}` : ""}</span></div>` +
    (ai.length ? `<ul class="adm-list">${ai.slice(0, 8).map((r) => `<li class="adm-row"><span class="adm-row-l"><span class="adm-ai-mark" aria-hidden="true">${esc(r.label[0])}</span><span class="txt">${esc(r.label)}</span></span><span class="adm-row-v">${fmtN(r.visits)} ${chg(r.visits, r.prev ?? 0)}</span>${bar(r.visits / Math.max(1, ai[0].visits))}<span class="adm-row-s"><span>mostly to ${esc(A.pageName(r.topLanding, showName))}</span><span>${fmtP(r.interested / r.visits)} interested</span>${r.bookings ? `<span>${r.bookings} booking${r.bookings === 1 ? "" : "s"}</span>` : ""}</span></li>`).join("")}</ul>`
      : `<p class="adm-empty">No AI-assistant visits in this range yet. When ChatGPT, Perplexity, Claude or Gemini link to the site, they show up here.</p>`);

  const refs = A.referrers(cur, prev);
  $("adm-refs").innerHTML = srcRows(refs, total,
    (r) => `${fmtN(r.visits)}${r.isNew ? ` <span class="adm-pill-new">new</span>` : ""}`,
    (r) => `<span class="adm-tag">${sw(r.src)}${esc(SOURCE_LABELS[r.src])}</span><span>${fmtP(r.interested / r.visits)} interested</span>`,
    (r) => SOURCE_FILL[r.src].css, 14);
}

function renderOutreach() {
  const { cur } = view!;
  const rows = A.campaigns(cur);
  const fold = rows.length > 6;
  $("adm-campaigns").innerHTML = rows.length ? `<div class="adm-tbl adm-list">
    <div class="adm-tr adm-tr-head"><div>Campaign</div><div>Visits</div><div>Pages/visit</div><div>Interested</div><div>Bookings</div></div>
    ${rows.slice(0, 20).map((r, i) => `
    <div class="adm-tr${fold && i >= 5 ? " is-extra" : ""}">
      <div class="adm-tr-name">${esc(r.label)}<small>${r.sources.slice(0, 4).map((s) => `${esc(A.prettySource(s.source, s.medium))} ${s.visits}`).join(" · ")}${r.tickets ? ` · ${r.tickets} ticket / calendar click${r.tickets === 1 ? "" : "s"}` : ""}</small></div>
      <div class="adm-td">${fmtN(r.visits)}<span>visits</span></div>
      <div class="adm-td">${fmt1(r.pageViews / r.visits)}<span>pages/visit</span></div>
      <div class="adm-td"><em>${fmtN(r.interested)}<small>${fmtP(r.interested / r.visits)}</small></em><span>interested</span></div>
      <div class="adm-td">${fmtN(r.bookings)}<span>bookings</span></div>
    </div>`).join("")}</div>${fold ? `<button type="button" class="adm-btn adm-btn-ghost adm-more-btn" data-more>Show all ${Math.min(20, rows.length)}</button>` : ""}`
    : `<p class="adm-empty">No tagged links used in this range. Build one with the link builder, share it, and its visits land here.</p>`;
}

function renderInterest() {
  const { cur, prev } = view!;
  const f = A.funnel(cur);
  $("adm-funnel").innerHTML = `<div class="adm-funnel">${f.map((s, i) => `
    <div class="adm-fstep">
      <span class="adm-fstep-l">${esc(s.label)}</span>
      <span class="adm-fstep-v">${fmtN(s.visits)}<small>${fmtP(s.rate)}</small></span>
      ${bar(s.rate, i === f.length - 1 ? "#fff" : i === 0 ? "#8a8884" : "#c9c7c2")}
      ${i > 0 && f[i - 1].visits ? `<span class="adm-fdrop">${fmtP(s.visits / f[i - 1].visits)} of the step before</span>` : ""}
    </div>`).join("")}</div>`;

  const ev = A.eventCounts(cur, prev);
  $("adm-events").innerHTML = srcRows(ev.map((e) => ({ ...e, by: e.visits, visits: e.count })), 0,
    (e) => `${fmtN(e.count)} ${chg(e.count, e.prev)}`, (e) => `<span>by ${fmtN(e.by)} visit${e.by === 1 ? "" : "s"}${e.by && e.count > e.by ? ` (${fmt1(e.count / e.by)} each)` : ""}</span>`, (e) => (e.ev === "book_submit" ? "#fff" : "#c9c7c2"), 12);

  const asks = A.bookingDetails(cur);
  const dmax = Math.max(1, ...asks.days.map((d) => d.count));
  $("adm-asks").innerHTML = asks.hours.length || asks.days.some((d) => d.count) ? `<div class="adm-asks"><h4>What booking requests ask for</h4>${asks.hours.length ? `<ul class="adm-chips">${asks.hours.map((h) => `<li>${esc(h.label.replace(" h", "-hour"))}<b>× ${h.count}</b></li>`).join("")}</ul>` : ""}<div class="adm-days" role="img" aria-label="${esc(asks.days.map((d) => `${d.label} ${d.count}`).join(", "))}">${asks.days.map((d) => `<div><i style="height:${Math.round((d.count / dmax) * 100)}%"></i><b>${d.count}</b><span>${d.label}</span></div>`).join("")}</div></div>` : "";

  const why = A.interestBySource(cur);
  const maxRate = Math.max(0.01, ...why.map((w) => w.rate));
  $("adm-why-src").innerHTML = why.length ? `<ul class="adm-list">${why.map((w) => `<li class="adm-row"><span class="adm-row-l">${sw(w.src)}<span class="txt">${esc(w.label)}</span></span><span class="adm-row-v">${fmtP(w.rate)}<small>${w.interested} of ${w.visits}</small></span>${bar(w.rate / maxRate, SOURCE_FILL[w.src].css)}${w.bookings ? `<span class="adm-row-s"><span>${w.bookings} booking request${w.bookings === 1 ? "" : "s"}</span></span>` : ""}</li>`).join("")}</ul>` : `<p class="adm-empty">Nothing yet.</p>`;

  const land = A.landingPages(cur).filter((l) => l.interested > 0).sort((a, b) => b.interested - a.interested);
  $("adm-why-land").innerHTML = srcRows(land.map((l) => ({ ...l, label: A.pageName(l.path, showName), visits: l.interested, total: l.visits })), 0,
    (l) => `${fmtN(l.interested)}<small>${fmtP(l.rate)} of ${l.total}</small>`,
    (l) => `<span>${esc(l.path)}</span><span class="adm-tag">mostly ${sw(l.topSource)}${esc(SOURCE_LABELS[l.topSource])}</span>`, () => "#fff", 8);

  const at = A.attention(cur, showName);
  const block = (title: string, rows: A.AttentionRow[], empty: string) => `<div><h4>${title}</h4>${rows.length ? `<ul class="adm-list">${rows.slice(0, 6).map((r) => `<li class="adm-row"><span class="adm-row-l"><span class="txt" title="${esc(r.label)}">${esc(r.label)}</span></span><span class="adm-row-v">${fmtN(r.count)}</span><span class="adm-row-s"><span>${esc(r.detail)}</span></span></li>`).join("")}</ul>` : `<p class="adm-empty">${empty}</p>`}</div>`;
  $("adm-attn").innerHTML = block("Shows", at.shows, "No show clicks yet.") + block("Posters", at.posters, "No poster views yet.") + block("Tracks played", at.plays, "No plays yet.") + block("Links out", at.outbound, "No outbound clicks yet.");
}

function renderPages() {
  const { cur, prev } = view!;
  const pages = A.topPages(cur, prev);
  $("adm-pages").innerHTML = srcRows(pages.map((p) => ({ ...p, label: A.pageName(p.path, showName), visits: p.views })), 0,
    (p) => `${fmtN(p.views)} ${chg(p.views, p.prev)}`,
    (p) => `<span>${esc(p.path)}</span><span>${fmtN((p as any).actions)} actions</span>`, () => "#c9c7c2", 12);
  const land = A.landingPages(cur);
  $("adm-landing").innerHTML = srcRows(land.map((l) => ({ ...l, label: A.pageName(l.path, showName) })), 0,
    (l) => `${fmtN(l.visits)}`,
    (l) => `<span>${fmt1(l.pagesPerVisit)} pages/visit</span><span>${fmtP(l.rate)} interested</span><span class="adm-tag">${sw(l.topSource)}${esc(SOURCE_LABELS[l.topSource])}</span>`, () => "#fff", 12);
}

function renderAudience() {
  const { cur } = view!;
  const dev = A.devices(cur);
  const fills = { m: "#ffffff", d: "#a8a6a1", t: "#5f5e5d" } as const;
  $("adm-devices").innerHTML = cur.length ? `<div class="adm-dev">${donut(dev.map((d) => ({ label: d.label, share: d.share, fill: fills[d.key] })))}<ul>${dev.map((d) => `<li><span class="adm-sw" style="background:${fills[d.key]}"></span>${d.label}<b>${fmtP(d.share)}</b></li>`).join("")}</ul></div>` : `<p class="adm-empty">Nothing yet.</p>`;
  const reg = A.regions(cur);
  $("adm-regions").innerHTML = srcRows(reg, 0, (r) => `${fmtN(r.visits)}<small>${fmtP(r.share)}</small>`, () => "", () => "#c9c7c2", 10);
  renderHeat();
  const langs = A.languages(cur);
  const names = new Intl.DisplayNames(["en"], { type: "language" });
  $("adm-langs").innerHTML = srcRows(langs.map((l) => ({ ...l, label: (() => { try { return names.of(l.key) ?? l.key; } catch { return l.key; } })() })), 0, (l) => fmtN(l.visits), () => "", () => "#8a8884", 6);
}

function renderHeat() {
  const box = $("adm-heat");
  box.innerHTML = view!.cur.length ? heatmap(A.weekHourGrid(view!.cur), Math.round(box.clientWidth || 340)) : `<p class="adm-empty">Nothing yet.</p>`;
}

function renderFeed() {
  const { cur } = view!;
  const list = A.journeys(cur, feedLimit);
  $("adm-feed").innerHTML = list.length ? list.map((j) => {
    const steps: string[] = [];
    j.steps.slice(0, 9).forEach((s, i) => {
      if (i) steps.push(`<li class="arr" aria-hidden="true">→</li>`);
      steps.push(`<li class="${s.kind === "event" ? "ev" : ""}">${esc(s.kind === "page" ? A.pageName(s.text, showName) : s.text)}</li>`);
    });
    if (j.steps.length > 9) steps.push(`<li class="arr">+${j.steps.length - 9} more</li>`);
    return `<li><div class="adm-feed-top">${sw(j.src)}<b>${esc(j.origin)}</b><span>${DEV_LABEL[j.dev]}</span><span>${esc(j.region)}</span>${j.booked ? `<span class="adm-badge">Booking request</span>` : j.interested ? `<span class="adm-badge is-ghost">Interested</span>` : ""}<span class="when">${ago(j.start)}</span></div><ol class="adm-steps">${steps.join("")}</ol></li>`;
  }).join("") : `<li class="adm-empty">No visits in this range yet.</li>`;
  $("adm-more").hidden = cur.length <= feedLimit;
}

// ------------------------------------------------------------------ weekly report
function renderDigest() {
  const box = $("adm-digest");
  const pick = $<HTMLSelectElement>("adm-digest-pick");
  if (!digestsLoaded) { box.innerHTML = `<p class="adm-empty">Loading the latest report…</p>`; pick.hidden = true; return; }
  if (!digests.length) {
    pick.hidden = true;
    box.innerHTML = `<div class="adm-digest-empty"><p class="adm-digest-empty-h">Your first weekly report arrives Monday.</p><p class="adm-muted">Every Monday a summary of the week (visits, sources, AI assistants, outreach links, bookings) lands here and on the “Weekly site analytics” issue.</p></div>`;
    return;
  }
  const d = digests.find((x) => x.id === digestId) ?? digests[0];
  digestId = d.id;
  pick.hidden = digests.length < 2;
  pick.innerHTML = digests.map((x) => `<option value="${esc(x.id)}"${x.id === d.id ? " selected" : ""}>${x === digests[0] ? "Latest: " : ""}${esc(weekLabel(x.id))}</option>`).join("");
  // The headline (title + numbers) shows; the full report folds under it.
  const cut = d.md.search(/^#{3,}\s/m);
  const lead = cut > 0 ? d.md.slice(0, cut) : d.md;
  const rest = cut > 0 ? d.md.slice(cut) : "";
  box.innerHTML = `<div class="adm-md adm-md-lead">${renderMarkdown(lead)}</div>${rest ? `<details class="adm-digest-more"><summary>Read the full report</summary><div class="adm-md">${renderMarkdown(rest)}</div></details>` : ""}${d.createdAt ? `<p class="adm-sub adm-digest-foot">Written ${esc(new Date(d.createdAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }))}.</p>` : ""}`;
}

async function loadDigests() {
  if (demo) { digests = demoDigests(Date.now()); digestsLoaded = true; renderDigest(); return; }
  try {
    const token = await auth.getIdToken();
    digests = await fetchDigests(token);
    digestsLoaded = true;
    renderDigest();
  } catch (e: any) {
    digestsLoaded = true;
    digests = [];
    renderDigest();
    if (e?.message) $("adm-digest").innerHTML = `<p class="adm-empty">Couldn't load the weekly reports: ${esc(e.message)}</p>`;
  }
}

function renderLive(now = Date.now()) {
  const live = A.liveNow(liveHits, now);
  const n = live.length;
  $("adm-live").innerHTML = `<span class="adm-live-n"><span class="adm-dot ${n ? "is-on" : "is-off"}" aria-hidden="true"></span><b>${n}</b> on the site now</span>${n ? `<ul class="adm-live-list">${live.slice(0, 6).map((l) => `<li>${esc(A.pageName(l.page, showName))} · ${esc(l.origin)} · ${DEV_LABEL[l.dev]}</li>`).join("")}</ul>` : `<span class="adm-live-meta">Nobody in the last 5 minutes.</span>`}<span class="adm-live-meta">Updated ${new Date(now).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>`;
}

// ------------------------------------------------------------------ link builder
function savedLinks(): SavedLink[] {
  try { return JSON.parse(ls.get(LINKS_KEY) ?? "[]").filter((l: SavedLink) => typeof l?.url === "string"); } catch { return []; }
}
function renderSaved() {
  const links = savedLinks();
  const box = $("lb-saved");
  if (!links.length) { box.innerHTML = ""; return; }
  const visits = view?.cur ?? [];
  box.innerHTML = `<div class="adm-saved"><h4>Saved links</h4><ul class="adm-list">${links.map((l, i) => {
    const u = new URL(l.url);
    const camp = u.searchParams.get("utm_campaign") ?? "", src = u.searchParams.get("utm_source") ?? "";
    const n = visits.filter((v) => v.uc.toLowerCase() === camp && v.us.toLowerCase() === src).length;
    return `<li><button type="button" class="lnk" data-load="${i}"><b>${esc(l.name)}</b><span>${esc(CHANNELS.find((c) => c.id === l.channel)?.label ?? l.channel)} · ${esc(u.pathname)}</span></button><span class="cnt">${n} visit${n === 1 ? "" : "s"}</span><button type="button" class="adm-x" data-del="${i}" aria-label="Remove ${esc(l.name)}">×</button></li>`;
  }).join("")}</ul></div>`;
}

function currentLink() {
  return buildLink({ path: $<HTMLSelectElement>("lb-page").value, name: $<HTMLInputElement>("lb-name").value, channel: $<HTMLSelectElement>("lb-channel").value, content: $<HTMLInputElement>("lb-content").value });
}
function updateLink() {
  const url = currentLink();
  $("lb-out").hidden = !url;
  if (!url) return;
  $("lb-url").textContent = url;
  $("lb-qr").innerHTML = qrSvg(encodeQr(url), { px: 240, title: "QR code for " + url });
  $("lb-copy").textContent = "Copy link";
  $("lb-copy").classList.remove("is-done");
}
function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function qrPng(url: string) {
  const qr = encodeQr(url);
  const scale = 24, q = 4, dim = (qr.size + q * 2) * scale;
  const c = document.createElement("canvas");
  c.width = c.height = dim;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, dim, dim);
  g.fillStyle = "#000";
  qr.modules.forEach((row, y) => row.forEach((on, x) => { if (on) g.fillRect((x + q) * scale, (y + q) * scale, scale, scale); }));
  c.toBlob((b) => b && download(`qr-${slugify(new URL(url).searchParams.get("utm_campaign") ?? "link")}.png`, b), "image/png");
}

function wireLinkBuilder() {
  const sel = $<HTMLSelectElement>("lb-page");
  const now = Date.now();
  const upcoming = page.shows.filter((s) => !s.cancelled && Date.parse(s.start) > now - DAY);
  const opt = (v: string, l: string) => `<option value="${esc(v)}">${esc(l)}</option>`;
  sel.innerHTML =
    `<optgroup label="Pages">${[["/", "Home"], ["/book-the-hut", "Book the Hut"], ["/hummingbird-hut", "Hummingbird Hut"], ["/shows", "Shows"], ["/listen", "Listen"], ["/sessions", "Sessions (portfolio)"], ["/bands", "Bands"], ["/free-track", "Free track"], ["/contact", "Contact"]].map(([v, l]) => opt(v, l)).join("")}</optgroup>` +
    (upcoming.length ? `<optgroup label="Upcoming shows">${upcoming.map((s) => opt(`/shows/${s.slug}`, `${new Date(s.start).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${s.title}`)).join("")}</optgroup>` : "") +
    `<optgroup label="Bands">${page.bands.map((b) => opt(`/bands/${b.slug}`, b.name)).join("")}</optgroup>`;
  $("lb-venues").innerHTML = [...new Set([...page.venues, ...page.bands.map((b) => b.name)])].map((v) => `<option value="${esc(v)}"></option>`).join("");
  sel.addEventListener("change", () => {
    const show = page.shows.find((s) => `/shows/${s.slug}` === sel.value);
    const name = $<HTMLInputElement>("lb-name");
    if (show && !name.value) name.value = show.venue;
    updateLink();
  });
  for (const id of ["lb-name", "lb-channel", "lb-content"]) $(id).addEventListener("input", updateLink);
  $("lb-channel").addEventListener("change", updateLink);
  $("adm-lb").addEventListener("submit", (e) => e.preventDefault());
  $("lb-copy").addEventListener("click", async () => {
    const url = currentLink();
    if (!url) return;
    try { await navigator.clipboard.writeText(url); } catch {
      const r = document.createRange(); r.selectNodeContents($("lb-url")); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); document.execCommand?.("copy");
    }
    $("lb-copy").textContent = "Copied ✓";
    $("lb-copy").classList.add("is-done");
  });
  $("lb-save").addEventListener("click", () => {
    const url = currentLink();
    if (!url) return;
    const links = savedLinks().filter((l) => l.url !== url);
    links.unshift({ url, name: $<HTMLInputElement>("lb-name").value.trim(), channel: $<HTMLSelectElement>("lb-channel").value, path: sel.value, at: Date.now() });
    ls.set(LINKS_KEY, JSON.stringify(links.slice(0, 30)));
    renderSaved();
    $("lb-save").textContent = "Saved ✓";
    setTimeout(() => ($("lb-save").textContent = "Save"), 1600);
  });
  $("lb-png").addEventListener("click", () => { const u = currentLink(); if (u) qrPng(u); });
  $("lb-svg").addEventListener("click", () => {
    const u = currentLink();
    if (u) download(`qr-${slugify(new URL(u).searchParams.get("utm_campaign") ?? "link")}.svg`, new Blob([qrSvg(encodeQr(u), { px: 1024 })], { type: "image/svg+xml" }));
  });
  $("lb-saved").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("button");
    if (!t) return;
    const links = savedLinks();
    if (t.dataset.del) {
      links.splice(Number(t.dataset.del), 1);
      ls.set(LINKS_KEY, JSON.stringify(links));
      renderSaved();
    } else if (t.dataset.load) {
      const l = links[Number(t.dataset.load)];
      if (!l) return;
      const u = new URL(l.url);
      sel.value = l.path;
      $<HTMLInputElement>("lb-name").value = l.name;
      $<HTMLSelectElement>("lb-channel").value = l.channel;
      $<HTMLInputElement>("lb-content").value = u.searchParams.get("utm_content") ?? "";
      updateLink();
    }
  });
}

// ------------------------------------------------------------------ loading
function status(text: string, kind: "" | "busy" | "error" = "") {
  const el = $("adm-status");
  el.className = "adm-status" + (kind === "error" ? " is-error" : "");
  el.innerHTML = (kind === "busy" ? `<span class="adm-spin" aria-hidden="true"></span>` : "") + esc(text);
}

async function load(force = false) {
  const r = rangeFor(rangeKey);
  const need = { from: compare ? r.prevFrom : r.from, to: r.to };
  const stale = Date.now() - loadedSpan.to > 60e3;
  if (demo) {
    renderAll();
    status(`Demo data · ${r.label}`);
    return;
  }
  if (!force && !stale && need.from >= loadedSpan.from && need.to <= loadedSpan.to + 60e3 && hits.length) {
    renderAll();
    status(`Updated ${new Date(loadedSpan.to).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);
    return;
  }
  abort?.abort();
  abort = new AbortController();
  $("adm").dataset.state = "loading";
  status("Loading visits…", "busy");
  try {
    const token = await auth.getIdToken();
    const to = Date.now() + 60e3;
    hits = await fetchHits(token, new Date(need.from), new Date(to), { signal: abort.signal, onPage: (n) => status(`Loading visits… ${fmtN(n)} so far`, "busy") });
    loadedSpan = { from: need.from, to: Date.now() };
    liveHits = hits.filter((h) => Date.now() - Date.parse(h.t) < A.LIVE_WINDOW);
    renderAll();
    renderLive();
    status(`${fmtN(hits.length)} hits loaded · updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    if (e instanceof FirestoreError && e.status === 401) { auth.signOut(); return showAuth(e.message, true); }
    if (e?.code && !(e instanceof FirestoreError) && e.code !== "NETWORK") return showAuth(e.message, true);
    status(e?.message ?? "Couldn't load the numbers.", "error");
  } finally {
    $("adm").dataset.state = "ready";
  }
}

async function pollLive() {
  if (document.visibilityState !== "visible") return;
  if (demo) { renderLive(); return; }
  try {
    const token = await auth.getIdToken();
    const now = Date.now();
    liveHits = await fetchHits(token, new Date(now - A.LIVE_WINDOW), new Date(now + 60e3), { max: 2000 });
    renderLive(now);
  } catch { /* the next poll tries again */ }
}
function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(pollLive, 30e3);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = undefined; }

// ------------------------------------------------------------------ auth UI
function showAuth(message = "", error = false) {
  stopPolling();
  $("adm-app").hidden = true;
  $("adm-head-actions").hidden = true;
  $("adm-auth").hidden = false;
  $("adm-who").textContent = "";
  const msg = $("adm-auth-msg");
  msg.hidden = !message;
  msg.textContent = message;
  msg.classList.toggle("is-error", error);
  $("adm").dataset.state = "auth";
}

function showApp() {
  $("adm-auth").hidden = true;
  $("adm-app").hidden = false;
  $("adm-head-actions").hidden = false;
  $("adm-signout").hidden = demo;
  $("adm-who").textContent = demo ? "Previewing with generated sample data" : `Signed in as ${auth.email}`;
  syncRangeButtons();
  load();
  loadDigests();
  pollLive();
  startPolling();
}

async function handleSignInLink(): Promise<boolean> {
  const q = new URLSearchParams(location.search);
  const code = q.get("oobCode");
  if (!code || (q.get("mode") && q.get("mode") !== "signIn")) return false;
  const clean = () => history.replaceState(history.state, "", location.pathname);
  let email = auth.pendingEmail();
  if (!email) {
    // Link opened on another device: ask which email it was sent to.
    showAuth("Confirm the email this sign-in link was sent to.");
    $("adm-auth-btn").textContent = "Finish signing in";
    $("adm-auth-form").dataset.code = code;
    clean();
    return true;
  }
  showAuth("Signing you in…");
  try {
    await auth.completeSignIn(email, code);
    clean();
    showApp();
  } catch (e: any) {
    clean();
    showAuth(e?.message ?? "Sign-in failed.", true);
  }
  return true;
}

function wireAuth() {
  const form = $<HTMLFormElement>("adm-auth-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $<HTMLInputElement>("adm-email").value.trim();
    const btn = $<HTMLButtonElement>("adm-auth-btn");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showAuth("That doesn't look like an email address.", true);
    btn.disabled = true;
    try {
      if (form.dataset.code) {
        await auth.completeSignIn(email, form.dataset.code);
        delete form.dataset.code;
        btn.textContent = "Email me a sign-in link";
        showApp();
      } else {
        await auth.sendSignInLink(email, location.origin + "/admin");
        showAuth(`Check your inbox at ${email}. Open the link on this phone or computer and you'll land back here, signed in. (Check spam if it hasn't arrived in a minute.)`);
      }
    } catch (err: any) {
      showAuth(err?.message ?? "Something went wrong.", true);
    } finally {
      btn.disabled = false;
    }
  });
  $("adm-signout").addEventListener("click", () => {
    auth.signOut();
    hits = [];
    digests = [];
    digestsLoaded = false;
    loadedSpan = { from: 0, to: 0 };
    showAuth("Signed out.");
  });
}

// ------------------------------------------------------------------ controls
function syncRangeButtons() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#adm-range button")) b.setAttribute("aria-pressed", String(b.dataset.range === rangeKey));
  $("adm-custom").hidden = rangeKey !== "custom";
  const cmp = $("adm-compare");
  cmp.setAttribute("aria-checked", String(compare));
}

function wireControls() {
  $("adm-range").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-range]");
    if (!b) return;
    rangeKey = b.dataset.range as RangeKey;
    ls.set(RANGE_KEY, rangeKey);
    if (rangeKey === "custom" && !custom.from) {
      custom = { from: dayIso(Date.now() - 13 * DAY), to: dayIso(Date.now()) };
      $<HTMLInputElement>("adm-from").value = custom.from;
      $<HTMLInputElement>("adm-to").value = custom.to;
    }
    syncRangeButtons();
    feedLimit = 12;
    load();
  });
  const max = dayIso(Date.now());
  $<HTMLInputElement>("adm-from").max = max;
  $<HTMLInputElement>("adm-to").max = max;
  $("adm-apply").addEventListener("click", () => {
    custom = { from: $<HTMLInputElement>("adm-from").value, to: $<HTMLInputElement>("adm-to").value };
    if (custom.from && custom.to && custom.from > custom.to) custom = { from: custom.to, to: custom.from };
    load();
  });
  $("adm-compare").addEventListener("click", () => {
    compare = !compare;
    syncRangeButtons();
    load();
  });
  $("adm-refresh").addEventListener("click", () => { if (demo) { regenerateDemo(); load(); } else load(true); });
  $("adm-csv").addEventListener("click", () => {
    const r = rangeFor(rangeKey);
    const rows = hits.filter((h) => { const t = Date.parse(h.t); return t >= r.from && t < r.to; });
    download(`tritone-visits-${dayIso(r.from)}-to-${dayIso(r.to - 1)}${demo ? "-DEMO" : ""}.csv`, new Blob([A.toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  });
  $("adm-legend").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-src]");
    if (!b) return;
    const s = b.dataset.src as Source;
    focus = focus === s ? null : s;
    renderLegend();
    renderTraffic();
  });
  $("adm-more").addEventListener("click", () => { feedLimit += 20; renderFeed(); });
  $("adm-digest-pick").addEventListener("change", (e) => { digestId = (e.target as HTMLSelectElement).value; renderDigest(); });
  $("adm-app").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-more]");
    if (b) b.previousElementSibling?.classList.add("is-open");
  });

  const chart = $("adm-traffic");
  const indexAt = (clientX: number) => {
    const svg = chart.querySelector("svg");
    const hit = svg?.querySelector<SVGRectElement>(".hit");
    if (!svg || !hit) return -1;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / Number(svg.getAttribute("width"));
    const x = (clientX - rect.left) / scale - Number(hit.dataset.padl);
    return Math.floor(x / Number(hit.dataset.bw));
  };
  chart.addEventListener("pointermove", (e) => { const i = indexAt(e.clientX); if (i >= 0 && i < (view?.bins.starts.length ?? 0)) showTip(i); else hideTip(); });
  chart.addEventListener("pointerdown", (e) => { const i = indexAt(e.clientX); if (i >= 0) showTip(i); });
  chart.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hideTip(); });
  chart.addEventListener("keydown", (e) => {
    if (!view) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      showTip(tipIndex < 0 ? view.bins.starts.length - 1 : tipIndex + (e.key === "ArrowRight" ? 1 : -1));
    } else if (e.key === "Escape") hideTip();
  });
  chart.addEventListener("blur", hideTip);

  window.addEventListener("resize", onResize);
  document.addEventListener("visibilitychange", onVisible);
}
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { if (view) { renderTraffic(); renderHeat(); } }, 150);
}
function onVisible() { if (document.visibilityState === "visible" && !$("adm-app")?.hidden) pollLive(); }

// "Don't count my visits": on by default once Scott opens /admin in a browser.
function wireSelf() {
  const btn = $("adm-self");
  const sync = () => {
    const on = ls.get(SELF_FLAG) === "1";
    btn.setAttribute("aria-checked", String(on));
    $("adm-self-label").textContent = on ? "Not counting my visits in this browser" : "Counting my visits in this browser";
  };
  if (ls.get(COUNT_ME) !== "1") ls.set(SELF_FLAG, "1");
  sync();
  btn.addEventListener("click", () => {
    if (ls.get(SELF_FLAG) === "1") { ls.del(SELF_FLAG); ls.set(COUNT_ME, "1"); }
    else { ls.set(SELF_FLAG, "1"); ls.del(COUNT_ME); }
    sync();
  });
}

function regenerateDemo() {
  const now = Date.now();
  const real = page.shows.filter((s) => !s.cancelled).map((s) => ({ slug: s.slug, title: s.title, band: s.band, venue: s.venue, start: Date.parse(s.start) }));
  const d = generateDemo({ now, shows: real, bands: page.bands.map((b) => ({ slug: b.slug, name: b.name })), tracks: page.bands.flatMap((b) => b.tracks).slice(0, 12) });
  hits = d.hits;
  liveHits = d.hits.filter((h) => now - Date.parse(h.t) < A.LIVE_WINDOW);
  showsAll = d.shows.map((s) => ({ slug: s.slug, title: s.title, start: s.start }));
}

// ------------------------------------------------------------------ entry
export function init() {
  const root = $("adm");
  if (!root || root.dataset.wired) return;
  root.dataset.wired = "1";
  wired = true;
  try { page = JSON.parse($("adm-data").textContent || "{}"); } catch { page = { shows: [], bands: [], venues: [] }; }
  page.shows ??= []; page.bands ??= []; page.venues ??= [];
  showsAll = page.shows.filter((s) => !s.cancelled).map((s) => ({ slug: s.slug, title: s.title, start: Date.parse(s.start) }));
  const saved = ls.get(RANGE_KEY) as RangeKey | null;
  if (saved && ["today", "7d", "30d", "90d"].includes(saved)) rangeKey = saved;
  demo = new URLSearchParams(location.search).get("demo") === "1";
  auth = createAuth(API_KEY);

  wireSelf();
  wireControls();
  wireLinkBuilder();
  wireAuth();

  if (demo) {
    $("adm-demo").hidden = false;
    document.title = "DEMO · Visitors · Tritone admin";
    regenerateDemo();
    // Show the link builder doing its thing: a flyer QR for the next show (or the Hut).
    const next = page.shows.find((s) => !s.cancelled && Date.parse(s.start) > Date.now());
    const sel = $<HTMLSelectElement>("lb-page");
    sel.value = next ? `/shows/${next.slug}` : "/book-the-hut";
    $<HTMLInputElement>("lb-name").value = next ? next.venue : "Hut open house";
    $<HTMLSelectElement>("lb-channel").value = "flyer";
    updateLink();
    showApp();
    return;
  }
  handleSignInLink().then((handled) => {
    if (handled) return;
    if (auth.signedIn) showApp();
    else showAuth(API_KEY ? "" : "This build has no Firebase API key, so sign-in can't work here. Use the demo preview instead.", !API_KEY);
  });
}

export function teardown() {
  if (!wired) return;
  wired = false;
  stopPolling();
  abort?.abort();
  window.removeEventListener("resize", onResize);
  document.removeEventListener("visibilitychange", onVisible);
}
