// Draft notes live only on the client's device until "Send feedback": the note list in
// localStorage (one key per review), voice recordings in IndexedDB. If either store is unavailable
// (private browsing, blocked storage) everything still works for as long as the page is open.
import type { Draft } from "./schema.ts";
import { LIMITS } from "./schema.ts";
import { clamp, round3 } from "./music.ts";

export const NAME_KEY = "tritone:review-name";
export const draftsKey = (reviewKey: string) => `tritone:review-drafts:${reviewKey}`;

/** Parse stored drafts, dropping anything malformed. Pure. */
export function parseDrafts(raw: string | null): Draft[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Draft[] = [];
  for (const d of arr) {
    if (!d || typeof d !== "object") continue;
    const x = d as Record<string, unknown>;
    const t = Number(x.t);
    if (typeof x.id !== "string" || !/^[A-Za-z0-9]{8,40}$/.test(x.id) || !Number.isFinite(t)) continue;
    const kind = x.kind === "voice" ? "voice" : "text";
    out.push({
      id: x.id,
      versionId: String(x.versionId ?? "").slice(0, LIMITS.versionId),
      t: round3(clamp(t, 0, LIMITS.maxT)),
      from: round3(clamp(Number(x.from) || 0, 0, t)),
      kind,
      text: String(x.text ?? "").slice(0, LIMITS.text),
      voiceSec: clamp(Number(x.voiceSec) || 0, 0, LIMITS.voiceSec),
      hasVoice: x.hasVoice === true,
      voiceType: String(x.voiceType ?? "").slice(0, 60),
      voiceId: typeof x.voiceId === "string" ? x.voiceId.slice(0, LIMITS.voiceId) : "",
      createdAt: Number(x.createdAt) || 0,
      updatedAt: Number(x.updatedAt) || 0,
    });
  }
  return out;
}

export function loadDrafts(reviewKey: string): Draft[] {
  try {
    return parseDrafts(localStorage.getItem(draftsKey(reviewKey)));
  } catch {
    return [];
  }
}

/** Returns false when the device would not keep them (storage blocked or full). */
export function saveDrafts(reviewKey: string, drafts: Draft[]): boolean {
  try {
    if (drafts.length) localStorage.setItem(draftsKey(reviewKey), JSON.stringify(drafts));
    else localStorage.removeItem(draftsKey(reviewKey));
    return true;
  } catch {
    return false;
  }
}

export function loadName(): string {
  try {
    return (localStorage.getItem(NAME_KEY) ?? "").slice(0, LIMITS.author);
  } catch {
    return "";
  }
}

export function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* kept in memory only */
  }
}

/* ------------------------------------------------------------- voice blobs ------------------------------------------------------------- */

const DB = "tritone-review";
const STORE = "voice";
const memory = new Map<string, Blob>();
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

const blobKey = (reviewKey: string, draftId: string) => `${reviewKey}/${draftId}`;

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const r = run(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Store a recording; true when it reached IndexedDB (false = kept in memory for this page only). */
export async function putVoice(reviewKey: string, draftId: string, blob: Blob): Promise<boolean> {
  const k = blobKey(reviewKey, draftId);
  memory.set(k, blob);
  // Safari before 14 could not store Blobs in IndexedDB; an ArrayBuffer + type always works.
  const buf = await blob.arrayBuffer();
  const ok = await tx("readwrite", (s) => s.put({ buf, type: blob.type }, k));
  return ok !== undefined;
}

export async function getVoice(reviewKey: string, draftId: string): Promise<Blob | null> {
  const k = blobKey(reviewKey, draftId);
  const m = memory.get(k);
  if (m) return m;
  const v = (await tx("readonly", (s) => s.get(k))) as { buf: ArrayBuffer; type: string } | undefined;
  if (!v?.buf) return null;
  const b = new Blob([v.buf], { type: v.type || "audio/webm" });
  memory.set(k, b);
  return b;
}

export async function deleteVoice(reviewKey: string, draftId: string): Promise<void> {
  const k = blobKey(reviewKey, draftId);
  memory.delete(k);
  await tx("readwrite", (s) => s.delete(k));
}
