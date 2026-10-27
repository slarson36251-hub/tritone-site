// Firestore REST for the client review page (no SDK): get the review, list its versions and notes,
// and send one round of feedback as a single atomic :commit (submission + its notes).
// Builders and parsers are pure (tests/review.test.mjs); the fetch wrappers never throw raw errors,
// they throw ReviewError with a kind the page can explain.
import { DOC_PREFIX, FETCH_INIT, FIRESTORE_DOCS, LIMITS, NOTE_KEYS, SUBMISSION_KEYS } from "./schema.ts";
import type { Draft, Note, NoteKind, NoteStatus, Review, Version } from "./schema.ts";
import { barBeat, clamp, round3, sectionNameAt, sectionsOf } from "./music.ts";

type FsValue = Record<string, any>;
type FsDoc = { name?: string; fields?: Record<string, FsValue> };

/* ------------------------------------------------------------- parsing ------------------------------------------------------------- */

export function fromValue(v: FsValue | undefined): any {
  if (!v || typeof v !== "object") return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromValue(x as FsValue)]));
  return undefined;
}

const idOf = (doc: FsDoc) => (doc.name ?? "").split("/").pop() ?? "";
const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, dflt = 0) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);

export function docToReview(doc: FsDoc | undefined, key: string): Review | null {
  const f = doc?.fields;
  if (!f) return null;
  const g = (k: string) => fromValue(f[k]);
  const clients = g("clients");
  return {
    key,
    title: str(g("title"), 200) || "Untitled mix",
    artist: str(g("artist"), 200),
    clients: Array.isArray(clients) ? clients.filter((c) => typeof c === "string").slice(0, 20) : [],
    status: g("status") === "open" ? "open" : "closed",
    latestVersion: str(g("latestVersion"), LIMITS.versionId),
  };
}

export function docToVersion(doc: FsDoc | undefined): Version | null {
  const f = doc?.fields;
  if (!f) return null;
  const g = (k: string) => fromValue(f[k]);
  const durationSec = num(g("durationSec"));
  if (!(durationSec > 0)) return null;
  const markers = (Array.isArray(g("markers")) ? g("markers") : [])
    .filter((m: any) => m && typeof m === "object" && Number.isFinite(Number(m.t)))
    .map((m: any) => ({ name: str(m.name, 80), t: Number(m.t) }))
    .sort((a: { t: number }, b: { t: number }) => a.t - b.t);
  const peaks = (Array.isArray(g("peaks")) ? g("peaks") : []).map((p: unknown) => clamp(Number(p) || 0, 0, 255));
  return {
    id: idOf(doc!),
    label: str(g("label"), 80) || idOf(doc!),
    order: num(g("order")),
    bounceName: str(g("bounceName"), 300),
    durationSec,
    sampleRate: num(g("sampleRate"), 48000),
    bpm: Math.max(0, num(g("bpm"), 0)), // 0 = no tempo: no Bar · Beat shown
    beatsPerBar: clamp(Math.round(num(g("beatsPerBar"), 4)) || 4, 1, 16),
    offsetSec: num(g("offsetSec")),
    markers,
    peaks,
  };
}

export function docToNote(doc: FsDoc | undefined): Note | null {
  const f = doc?.fields;
  if (!f) return null;
  const g = (k: string) => fromValue(f[k]);
  const t = num(g("t"), NaN);
  if (!Number.isFinite(t)) return null;
  const kind: NoteKind = g("kind") === "voice" ? "voice" : "text";
  const status: NoteStatus = ["open", "doing", "done"].includes(g("status")) ? g("status") : "open";
  return {
    id: idOf(doc!),
    versionId: str(g("versionId"), LIMITS.versionId),
    t,
    from: clamp(num(g("from"), t), 0, t),
    section: str(g("section"), LIMITS.section),
    bar: Math.max(1, Math.round(num(g("bar"), 1))),
    beat: clamp(Math.round(num(g("beat"), 1)), 1, 16),
    kind,
    text: str(g("text"), LIMITS.text),
    voiceId: str(g("voiceId"), LIMITS.voiceId),
    voiceSec: clamp(num(g("voiceSec")), 0, LIMITS.voiceSec),
    author: str(g("author"), LIMITS.author),
    createdAt: str(g("createdAt"), 40),
    status,
    submissionId: str(g("submissionId"), LIMITS.submissionId),
    reply: str(g("reply"), 4000),
    transcript: str(g("transcript"), 8000),
  };
}

/** Versions newest first (by order, then id). */
export function sortVersions(vs: Version[]): Version[] {
  return vs.slice().sort((a, b) => b.order - a.order || b.id.localeCompare(a.id));
}

/** Which version to show: ?v= when it exists, else the review's latestVersion, else the newest. */
export function pickVersion(vs: Version[], wanted: string | null, latest: string): Version | null {
  return vs.find((v) => v.id === wanted) ?? vs.find((v) => v.id === latest) ?? sortVersions(vs)[0] ?? null;
}

/* ------------------------------------------------------------- URLs ------------------------------------------------------------- */

const enc = encodeURIComponent;
export const noteUrl = (key: string, noteId: string, apiKey: string) => `${FIRESTORE_DOCS}/reviews/${enc(key)}/notes/${enc(noteId)}?key=${enc(apiKey)}`;
export const reviewUrl = (key: string, apiKey: string) => `${FIRESTORE_DOCS}/reviews/${enc(key)}?key=${enc(apiKey)}`;
export const listUrl = (key: string, sub: "versions" | "notes", apiKey: string, pageToken = "") =>
  `${FIRESTORE_DOCS}/reviews/${enc(key)}/${sub}?key=${enc(apiKey)}&pageSize=300${pageToken ? `&pageToken=${enc(pageToken)}` : ""}`;
export const commitUrl = (apiKey: string) => `${FIRESTORE_DOCS}:commit?key=${enc(apiKey)}`;

/* ------------------------------------------------------------- writes ------------------------------------------------------------- */

const S = (v: string) => ({ stringValue: v });
const I = (v: number) => ({ integerValue: String(Math.round(v)) });
const D = (v: number) => ({ doubleValue: v });

export interface NoteInput {
  versionId: string;
  t: number;
  from: number;
  section: string;
  bar: number;
  beat: number;
  kind: NoteKind;
  text: string;
  voiceId: string;
  voiceSec: number;
  author: string;
  submissionId: string;
}

/** A draft plus the version it sits on -> the exact note the rules accept (createdAt is added by the commit). */
export function noteFromDraft(d: Draft, v: Version, author: string, submissionId: string): NoteInput {
  const t = round3(clamp(d.t, 0, Math.min(LIMITS.maxT, v.durationSec)));
  const from = round3(clamp(d.from, 0, t));
  const { bar, beat } = barBeat(t, v);
  const voice = d.kind === "voice" && !!d.voiceId;
  return {
    versionId: v.id.slice(0, LIMITS.versionId),
    t,
    from,
    section: sectionNameAt(sectionsOf(v.markers, v.durationSec), t).slice(0, LIMITS.section),
    bar: Math.max(1, bar),
    beat: clamp(beat, 1, LIMITS.maxBeat),
    kind: voice ? "voice" : "text",
    text: d.text.trim().slice(0, LIMITS.text),
    voiceId: voice ? d.voiceId.slice(0, LIMITS.voiceId) : "",
    voiceSec: voice ? round3(clamp(d.voiceSec, 0, LIMITS.voiceSec)) : 0,
    author: cleanName(author),
    submissionId: submissionId.slice(0, LIMITS.submissionId),
  };
}

/** A note is sendable: text notes need words, voice notes need an uploaded recording. */
export function draftReady(d: Draft): boolean {
  return d.kind === "voice" ? d.hasVoice || !!d.voiceId : d.text.trim().length > 0;
}

export function cleanName(name: string): string {
  return String(name ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS.author);
}

export function noteFields(n: NoteInput) {
  return {
    versionId: S(n.versionId),
    t: D(n.t),
    from: D(n.from),
    section: S(n.section),
    bar: I(n.bar),
    beat: I(n.beat),
    kind: S(n.kind),
    text: S(n.text),
    voiceId: S(n.voiceId),
    voiceSec: D(n.voiceSec),
    author: S(n.author),
    status: S("open"),
    submissionId: S(n.submissionId),
  };
}

export function submissionFields(author: string, versionId: string, noteCount: number) {
  return {
    author: S(cleanName(author)),
    versionId: S(versionId.slice(0, LIMITS.versionId)),
    noteCount: I(noteCount),
    status: S("new"),
  };
}

const createWrite = (path: string, fields: Record<string, FsValue>) => ({
  update: { name: `${DOC_PREFIX}/${path}`, fields },
  currentDocument: { exists: false },
  updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }],
});

/**
 * One atomic :commit: the submission first, then each note. Every write is a create
 * (currentDocument.exists=false) with createdAt = REQUEST_TIME, so the rules can require
 * createdAt == request.time. Field sets match NOTE_KEYS / SUBMISSION_KEYS exactly.
 */
export function commitBody(reviewKey: string, submissionId: string, author: string, versionId: string, notes: { id: string; note: NoteInput }[]) {
  const base = `reviews/${reviewKey}`;
  return {
    writes: [
      createWrite(`${base}/submissions/${submissionId}`, submissionFields(author, versionId, notes.length)),
      ...notes.map(({ id, note }) => createWrite(`${base}/notes/${id}`, noteFields(note))),
    ],
  };
}

/** The key set a write produces once the commit adds createdAt (for tests and sanity checks). */
export const writtenKeys = (fields: Record<string, unknown>) => [...Object.keys(fields), "createdAt"].sort();
export const EXPECTED_NOTE_KEYS = [...NOTE_KEYS].sort();
export const EXPECTED_SUBMISSION_KEYS = [...SUBMISSION_KEYS].sort();

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function randomId(len = 20): string {
  const bytes = new Uint8Array(len);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => ALNUM[b % 62]).join("");
}

/* ------------------------------------------------------------- fetch ------------------------------------------------------------- */

export type ErrorKind = "offline" | "inactive" | "config" | "server" | "closed" | "exists";

export class ReviewError extends Error {
  kind: ErrorKind;
  status: number;
  constructor(kind: ErrorKind, message: string, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** HTTP status + Firestore error body -> what to tell the client. */
export function classifyFirestoreError(status: number, body: any): ErrorKind {
  const e = body?.error ?? body?.[0]?.error;
  const s = String(e?.status ?? "");
  // The web API key is referrer-restricted: a blocked referrer is a setup problem, not a dead link.
  if (/API[ _]KEY|referer|referrer/i.test(`${e?.message ?? ""} ${JSON.stringify(e?.details ?? "")}`)) return "config";
  if (status === 409 || s === "ALREADY_EXISTS") return "exists";
  if (status === 403 || status === 404 || s === "PERMISSION_DENIED" || s === "NOT_FOUND") return "inactive";
  return "server";
}

async function call(url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, ...FETCH_INIT });
  } catch {
    throw new ReviewError("offline", "network");
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ReviewError(classifyFirestoreError(res.status, body), `firestore ${res.status}`, res.status);
  return body;
}

export async function getReview(key: string, apiKey: string): Promise<Review> {
  const r = docToReview(await call(reviewUrl(key, apiKey)), key);
  if (!r || r.status !== "open") throw new ReviewError("inactive", "review not open");
  return r;
}

async function listAll(key: string, sub: "versions" | "notes", apiKey: string): Promise<FsDoc[]> {
  const out: FsDoc[] = [];
  let token = "";
  for (let page = 0; page < 20; page++) {
    const body = await call(listUrl(key, sub, apiKey, token));
    out.push(...(body?.documents ?? []));
    token = body?.nextPageToken ?? "";
    if (!token) break;
  }
  return out;
}

export async function listVersions(key: string, apiKey: string): Promise<Version[]> {
  return sortVersions((await listAll(key, "versions", apiKey)).map(docToVersion).filter((v): v is Version => !!v));
}

export async function listNotes(key: string, apiKey: string): Promise<Note[]> {
  return (await listAll(key, "notes", apiKey)).map(docToNote).filter((n): n is Note => !!n).sort((a, b) => a.t - b.t);
}

/** Did an earlier send land? (Notes are readable while the review is open.) */
export async function noteExists(key: string, noteId: string, apiKey: string): Promise<boolean> {
  try {
    return !!docToNote(await call(noteUrl(key, noteId, apiKey)));
  } catch (e) {
    if (e instanceof ReviewError && e.status === 404) return false;
    throw e;
  }
}

export async function commitSubmission(apiKey: string, body: ReturnType<typeof commitBody>): Promise<void> {
  await call(commitUrl(apiKey), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
