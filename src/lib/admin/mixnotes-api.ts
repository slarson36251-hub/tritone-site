// Network side of /admin/mix-notes: Firestore REST with Scott's ID token (lists every review with its
// versions, submissions and notes; :commit for status / reply changes) and the NAS stream server's
// POST /v1/sign for playback. Shapes and pure helpers live in ./mixnotes.ts.
import { FIRESTORE_DOCS } from "../analytics-schema.ts";
import { FirestoreError } from "./firestore.ts";
import {
  docToNote, docToReview, docToSubmission, docToVersion, signBody,
  type Note, type Review, type Submission, type Version,
} from "./mixnotes.ts";

export interface ReviewData { review: Review; versions: Version[]; submissions: Submission[]; notes: Note[] }

export function friendlyMixError(status: number, code: string, message = ""): string {
  if (status === 401 || code === "UNAUTHENTICATED") return "Your sign-in expired. Sign in again to load the notes.";
  if (status === 403 || code === "PERMISSION_DENIED") return "Firestore said no: this account can't read or change mix reviews. Check that the reviews rules in firestore.rules are deployed.";
  if (code === "FAILED_PRECONDITION" && /index/i.test(message)) return "Firestore needs an index for this. Open the link in the browser console to create it, then reload.";
  if (status === 404 || code === "NOT_FOUND") return "That review or note no longer exists. Reload the list.";
  if (status === 429 || code === "RESOURCE_EXHAUSTED") return "Firestore is rate-limiting right now. Wait a minute and try again.";
  if (status === 0) return "Couldn't reach Firestore. Check the connection and try again.";
  return `Firestore couldn't do that (${code || status}).`;
}

async function fsFetch(f: typeof fetch, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (e: any) {
    if (e?.name === "AbortError") throw e;
    throw new FirestoreError(0, "NETWORK", friendlyMixError(0, "NETWORK"));
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (Array.isArray(body) ? body[0]?.error : body?.error) ?? {};
    if (err.message) console.warn("Firestore:", err.message);
    throw new FirestoreError(res.status, err.status ?? "", friendlyMixError(res.status, err.status ?? "", err.message ?? ""));
  }
  return body;
}

/** Every document of a collection (path relative to the database root), page by page. */
export async function listAll(idToken: string, path: string, opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<any[]> {
  const f = opts.fetchImpl ?? fetch;
  const out: any[] = [];
  let pageToken = "";
  for (let guard = 0; guard < 50; guard++) {
    const q = new URLSearchParams({ pageSize: "300" });
    if (pageToken) q.set("pageToken", pageToken);
    const body = await fsFetch(f, `${FIRESTORE_DOCS}/${path}?${q}`, { headers: { authorization: `Bearer ${idToken}` }, signal: opts.signal });
    out.push(...(body?.documents ?? []));
    pageToken = body?.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
}

/** All reviews with their versions, submissions and notes. */
export async function loadQueue(idToken: string, opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<ReviewData[]> {
  const reviews = (await listAll(idToken, "reviews", opts)).map(docToReview).filter((r): r is Review => !!r);
  return Promise.all(reviews.map(async (review) => {
    const base = `reviews/${encodeURIComponent(review.key)}`;
    const [v, s, n] = await Promise.all([
      listAll(idToken, `${base}/versions`, opts),
      listAll(idToken, `${base}/submissions`, opts),
      listAll(idToken, `${base}/notes`, opts),
    ]);
    return {
      review,
      versions: v.map(docToVersion).filter((x): x is Version => !!x),
      submissions: s.map(docToSubmission).filter((x): x is Submission => !!x),
      notes: n.map(docToNote).filter((x): x is Note => !!x),
    };
  }));
}

/** Apply writes atomically (documents:commit). */
export async function commitWrites(idToken: string, writes: unknown[], opts: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  await fsFetch(opts.fetchImpl ?? fetch, `${FIRESTORE_DOCS}:commit`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ writes }),
  });
}

// ------------------------------------------------------------------ stream server
export class StreamError extends Error {}

const signed = new Map<string, { url: string; exp: number }>();

/** A signed, time-limited URL for a version's song (aac) or a client's voice note. Cached until 10 min before expiry. */
export async function signUrl(
  base: string, review: string, what: { version: string; kind: "aac" | "wav" } | { voiceId: string },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const body = signBody(review, what);
  const k = JSON.stringify(body);
  const hit = signed.get(k);
  if (hit && Date.now() < hit.exp - 10 * 60e3) return hit.url;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${base}/v1/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new StreamError(`Couldn't reach the stream server (${new URL(base).host}). Is the NAS tunnel up?`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || typeof json?.url !== "string") {
    if (res.status === 403 || res.status === 404 || res.status === 410)
      throw new StreamError("The stream server won't play this one. A closed review can't be played: reopen it to listen.");
    throw new StreamError(`The stream server couldn't sign that file (${json?.error ?? res.status}).`);
  }
  const exp = Date.parse(json.expiresAt) || Date.now() + 3600e3;
  signed.set(k, { url: json.url, exp });
  return json.url;
}
