// Sample data for /admin/mix-notes?demo=1: two made-up reviews with submissions and notes, so the queue
// and follow-along mode can be previewed without signing in. Nothing here is real; no audio is played.
import type { ReviewData } from "./mixnotes-api.ts";
import { barBeat, hasTempo, sectionAt, type Marker, type Note, type Version } from "./mixnotes.ts";

function peaks(seed: number, n = 1200): number[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const swell = 0.55 + 0.35 * Math.sin((i / n) * Math.PI * 3.2) * Math.sin((i / n) * Math.PI);
    out.push(Math.round(Math.min(255, Math.max(8, swell * 255 * (0.65 + 0.35 * rnd())))));
  }
  return out;
}

function version(id: string, order: number, label: string, dur: number, bpm: number, markers: Marker[], iso: string): Version {
  return { id, label, order, createdAt: iso, bounceName: `${label}.wav`, durationSec: dur, bpm, beatsPerBar: 4, offsetSec: 0, markers, peaks: peaks(order * 7 + Math.round(bpm)) };
}

export function demoQueue(now = Date.now()): ReviewData[] {
  const iso = (minAgo: number) => new Date(now - minAgo * 60e3).toISOString();
  const tMarkers: Marker[] = [{ name: "Intro", t: 0 }, { name: "Head A", t: 12 }, { name: "Head B", t: 48 }, { name: "Piano solo", t: 84 }, { name: "Bass solo", t: 150 }, { name: "Head out", t: 198 }, { name: "END", t: 236 }];
  // Recorded without a click: bpm 0, so the queue shows time and section only.
  const v1 = version("v1", 1, "v1 — rough", 236.4, 0, tMarkers, iso(4000));
  const v2 = version("v2", 2, "v2 — final", 236.4, 0, tMarkers, iso(900));
  const mk = (id: string, v: Version, t: number, author: string, sub: string, o: Partial<Note> = {}): Note => {
    const bb = hasTempo(v) ? barBeat(t, v) : { bar: 1, beat: 1 }; // no click: placeholders, never shown
    return {
      id, versionId: v.id, t, from: Math.max(0, t - 5), section: sectionAt(t, v.markers), bar: bb.bar, beat: bb.beat, kind: "text", text: "",
      voiceId: "", voiceSec: 0, author, createdAt: iso(60), status: "open", submissionId: sub, reply: "", transcript: "", updatedAt: "", ...o,
    };
  };
  const translucent: ReviewData = {
    review: { key: "DEMOtranslucent000000000", title: "Translucent", artist: "Fault Line Trio", clients: ["Jay", "Maya"], status: "open", latestVersion: "v2", createdAt: iso(4000), updatedAt: iso(900) },
    versions: [v1, v2],
    submissions: [
      { id: "s-jay-1", author: "Jay", versionId: "v1", noteCount: 2, createdAt: iso(3000), status: "done", updatedAt: iso(2000) },
      { id: "s-jay-2", author: "Jay", versionId: "v2", noteCount: 3, createdAt: iso(45), status: "new", updatedAt: "" },
      { id: "s-maya-1", author: "Maya", versionId: "v2", noteCount: 2, createdAt: iso(300), status: "listening", updatedAt: iso(200) },
    ],
    notes: [
      mk("n1", v1, 20.4, "Jay", "s-jay-1", { text: "Ride is too loud against the head.", status: "done", reply: "Pulled it down 2 dB in v2.", createdAt: iso(3000) }),
      mk("n2", v1, 101.2, "Jay", "s-jay-1", { text: "Piano a little dull here.", status: "done", createdAt: iso(3000) }),
      mk("n3", v2, 14.6, "Jay", "s-jay-2", { text: "Love the new intro balance. Maybe a touch more bass on the pickup?", createdAt: iso(45) }),
      mk("n4", v2, 61.8, "Jay", "s-jay-2", { kind: "voice", voiceId: "demo-voice-1.webm", voiceSec: 9.4, transcript: "Right here the snare fill jumps out, can we tuck it a bit?", createdAt: iso(45) }),
      mk("n5", v2, 172.3, "Jay", "s-jay-2", { text: "Bass solo: can we hear more of the low end, it gets thin after bar 115.", status: "doing", createdAt: iso(45) }),
      mk("n6", v2, 90.1, "Maya", "s-maya-1", { text: "Piano solo sits perfectly now.", status: "done", createdAt: iso(300) }),
      mk("n7", v2, 205.7, "Maya", "s-maya-1", { kind: "voice", voiceId: "demo-voice-2.webm", voiceSec: 6.1, text: "", createdAt: iso(300) }),
    ],
  };
  const bMarkers: Marker[] = [{ name: "Intro", t: 0 }, { name: "Verse", t: 9.5 }, { name: "Chorus", t: 41 }, { name: "Outro", t: 150 }, { name: "END", t: 182 }];
  const bv1 = version("v1", 1, "v1", 182.2, 92, bMarkers, iso(20000)); // one with a tempo: Bar · Beat shown
  const blue: ReviewData = {
    review: { key: "DEMObluemonday0000000000", title: "Blue Monday", artist: "Scott Larson Quartet", clients: ["Dee"], status: "closed", latestVersion: "v1", createdAt: iso(20000), updatedAt: iso(15000) },
    versions: [bv1],
    submissions: [{ id: "s-dee-1", author: "Dee", versionId: "v1", noteCount: 1, createdAt: iso(19000), status: "done", updatedAt: iso(15000) }],
    notes: [mk("b1", bv1, 44.2, "Dee", "s-dee-1", { text: "Vocal could come up in the first chorus.", status: "done", createdAt: iso(19000) })],
  };
  return [translucent, blue];
}
