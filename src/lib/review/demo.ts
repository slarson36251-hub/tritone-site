// /review?demo=1: a made-up review with a test tune synthesised in the browser, so the page can be
// tried without the NAS or Firestore. Nothing is fetched and nothing is sent. No audio file is
// shipped: the WAV below is generated on the fly.
import type { Note, Review, Version } from "./schema.ts";

export const DEMO_KEY = "demo";
const DUR = 96;
const BPM = 120;

export const demoReview: Review = {
  key: DEMO_KEY,
  title: "Demo Tune",
  artist: "Tritone Productions",
  clients: ["You"],
  status: "open",
  latestVersion: "v2",
};

const MARKERS = [
  { name: "Intro", t: 0 },
  { name: "Head A", t: 16 },
  { name: "Head B", t: 32 },
  { name: "Piano Solo", t: 48 },
  { name: "Drums Trading", t: 64 },
  { name: "Head Out", t: 76 },
  { name: "Coda", t: 88 },
  { name: "END", t: 95 },
];
// Chord root (Hz) and level per section.
const SECTION_SOUND = [
  [146.83, 0.35], [196.0, 0.6], [174.61, 0.66], [220.0, 0.55], [130.81, 0.85], [196.0, 0.7], [146.83, 0.3], [146.83, 0.05],
];

const RATE = 22050;
let cache: { samples: Float32Array; peaks: number[] } | null = null;

function synth() {
  if (cache) return cache;
  const n = DUR * RATE;
  const out = new Float32Array(n);
  const beat = 60 / BPM;
  let si = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    while (si + 1 < MARKERS.length && t >= MARKERS[si + 1].t) si++;
    const [root, lvl] = SECTION_SOUND[si];
    const b = t / beat;
    const inBeat = b - Math.floor(b);
    const beatNo = Math.floor(b) % 4;
    // Pad: root, major third, fifth, slow swell per bar.
    const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * t) / (beat * 4));
    let v = (Math.sin(2 * Math.PI * root * t) + 0.6 * Math.sin(2 * Math.PI * root * 1.26 * t) + 0.5 * Math.sin(2 * Math.PI * root * 1.5 * t)) * 0.18 * swell;
    // Bass on 1 and 3.
    if (beatNo % 2 === 0) v += Math.sin(2 * Math.PI * (root / 2) * t) * Math.exp(-inBeat * 4) * 0.35;
    // Click on every beat, accent on 1.
    v += Math.sin(2 * Math.PI * (beatNo === 0 ? 1760 : 1320) * t) * Math.exp(-inBeat * beat * 60) * (beatNo === 0 ? 0.5 : 0.3);
    out[i] = Math.max(-1, Math.min(1, v * lvl));
  }
  const bins = 1200;
  const per = n / bins;
  const raw: number[] = [];
  let max = 0;
  for (let k = 0; k < bins; k++) {
    let m = 0;
    for (let i = Math.floor(k * per); i < Math.floor((k + 1) * per); i++) m = Math.max(m, Math.abs(out[i]));
    raw.push(m);
    max = Math.max(max, m);
  }
  cache = { samples: out, peaks: raw.map((m) => Math.round((m / (max || 1)) * 255)) };
  return cache;
}

function version(id: string, label: string, order: number): Version {
  return {
    id, label, order,
    bounceName: `Demo Tune ${id}.wav`,
    durationSec: DUR,
    sampleRate: RATE,
    bpm: BPM,
    beatsPerBar: 4,
    offsetSec: 0,
    markers: MARKERS,
    peaks: synth().peaks,
  };
}

export function demoVersions(): Version[] {
  return [version("v2", "v2 — final", 2), version("v1", "v1 — rough", 1)];
}

export function demoNotes(): Note[] {
  const base = { versionId: "v2", kind: "text" as const, voiceId: "", voiceSec: 0, createdAt: "2026-10-26T18:00:00Z", submissionId: "demoSubmission01", transcript: "" };
  return [
    { ...base, id: "demoNote000000000001", t: 21.4, from: 16.4, section: "Head A", bar: 11, beat: 3, text: "Piano a touch loud against the bass in the melody here.", author: "Jay", status: "done", reply: "Pulled the piano down 1.5 dB in v2." },
    { ...base, id: "demoNote000000000002", t: 70.2, from: 65.2, section: "Drums Trading", bar: 36, beat: 1, text: "Love the room sound on the drum breaks. Keep that.", author: "Sam", status: "open", reply: "" },
  ];
}

/** 16-bit mono WAV of the demo tune. */
export function demoWav(): Blob {
  const { samples } = synth();
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  dv.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, RATE, true);
  dv.setUint32(28, RATE * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, Math.round(samples[i] * 32767), true);
  return new Blob([buf], { type: "audio/wav" });
}
