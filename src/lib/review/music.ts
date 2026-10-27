// Timeline maths for the review player: bar/beat from the project tempo, sections from Logic
// markers, time formatting, views (whole song / zoomed section) and the overlap lanes the draft
// ranges are stacked into. Pure and unit-tested (tests/review.test.mjs).
import type { Marker } from "./schema.ts";

export interface Tempo {
  bpm: number;
  beatsPerBar: number;
  offsetSec: number;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Contract: beat = floor((t + offsetSec) * bpm / 60); bar = floor(beat / beatsPerBar) + 1;
 * beatInBar = beat % beatsPerBar + 1. Bars before session zero clamp to bar 1, beat 1.
 * A tiny epsilon keeps a marker placed exactly on a downbeat from reading as the beat before.
 */
export function barBeat(t: number, tempo: Tempo): { bar: number; beat: number } {
  const bpm = tempo.bpm > 0 ? tempo.bpm : 120;
  const per = clamp(Math.round(tempo.beatsPerBar) || 4, 1, 16);
  const beats = Math.floor(((t || 0) + (tempo.offsetSec || 0)) * bpm / 60 + 1e-6);
  if (beats < 0) return { bar: 1, beat: 1 };
  return { bar: Math.floor(beats / per) + 1, beat: (beats % per) + 1 };
}

export interface Section {
  name: string;
  start: number;
  end: number;
}

const isEnd = (m: Marker) => /^end$/i.test(m.name.trim());

/**
 * Sections from markers: each named marker runs to the next marker (an END marker only closes
 * the last section) or the end of the song. Time before the first marker is an unnamed section.
 */
export function sectionsOf(markers: Marker[], duration: number): Section[] {
  const ms = (markers ?? [])
    .filter((m) => m && Number.isFinite(m.t) && m.t >= 0 && m.t < duration)
    .slice()
    .sort((a, b) => a.t - b.t);
  const out: Section[] = [];
  if (!ms.length || ms[0].t > 0.05) out.push({ name: "", start: 0, end: ms[0]?.t ?? duration });
  ms.forEach((m, i) => {
    const end = i + 1 < ms.length ? ms[i + 1].t : duration;
    if (isEnd(m)) {
      if (end - m.t > 0.05) out.push({ name: "", start: m.t, end });
      return;
    }
    out.push({ name: String(m.name ?? "").trim().slice(0, 80), start: m.t, end });
  });
  return out.filter((s) => s.end > s.start);
}

/** Index of the section containing t (last section whose start <= t). */
export function sectionIndexAt(sections: Section[], t: number): number {
  let k = 0;
  for (let i = 0; i < sections.length; i++) if (t >= sections[i].start - 1e-6) k = i;
  return k;
}

/** Marker name at t, "" when none (contract: section field of a note). */
export function sectionNameAt(sections: Section[], t: number): string {
  return sections.length ? sections[sectionIndexAt(sections, t)].name : "";
}

/** The marker lane: named sections only. */
export function laneSections(sections: Section[]): Section[] {
  return sections.filter((s) => s.name);
}

/** Where "previous marker" goes: start of this section if we are more than 1.5 s in, else the one before. */
export function prevMarkerTime(sections: Section[], t: number): number {
  if (!sections.length) return 0;
  const i = sectionIndexAt(sections, t);
  if (t - sections[i].start > 1.5 || i === 0) return sections[i].start;
  return sections[i - 1].start;
}

export function nextMarkerTime(sections: Section[], t: number): number | null {
  const i = sectionIndexAt(sections, t);
  return i + 1 < sections.length ? sections[i + 1].start : null;
}

/** m:ss.s (the big readout and note times). */
export function fmtTime(t: number): string {
  const v = Math.max(0, Number.isFinite(t) ? t : 0);
  let m = Math.floor(v / 60);
  let s = Math.round((v - m * 60) * 10) / 10;
  if (s >= 60) { m += 1; s = 0; }
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

/** m:ss (axis ticks, durations). */
export function fmtShort(t: number): string {
  const v = Math.max(0, Number.isFinite(t) ? t : 0);
  let m = Math.floor(v / 60);
  let s = Math.round(v - m * 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

/**
 * The visible window of the waveform. Whole song, or zoomed to the looped / current section.
 * A section that is the whole song (no markers) zooms to a 20 s window around the playhead.
 */
export function viewRange(sections: Section[], duration: number, t: number, zoom: boolean, loop: Section | null): [number, number] {
  if (!zoom || duration <= 0) return [0, Math.max(duration, 0.001)];
  const s = loop ?? sections[sectionIndexAt(sections, t)];
  if (s && s.end - s.start < duration * 0.95) return [s.start, s.end];
  const w = Math.min(20, duration);
  const a = clamp(t - w / 2, 0, duration - w);
  return [a, a + w];
}

/** Fraction across a view, unclamped. */
export const frac = (t: number, v: [number, number]) => (t - v[0]) / (v[1] - v[0]);

/** Pointer x (relative to the waveform) -> time inside the view, kept just short of the end. */
export function xToTime(x: number, width: number, v: [number, number], duration: number): number {
  const f = clamp(width > 0 ? x / width : 0, 0, 1);
  return clamp(v[0] + f * (v[1] - v[0]), 0, Math.max(0, duration - 0.05));
}

/** Where a new note's clip starts: the loop start when looping, otherwise 5 s back. */
export function clipStart(t: number, loopStart: number | null): number {
  if (loopStart !== null && loopStart <= t) return Math.max(0, loopStart);
  return Math.max(0, t - 5);
}

/** Move a whole range by dt, keeping its length and staying inside [0, duration]. */
export function moveRange(from: number, t: number, dt: number, duration: number): { from: number; t: number } {
  const len = Math.max(0, t - from);
  const nf = clamp(from + dt, 0, Math.max(0, duration - len));
  return { from: round3(nf), t: round3(nf + len) };
}

/** Drag a range's start handle: 0 <= from <= t. */
export function moveStart(from: number, t: number, nextFrom: number): { from: number; t: number } {
  return { from: round3(clamp(nextFrom, 0, t)), t };
}

/** Drag a range's end (the point it refers to): from <= t <= duration. */
export function moveEnd(from: number, t: number, nextT: number, duration: number): { from: number; t: number } {
  return { from, t: round3(clamp(nextT, from, duration)) };
}

export const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Stack overlapping ranges into rows (greedy, by start). Returns row index per item id and the
 * number of rows. Ranges closer than `gap` seconds count as overlapping so handles never touch.
 */
export function assignLanes(items: { id: string; from: number; t: number }[], gap = 0): { rows: Record<string, number>; count: number } {
  const sorted = items.slice().sort((a, b) => a.from - b.from || a.t - b.t);
  const ends: number[] = [];
  const rows: Record<string, number> = {};
  for (const it of sorted) {
    let r = ends.findIndex((e) => it.from >= e + gap);
    if (r === -1) { r = ends.length; ends.push(0); }
    ends[r] = Math.max(it.t, it.from);
    rows[it.id] = r;
  }
  return { rows, count: ends.length };
}

/** Peak (0-1) of the bins covering [a, b) of a song of `duration` seconds. */
export function peakBetween(peaks: number[], duration: number, a: number, b: number): number {
  const n = peaks.length;
  if (!n || duration <= 0) return 0;
  let i0 = Math.floor((a / duration) * n);
  let i1 = Math.ceil((b / duration) * n);
  i0 = clamp(i0, 0, n - 1);
  i1 = clamp(Math.max(i1, i0 + 1), 1, n);
  let m = 0;
  for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
  return m / 255;
}
