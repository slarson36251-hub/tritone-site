// Inline-SVG chart builders for the dashboard (no chart library). Brand palette only: white,
// stone #A8A6A1 and its tints / shades, with stripes and dots telling neighbouring series apart.
import type { Source } from "../analytics-schema.ts";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Fill for each source: a solid tone, or a pattern id defined by patternDefs(). Bottom-to-top stack order. */
export const STACK_ORDER: Source[] = ["direct", "referral", "search", "social", "email", "campaign", "ai"];
export const SOURCE_FILL: Record<Source, { fill: string; css: string }> = {
  ai: { fill: "#ffffff", css: "#ffffff" },
  campaign: { fill: "url(#p-campaign)", css: "repeating-linear-gradient(45deg,#fff 0 2.5px,transparent 2.5px 5.5px)" },
  email: { fill: "url(#p-email)", css: "radial-gradient(circle,#d4d2ce 1.3px,transparent 1.6px) 0 0/5px 5px" },
  social: { fill: "url(#p-social)", css: "repeating-linear-gradient(-45deg,#a8a6a1 0 2.5px,transparent 2.5px 5.5px)" },
  search: { fill: "#c9c7c2", css: "#c9c7c2" },
  referral: { fill: "#8a8884", css: "#8a8884" },
  direct: { fill: "#5f5e5d", css: "#5f5e5d" },
};

export function patternDefs(): string {
  return `<defs>
<pattern id="p-campaign" width="5.5" height="5.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5.5" height="5.5" fill="rgba(255,255,255,.14)"/><rect width="2.6" height="5.5" fill="#fff"/></pattern>
<pattern id="p-social" width="5.5" height="5.5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="5.5" height="5.5" fill="rgba(168,166,161,.16)"/><rect width="2.6" height="5.5" fill="#a8a6a1"/></pattern>
<pattern id="p-email" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="rgba(212,210,206,.14)"/><circle cx="2.5" cy="2.5" r="1.35" fill="#d4d2ce"/></pattern>
</defs>`;
}

/** Tiny trend line with a soft area, for KPI tiles. */
export function sparkline(values: number[], w = 120, h = 34, label = ""): string {
  if (!values.length) return "";
  const max = Math.max(...values, 1e-9);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => [i * step, h - 3 - (v / max) * (h - 6)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  const area = `${line}L${w} ${h}L0 ${h}Z`;
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><path d="${area}" fill="rgba(255,255,255,.08)"/><path d="${line}" fill="none" stroke="#fff" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.4" fill="#fff"/></svg>`;
}

/** Smallest "round" axis top >= v that splits into four whole, round ticks (4, 8, 20, 40, 100, 200, ...). */
export function niceMax(v: number): number {
  const step = Math.max(1, v / 4);
  const p = Math.pow(10, Math.floor(Math.log10(step)));
  for (const m of [1, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= step && Number.isInteger(m * p)) return m * p * 4;
  return 10 * p * 4;
}

export interface StackInput {
  width: number;
  height: number;
  starts: number[];
  unit: "hour" | "day";
  series: Record<Source, number[]>;
  visible: Source[]; // stacked bottom-to-top in STACK_ORDER
  focus?: Source | null;
  previous?: number[]; // previous period totals, drawn as a dashed line
  shows?: { start: number; title: string; past: boolean }[];
  now: number;
}

/** Stacked bars of visits per bin, with show-date markers and an optional previous-period line. */
export function stackedBars(o: StackInput): string {
  const padL = 34, padR = 8, padT = 26, padB = 26;
  const W = Math.max(280, o.width), H = o.height;
  const n = o.starts.length;
  const order = STACK_ORDER.filter((s) => o.visible.includes(s));
  const totals = o.starts.map((_, i) => order.reduce((a, s) => a + (o.series[s][i] ?? 0), 0));
  const max = niceMax(Math.max(1, ...totals, ...(o.previous ?? [])));
  const iw = W - padL - padR, ih = H - padT - padB;
  const bw = iw / n;
  const gap = bw > 6 ? Math.min(4, bw * 0.22) : bw > 3 ? 1 : 0;
  const y = (v: number) => padT + ih - (v / max) * ih;
  let out = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chart" role="img" aria-label="Visits over time by source">${patternDefs()}`;
  // grid
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    const yy = y(v);
    out += `<line x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="rgba(168,166,161,${k ? 0.16 : 0.45})" stroke-width="1"/>`;
    out += `<text x="${padL - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end" class="ax">${Math.round(v)}</text>`;
  }
  // show markers
  const span = n > 1 ? o.starts[n - 1] - o.starts[0] : 1;
  const binMs = n > 1 ? span / (n - 1) : o.unit === "hour" ? 3600e3 : 864e5;
  for (const s of o.shows ?? []) {
    const i = (s.start - o.starts[0]) / binMs;
    if (i < 0 || i >= n) continue;
    const x = padL + (Math.floor(i) + 0.5) * bw;
    out += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${padT - 6}" y2="${padT + ih}" stroke="#fff" stroke-opacity=".55" stroke-dasharray="2 3"/>`;
    out += `<g class="show-mark"><circle cx="${x.toFixed(1)}" cy="${padT - 13}" r="7.5" fill="${s.past ? "#38383b" : "#fff"}" stroke="#fff" stroke-width="1.5"/><path d="M${(x - 2).toFixed(1)} ${padT - 9.5}v-6.5l4.5 -1.4v6.2" fill="none" stroke="${s.past ? "#fff" : "#000"}" stroke-width="1.3" stroke-linecap="round"/><circle cx="${(x - 3).toFixed(1)}" cy="${padT - 9.4}" r="1.5" fill="${s.past ? "#fff" : "#000"}"/><circle cx="${(x + 1.5).toFixed(1)}" cy="${padT - 10.8}" r="1.5" fill="${s.past ? "#fff" : "#000"}"/><title>${esc(s.title)}</title></g>`;
  }
  // bars
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const x = padL + i * bw + gap / 2;
    const w = Math.max(0.6, bw - gap);
    const segs = order.filter((s) => (o.series[s][i] ?? 0) > 0);
    segs.forEach((s, j) => {
      const v = o.series[s][i];
      const y0 = y(acc), y1 = y(acc + v);
      acc += v;
      const top = j === segs.length - 1;
      const h = Math.max(0.5, y0 - y1 - (top ? 0 : 1.5));
      const dim = o.focus && o.focus !== s;
      const r = top && w > 5 ? Math.min(3, w / 2) : 0;
      const fill = SOURCE_FILL[s].fill;
      const op = dim ? ' opacity=".18"' : "";
      if (r) {
        // rounded data-end on top, square at the stack
        const yt = y1, yb = y1 + h;
        out += `<path d="M${x.toFixed(1)} ${yb.toFixed(1)}V${(yt + r).toFixed(1)}Q${x.toFixed(1)} ${yt.toFixed(1)} ${(x + r).toFixed(1)} ${yt.toFixed(1)}H${(x + w - r).toFixed(1)}Q${(x + w).toFixed(1)} ${yt.toFixed(1)} ${(x + w).toFixed(1)} ${(yt + r).toFixed(1)}V${yb.toFixed(1)}Z" fill="${fill}"${op}/>`;
      } else {
        out += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"${op}/>`;
      }
    });
  }
  // previous period line
  if (o.previous && o.previous.length === n) {
    const d = o.previous.map((v, i) => `${i ? "L" : "M"}${(padL + (i + 0.5) * bw).toFixed(1)} ${y(v).toFixed(1)}`).join("");
    out += `<path d="${d}" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="4 4" stroke-opacity=".7"/>`;
  }
  // x labels
  const fmt = (t: number) => {
    const d = new Date(t);
    return o.unit === "hour" ? d.toLocaleTimeString("en-US", { hour: "numeric" }) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const maxLabels = Math.max(2, Math.floor(iw / 64));
  const every = Math.ceil(n / maxLabels);
  for (let i = 0; i < n; i += every) {
    const x = padL + (i + 0.5) * bw;
    out += `<text x="${x.toFixed(1)}" y="${H - 7}" text-anchor="${i === 0 ? "start" : "middle"}" class="ax">${esc(fmt(o.starts[i]))}</text>`;
  }
  // hover cursor + hit area
  out += `<rect class="cursor" x="0" y="${padT}" width="${bw.toFixed(1)}" height="${ih}" fill="rgba(255,255,255,.1)" visibility="hidden"/>`;
  out += `<rect class="hit" x="${padL}" y="0" width="${iw}" height="${H}" fill="transparent" data-padl="${padL}" data-bw="${bw}" data-n="${n}"/>`;
  return out + "</svg>";
}

/** Weekday x hour heatmap: stone wash from faint to white by visits. */
export function heatmap(grid: number[][], width: number): string {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const padL = 40, padT = 4, padB = 22;
  const W = Math.max(300, width);
  const cw = (W - padL) / 24, ch = Math.min(28, Math.max(18, cw * 1.1));
  const H = padT + ch * 7 + padB;
  const max = Math.max(1, ...grid.flat());
  let out = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Visits by weekday and hour">`;
  grid.forEach((row, d) => {
    out += `<text x="0" y="${(padT + d * ch + ch / 2 + 4.5).toFixed(1)}" class="ax">${days[d]}</text>`;
    row.forEach((n, h) => {
      const a = n ? 0.1 + 0.9 * (n / max) : 0.04;
      out += `<rect x="${(padL + h * cw + 1).toFixed(1)}" y="${(padT + d * ch + 1).toFixed(1)}" width="${Math.max(1, cw - 2).toFixed(1)}" height="${(ch - 2).toFixed(1)}" rx="3" fill="${n / max > 0.55 ? "#fff" : "#c9c7c2"}" fill-opacity="${a.toFixed(2)}"><title>${days[d]} ${h % 12 || 12}${h < 12 ? " am" : " pm"}: ${n} visit${n === 1 ? "" : "s"}</title></rect>`;
    });
  });
  for (const h of [0, 6, 12, 18]) out += `<text x="${(padL + h * cw + 1).toFixed(1)}" y="${H - 5}" class="ax">${h === 0 ? "12 am" : h === 12 ? "noon" : h < 12 ? `${h} am` : `${h - 12} pm`}</text>`;
  return out + "</svg>";
}

/** Thin horizontal share bar (HTML) for ranked lists. */
export function bar(share: number, fill = "#fff"): string {
  const pctW = Math.max(0, Math.min(100, share * 100));
  return `<span class="bar"><span style="width:${pctW.toFixed(1)}%;background:${fill}"></span></span>`;
}

/** Device split as a donut (SVG), with the biggest share in the middle. */
export function donut(parts: { label: string; share: number; fill: string }[], size = 132): string {
  const r = size / 2 - 10, c = 2 * Math.PI * r;
  let off = 0;
  let out = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${Math.round(p.share * 100)}%`).join(", "))}">`;
  out += `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(168,166,161,.18)" stroke-width="14"/>`;
  for (const p of parts) {
    if (p.share <= 0) continue;
    const len = Math.max(0, p.share * c - (parts.filter((x) => x.share > 0).length > 1 ? 3 : 0));
    out += `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${p.fill}" stroke-width="14" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
    off += p.share * c;
  }
  const top = [...parts].sort((a, b) => b.share - a.share)[0];
  if (top) out += `<text x="50%" y="48%" text-anchor="middle" class="donut-n">${Math.round(top.share * 100)}%</text><text x="50%" y="63%" text-anchor="middle" class="donut-l">${esc(top.label.toLowerCase())}</text>`;
  return out + "</svg>";
}
