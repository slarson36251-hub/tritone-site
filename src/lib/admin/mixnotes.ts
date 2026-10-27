// Mix review notes for Scott's queue (/admin/mix-notes): the pure pieces. Data shapes follow
// docs/mix-review-contract.md (reviews/{key}, versions, submissions, notes). Formatting (time,
// bar · beat, plain text, CSV), share links, grouping song -> client -> submission, follow-along
// helpers, and Firestore REST encoding / commit bodies. No DOM; tested in tests/mixnotes.test.mjs
// (and the commit bodies against the emulator in tests/rules/).
import { fromValue } from "./firestore.ts";

export const SITE = "https://tritone-productions.com";
/** NAS stream server. Build-time PUBLIC_REVIEW_STREAM_URL wins; the CSP in firebase.json must list the same origin. */
export const DEFAULT_STREAM_URL = "https://stream.tritone-productions.com";

export type ReviewStatus = "open" | "closed";
export type NoteStatus = "open" | "doing" | "done";
export type SubmissionStatus = "new" | "listening" | "done";
export type NoteFilter = "open" | "doing" | "done" | "all";

export interface Marker { name: string; t: number }
export interface Review {
  key: string; title: string; artist: string; clients: string[]; status: ReviewStatus;
  latestVersion: string; createdAt: string; updatedAt: string;
}
export interface Version {
  id: string; label: string; order: number; createdAt: string; bounceName: string; durationSec: number;
  bpm: number; beatsPerBar: number; offsetSec: number; markers: Marker[]; peaks: number[];
}
export interface Submission { id: string; author: string; versionId: string; noteCount: number; createdAt: string; status: SubmissionStatus; updatedAt: string }
export interface Note {
  id: string; versionId: string; t: number; from: number; section: string; bar: number; beat: number;
  kind: "text" | "voice"; text: string; voiceId: string; voiceSec: number; author: string; createdAt: string;
  status: NoteStatus; submissionId: string; reply: string; transcript: string; updatedAt: string;
}

// ------------------------------------------------------------------ links
/** Base62 review key: 20-64 characters (the publisher makes 24). */
export const isReviewKey = (k: string) => /^[A-Za-z0-9]{20,64}$/.test(k);

/** The client's share link: https://tritone-productions.com/review?k=<key>[&v=<versionId>]. */
export function shareLink(key: string, versionId = "", origin = SITE): string {
  const u = new URL("/review", origin);
  u.searchParams.set("k", key);
  if (versionId) u.searchParams.set("v", versionId);
  return u.toString();
}

/** The stream server base URL without a trailing slash. */
export function streamBase(env?: string): string {
  const v = (env ?? "").trim() || DEFAULT_STREAM_URL;
  return v.replace(/\/+$/, "");
}

/** Body for POST <stream>/v1/sign: the song (aac/wav) of a version, or a voice note. */
export function signBody(review: string, what: { version: string; kind: "aac" | "wav" } | { voiceId: string }) {
  return "voiceId" in what ? { review, voiceId: what.voiceId, kind: "voice" as const } : { review, version: what.version, kind: what.kind };
}

// ------------------------------------------------------------------ formatting
/** Seconds -> "m:ss.s" (tenths, truncated so a note never shows later than it is). */
export function fmtTime(sec: number): string {
  const tenths = Math.floor(Math.max(0, Number(sec) || 0) * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, "0")}.${tenths % 10}`;
}

/** Bar / beat at time t of a version (contract formula). */
export function barBeat(t: number, v: Pick<Version, "bpm" | "beatsPerBar" | "offsetSec">): { bar: number; beat: number } {
  const bpm = v.bpm > 0 ? v.bpm : 120;
  const per = v.beatsPerBar > 0 ? Math.round(v.beatsPerBar) : 4;
  const beat = Math.floor(((t + (v.offsetSec || 0)) * bpm) / 60 + 1e-9);
  const b = Math.max(0, beat);
  return { bar: Math.floor(b / per) + 1, beat: (b % per) + 1 };
}

export const barBeatLabel = (n: Pick<Note, "bar" | "beat">) => `Bar ${n.bar} · Beat ${n.beat}`;

/** A version with a project tempo. Without one (bpm 0 / missing: no click) notes carry bar 1 / beat 1
 *  placeholders, so Bar · Beat is never shown or exported; time and section only. */
export const hasTempo = (v: Pick<Version, "bpm"> | undefined | null) => !!v && Number.isFinite(v.bpm) && v.bpm > 0;
/** "Bar 29 · Beat 2" for a note, or "" when its version has no tempo. */
export function noteBarBeat(n: Pick<Note, "bar" | "beat" | "versionId">, versions: Pick<Version, "id" | "bpm">[]): string {
  return hasTempo(versions.find((v) => v.id === n.versionId)) ? barBeatLabel(n) : "";
}

/** The words of a note: typed text, or for a voice note its transcript (or the typed text, or a placeholder). */
export function noteWords(n: Pick<Note, "kind" | "text" | "transcript" | "voiceSec">): string {
  if (n.kind === "text") return n.text;
  const words = n.transcript || n.text;
  return words || `(voice note, ${fmtTime(n.voiceSec).replace(/\.\d$/, "")})`;
}

/** Section name at time t: the last marker at or before t ("" before the first). */
export function sectionAt(t: number, markers: Marker[]): string {
  let name = "";
  for (const m of [...markers].sort((a, b) => a.t - b.t)) { if (m.t <= t + 1e-6) name = m.name; else break; }
  return /^end$/i.test(name) ? "" : name;
}

export const byTimeline = (a: Note, b: Note) => a.t - b.t || a.from - b.from || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.id < b.id ? -1 : 1);
const newestFirst = (a: { createdAt: string }, b: { createdAt: string }) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

export function matchesFilter(n: Pick<Note, "status">, f: NoteFilter): boolean {
  return f === "all" || n.status === f;
}

export function versionLabel(id: string, versions: Version[]): string {
  return versions.find((v) => v.id === id)?.label || id;
}
export const versionOrder = (id: string, versions: Version[]) => versions.find((v) => v.id === id)?.order ?? (Number(id.replace(/\D/g, "")) || 0);

/** Plain-text notes Scott can paste anywhere: grouped by version (newest last), timeline order. */
export function notesPlainText(review: Pick<Review, "title" | "artist" | "key">, versions: Version[], notes: Note[]): string {
  const lines = [`${review.title}${review.artist ? " — " + review.artist : ""}`, shareLink(review.key), ""];
  const ids = [...new Set(notes.map((n) => n.versionId))].sort((a, b) => versionOrder(a, versions) - versionOrder(b, versions));
  if (!notes.length) lines.push("No notes.");
  for (const id of ids) {
    lines.push(versionLabel(id, versions));
    for (const n of notes.filter((x) => x.versionId === id).sort(byTimeline)) {
      const where = [fmtTime(n.t), noteBarBeat(n, versions), n.section].filter(Boolean).join("  ");
      const voice = n.kind === "voice" ? " [voice]" : "";
      lines.push(`- ${where} — ${n.author}${voice}: ${noteWords(n).replace(/\s+/g, " ").trim()} (${n.status})`);
      if (n.reply) lines.push(`    Reply: ${n.reply.replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n*$/, "\n");
}

const csvCell = (v: string | number) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const CSV_COLUMNS = ["time", "bar", "beat", "section", "author", "kind", "text", "status"] as const;

/** CSV (time, bar, beat, section, author, kind, text, status), timeline order, CRLF line ends.
 *  bar / beat stay empty for a version without a tempo (pass the versions). */
export function notesCsv(notes: Note[], versions: Version[] = []): string {
  const rows = [...notes].sort((a, b) => versionOrder(a.versionId, versions) - versionOrder(b.versionId, versions) || byTimeline(a, b));
  const out = [CSV_COLUMNS.join(",")];
  for (const n of rows) {
    const tempo = hasTempo(versions.find((v) => v.id === n.versionId));
    out.push([fmtTime(n.t), tempo ? n.bar : "", tempo ? n.beat : "", n.section, n.author, n.kind, noteWords(n), n.status].map(csvCell).join(","));
  }
  return out.join("\r\n") + "\r\n";
}

export function fileSlug(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "notes";
}

// ------------------------------------------------------------------ grouping: song -> client -> submission
export interface SubmissionGroup { submission: Submission; notes: Note[]; open: number; total: number }
export interface ClientGroup { author: string; submissions: SubmissionGroup[]; latest: string; open: number }
export interface SongGroup { review: Review; versions: Version[]; clients: ClientGroup[]; openNotes: number; total: number; latest: string; newSubs: number }

/** Song -> client (author) -> submission, newest first; notes in timeline order and filtered.
 *  A note whose submission is missing gets a stand-in submission (id "" + author/version). */
export function groupQueue(
  data: { review: Review; versions: Version[]; submissions: Submission[]; notes: Note[] }[],
  filter: NoteFilter = "all",
): SongGroup[] {
  const songs = data.map(({ review, versions, submissions, notes }) => {
    const subs = new Map(submissions.map((s) => [s.id, s]));
    const groups = new Map<string, SubmissionGroup>();
    for (const n of notes) {
      let s = subs.get(n.submissionId);
      const gid = s ? s.id : `~${n.author}|${n.versionId}`;
      if (!s) s = { id: "", author: n.author, versionId: n.versionId, noteCount: 0, createdAt: n.createdAt, status: "new", updatedAt: "" };
      let g = groups.get(gid);
      if (!g) groups.set(gid, (g = { submission: { ...s }, notes: [], open: 0, total: 0 }));
      if (!subs.has(n.submissionId) && n.createdAt > g.submission.createdAt) g.submission.createdAt = n.createdAt;
      g.total++;
      if (n.status !== "done") g.open++;
      if (matchesFilter(n, filter)) g.notes.push(n);
    }
    for (const s of submissions) if (![...groups.values()].some((g) => g.submission.id === s.id)) groups.set(s.id, { submission: s, notes: [], open: 0, total: 0 });
    const clients = new Map<string, ClientGroup>();
    for (const g of groups.values()) {
      g.notes.sort(byTimeline);
      const who = g.submission.author || "Unknown";
      const k = who.trim().toLowerCase();
      let c = clients.get(k);
      if (!c) clients.set(k, (c = { author: who, submissions: [], latest: "", open: 0 }));
      c.submissions.push(g);
      c.open += g.open;
      if (g.submission.createdAt > c.latest) c.latest = g.submission.createdAt;
    }
    const cl = [...clients.values()].map((c) => ({ ...c, submissions: c.submissions.sort((a, b) => newestFirst(a.submission, b.submission)) }))
      .filter((c) => filter === "all" || c.submissions.some((s) => s.notes.length))
      .sort((a, b) => newestFirst({ createdAt: a.latest }, { createdAt: b.latest }));
    if (filter !== "all") for (const c of cl) c.submissions = c.submissions.filter((s) => s.notes.length);
    const latest = cl.reduce((m, c) => (c.latest > m ? c.latest : m), "") || review.updatedAt || review.createdAt;
    return {
      review, versions: [...versions].sort((a, b) => a.order - b.order), clients: cl,
      openNotes: notes.filter((n) => n.status !== "done").length, total: notes.length, latest,
      newSubs: submissions.filter((s) => s.status === "new").length,
    };
  });
  // Open reviews first, then newest activity.
  return songs.sort((a, b) => (a.review.status === b.review.status ? 0 : a.review.status === "open" ? -1 : 1) || newestFirst({ createdAt: a.latest }, { createdAt: b.latest }));
}

// ------------------------------------------------------------------ follow-along helpers
/** The stretch of song a note points at: [from, t]; a zero-length note gets the 5 s before it. */
export function clipFor(n: Pick<Note, "from" | "t">): { start: number; end: number } {
  const end = Math.max(0, n.t);
  let start = Math.min(Math.max(0, n.from), end);
  if (end - start < 0.25) start = Math.max(0, end - 5);
  return { start, end };
}

/** Index of the first note reached when playback moves from prev to cur (prev < t <= cur), or -1. */
export function crossedNote(notes: Pick<Note, "t">[], prev: number, cur: number): number {
  if (!(cur > prev) || cur - prev > 2) return -1; // seeks and stalls are not crossings
  for (let i = 0; i < notes.length; i++) if (notes[i].t > prev && notes[i].t <= cur) return i;
  return -1;
}

/** Index of the note to show at time t: the last note at or before t (else the first). */
export function noteAt(notes: Pick<Note, "t">[], t: number): number {
  let idx = notes.length ? 0 : -1;
  for (let i = 0; i < notes.length; i++) if (notes[i].t <= t + 1e-3) idx = i;
  return idx;
}

/** Peaks (0-255) -> SVG path (mirrored bars), width w, height h. */
export function waveformPath(peaks: number[], w: number, h: number, bins = Math.min(peaks.length, Math.max(1, Math.floor(w / 3)))): string {
  if (!peaks.length || w <= 0 || h <= 0) return "";
  const mid = h / 2;
  const bw = w / bins;
  let d = "";
  for (let i = 0; i < bins; i++) {
    const a = Math.floor((i * peaks.length) / bins);
    const b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / bins));
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, peaks[j] || 0);
    const amp = Math.max(1, (Math.min(255, m) / 255) * (mid - 1));
    d += `M${(i * bw + bw * 0.15).toFixed(1)} ${(mid - amp).toFixed(1)}h${(bw * 0.7).toFixed(1)}v${(amp * 2).toFixed(1)}h-${(bw * 0.7).toFixed(1)}z`;
  }
  return d;
}

// ------------------------------------------------------------------ Firestore REST: read
const s = (f: Record<string, any>, k: string) => { const x = fromValue(f[k]); return typeof x === "string" ? x : ""; };
const n = (f: Record<string, any>, k: string, d = 0) => { const x = fromValue(f[k]); return typeof x === "number" && Number.isFinite(x) ? x : d; };
const idOf = (doc: { name?: string }) => (doc.name ?? "").split("/").pop() ?? "";

export function docToReview(doc: { name?: string; fields?: Record<string, any> }): Review | null {
  const f = doc?.fields;
  if (!f) return null;
  const clients = fromValue(f.clients);
  return {
    key: idOf(doc), title: s(f, "title") || "Untitled", artist: s(f, "artist"),
    clients: Array.isArray(clients) ? clients.filter((c) => typeof c === "string") : [],
    status: s(f, "status") === "closed" ? "closed" : "open", latestVersion: s(f, "latestVersion"),
    createdAt: s(f, "createdAt"), updatedAt: s(f, "updatedAt"),
  };
}

export function docToVersion(doc: { name?: string; fields?: Record<string, any> }): Version | null {
  const f = doc?.fields;
  if (!f) return null;
  const markers = fromValue(f.markers);
  const peaks = fromValue(f.peaks);
  return {
    id: idOf(doc), label: s(f, "label") || idOf(doc), order: n(f, "order"), createdAt: s(f, "createdAt"), bounceName: s(f, "bounceName"),
    durationSec: n(f, "durationSec"), bpm: n(f, "bpm", 0), beatsPerBar: n(f, "beatsPerBar", 4), offsetSec: n(f, "offsetSec"),
    markers: Array.isArray(markers) ? markers.filter((m) => m && typeof m.name === "string" && typeof m.t === "number").sort((a, b) => a.t - b.t) : [],
    peaks: Array.isArray(peaks) ? peaks.map((p) => (typeof p === "number" ? p : 0)) : [],
  };
}

export function docToSubmission(doc: { name?: string; fields?: Record<string, any> }): Submission | null {
  const f = doc?.fields;
  if (!f) return null;
  const st = s(f, "status");
  return {
    id: idOf(doc), author: s(f, "author"), versionId: s(f, "versionId"), noteCount: n(f, "noteCount"), createdAt: s(f, "createdAt"),
    status: st === "listening" || st === "done" ? st : "new", updatedAt: s(f, "updatedAt"),
  };
}

export function docToNote(doc: { name?: string; fields?: Record<string, any> }): Note | null {
  const f = doc?.fields;
  if (!f) return null;
  const st = s(f, "status");
  return {
    id: idOf(doc), versionId: s(f, "versionId"), t: n(f, "t"), from: n(f, "from"), section: s(f, "section"), bar: n(f, "bar", 1), beat: n(f, "beat", 1),
    kind: s(f, "kind") === "voice" ? "voice" : "text", text: s(f, "text"), voiceId: s(f, "voiceId"), voiceSec: n(f, "voiceSec"),
    author: s(f, "author") || "Unknown", createdAt: s(f, "createdAt"), status: st === "doing" || st === "done" ? st : "open",
    submissionId: s(f, "submissionId"), reply: s(f, "reply"), transcript: s(f, "transcript"), updatedAt: s(f, "updatedAt"),
  };
}

// ------------------------------------------------------------------ Firestore REST: write
/** Force a whole number to be stored as a double (e.g. t = 42 seconds stays a double). */
export class Double {
  value: number;
  constructor(value: number) { this.value = value; }
}

/** Plain JS -> typed Firestore REST value. Whole numbers become integers unless wrapped in Double. */
export function toValue(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Double) return { doubleValue: v.value };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFields(v as Record<string, unknown>) } };
  throw new Error(`can't encode ${typeof v}`);
}
export function toFields(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toValue(v)]));
}

/** Document name for a :commit write, e.g. projects/tritone-site/databases/(default)/documents/reviews/K/notes/N. */
export const docName = (root: string, ...path: string[]) => `${root}/${path.map((p) => encodeURIComponent(p)).join("/")}`;
export const DB_ROOT = "projects/tritone-site/databases/(default)/documents";

/** A field-masked update stamped with updatedAt = request.time (the rules require it). Fails if the doc is missing. */
export function stampedUpdate(name: string, patch: Record<string, unknown>) {
  return {
    update: { name, fields: toFields(patch) },
    updateMask: { fieldPaths: Object.keys(patch) },
    updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
    currentDocument: { exists: true },
  };
}

export const noteStatusWrite = (root: string, key: string, noteId: string, status: NoteStatus) => stampedUpdate(docName(root, "reviews", key, "notes", noteId), { status });
export const noteReplyWrite = (root: string, key: string, noteId: string, reply: string) => stampedUpdate(docName(root, "reviews", key, "notes", noteId), { reply: reply.slice(0, 4000) });
export const submissionStatusWrite = (root: string, key: string, id: string, status: SubmissionStatus) => stampedUpdate(docName(root, "reviews", key, "submissions", id), { status });
export const reviewStatusWrite = (root: string, key: string, status: ReviewStatus) => stampedUpdate(docName(root, "reviews", key), { status });

/** A create-only write stamped with createdAt = request.time (what the client page sends). */
export function stampedCreate(name: string, fields: Record<string, unknown>) {
  return {
    update: { name, fields: toFields(fields) },
    updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }],
    currentDocument: { exists: false },
  };
}
