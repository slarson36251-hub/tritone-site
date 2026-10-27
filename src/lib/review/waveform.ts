// Canvas waveform: bars from the version's 1200 peaks for the visible window, the played part
// white and the rest grey, Logic marker lines, the looped section and the clip ranges of drafts.
import { frac, peakBetween } from "./music.ts";

export const WAVE_COLORS = {
  played: "#FFFFFF",
  unplayed: "#77767A",
  marker: "#6A6A70",
  loopFill: "rgba(255,255,255,0.10)",
  loopEdge: "#A8A6A1",
  draftFill: "rgba(168,166,161,0.22)",
  draftActive: "rgba(255,255,255,0.18)",
};

export interface WaveScene {
  peaks: number[];
  duration: number;
  view: [number, number];
  t: number;
  markers: number[];
  loop: [number, number] | null;
  ranges: { from: number; t: number; active: boolean }[];
}

/** Size the canvas backing store to its CSS box at the device pixel ratio. Returns CSS width/height. */
export function fitCanvas(c: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

export function drawWave(c: HTMLCanvasElement, s: WaveScene) {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const { w, h, dpr } = fitCanvas(c);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const x = (t: number) => frac(t, s.view) * w;

  for (const r of s.ranges) {
    const a = Math.max(0, x(r.from));
    const b = Math.min(w, x(r.t));
    if (b <= 0 || a >= w) continue;
    ctx.fillStyle = r.active ? WAVE_COLORS.draftActive : WAVE_COLORS.draftFill;
    ctx.fillRect(a, 0, Math.max(2, b - a), h);
  }
  if (s.loop) {
    const a = x(s.loop[0]);
    const b = x(s.loop[1]);
    if (b > 0 && a < w) {
      ctx.fillStyle = WAVE_COLORS.loopFill;
      ctx.fillRect(a, 0, b - a, h);
      ctx.fillStyle = WAVE_COLORS.loopEdge;
      ctx.fillRect(Math.round(a), 0, 1, h);
      ctx.fillRect(Math.round(b) - 1, 0, 1, h);
    }
  }
  ctx.fillStyle = WAVE_COLORS.marker;
  for (const m of s.markers) {
    const mx = x(m);
    if (mx > 0.5 && mx < w - 0.5) ctx.fillRect(Math.round(mx), 0, 1, h);
  }

  const step = w < 500 ? 3 : 4; // bar + gap, CSS px
  const barW = step - 1;
  const n = Math.max(1, Math.floor(w / step));
  const span = s.view[1] - s.view[0];
  const mid = h / 2;
  for (let i = 0; i < n; i++) {
    const a = s.view[0] + (i / n) * span;
    const b = s.view[0] + ((i + 1) / n) * span;
    const p = peakBetween(s.peaks, s.duration, a, b);
    const bh = Math.max(2, p * (h - 6));
    ctx.fillStyle = (a + b) / 2 <= s.t ? WAVE_COLORS.played : WAVE_COLORS.unplayed;
    ctx.fillRect(i * step, mid - bh / 2, barW, bh);
  }
}
