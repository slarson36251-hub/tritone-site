// Firestore REST reads for the dashboard (no SDK): runQuery on "hits" between two times, ordered
// by t, paged by cursor. Parsing and query building are pure and tested in tests/admin.test.mjs.
import { FIRESTORE_DOCS, HITS_COLLECTION } from "../analytics-schema.ts";
import type { Hit } from "../analytics-schema.ts";

type FsValue = Record<string, any>;

/** A typed Firestore REST value -> plain JS. Timestamps stay ISO strings. */
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
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return undefined; // never used; never shown
  return undefined;
}

const STR_FIELDS = ["sid", "path", "ref", "us", "um", "uc", "ux", "land", "tz", "lang", "ev", "lbl"] as const;

/** A Firestore document -> Hit, or null when it is not a usable hit. */
export function docToHit(doc: { name?: string; fields?: Record<string, FsValue> } | undefined): (Hit & { id: string }) | null {
  const f = doc?.fields;
  if (!f) return null;
  const t = fromValue(f.t);
  const k = fromValue(f.k);
  if (typeof t !== "string" || !Number.isFinite(Date.parse(t)) || (k !== "pv" && k !== "ev")) return null;
  const s = (key: string) => {
    const x = fromValue(f[key]);
    return typeof x === "string" ? x : "";
  };
  const hit: any = { id: (doc!.name ?? "").split("/").pop() ?? "", k, t, first: fromValue(f.first) === true, src: s("src") || "direct", dev: s("dev") || "d" };
  for (const key of STR_FIELDS) hit[key] = s(key);
  if (!["m", "t", "d"].includes(hit.dev)) hit.dev = "d";
  return hit;
}

export const PAGE_SIZE = 1000;

/** structuredQuery for hits with from <= t < to, ordered by t then document name, after an optional cursor. */
export function hitsQuery(fromIso: string, toIso: string, after?: { t: string; name: string }, limit = PAGE_SIZE) {
  const q: any = {
    structuredQuery: {
      from: [{ collectionId: HITS_COLLECTION }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "t" }, op: "GREATER_THAN_OR_EQUAL", value: { timestampValue: fromIso } } },
            { fieldFilter: { field: { fieldPath: "t" }, op: "LESS_THAN", value: { timestampValue: toIso } } },
          ],
        },
      },
      orderBy: [
        { field: { fieldPath: "t" }, direction: "ASCENDING" },
        { field: { fieldPath: "__name__" }, direction: "ASCENDING" },
      ],
      limit,
    },
  };
  if (after) q.structuredQuery.startAt = { values: [{ timestampValue: after.t }, { referenceValue: after.name }], before: false };
  return q;
}

/** runQuery's response array -> hits plus the cursor for the next page (null when done). */
export function parseRunQuery(rows: any[], limit = PAGE_SIZE): { hits: (Hit & { id: string })[]; next: { t: string; name: string } | null } {
  const docs = (Array.isArray(rows) ? rows : []).map((r) => r?.document).filter(Boolean);
  const hits = docs.map(docToHit).filter((h): h is Hit & { id: string } => !!h);
  const last = docs.at(-1);
  const lastT = last ? fromValue(last.fields?.t) : undefined;
  return { hits, next: docs.length >= limit && last && typeof lastT === "string" ? { t: lastT, name: last.name } : null };
}

export class FirestoreError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Plain-English message for a Firestore REST failure. */
export function friendlyFirestoreError(status: number, code: string, message = ""): string {
  if (status === 401 || code === "UNAUTHENTICATED") return "Your sign-in expired. Sign in again to load the numbers.";
  if (status === 403 || code === "PERMISSION_DENIED") return "Firestore said no: this account isn't allowed to read visitor data. Check that the hits read rule in firestore.rules lists this email and has been deployed.";
  if (code === "FAILED_PRECONDITION" && /index/i.test(message)) return "Firestore needs an index for this query. Open the Firebase console link in the browser console to create it, then reload.";
  if (status === 404 || code === "NOT_FOUND") return "The Firestore database wasn't found. Is Firestore switched on for the tritone-site project?";
  if (status === 429 || code === "RESOURCE_EXHAUSTED") return "Firestore is rate-limiting reads right now. Wait a minute and reload.";
  if (status === 0) return "Couldn't reach Firestore. Check the connection and try again.";
  return `Firestore couldn't load the data (${code || status}).`;
}

/** Every hit with from <= t < to, page by page. */
export async function fetchHits(
  idToken: string, from: Date, to: Date,
  opts: { onPage?: (count: number) => void; signal?: AbortSignal; max?: number; fetchImpl?: typeof fetch } = {},
): Promise<(Hit & { id: string })[]> {
  const f = opts.fetchImpl ?? fetch;
  const all: (Hit & { id: string })[] = [];
  let after: { t: string; name: string } | undefined;
  const max = opts.max ?? 200_000;
  for (;;) {
    let res: Response;
    try {
      res = await f(`${FIRESTORE_DOCS}:runQuery`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
        body: JSON.stringify(hitsQuery(from.toISOString(), to.toISOString(), after)),
        signal: opts.signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      throw new FirestoreError(0, "NETWORK", friendlyFirestoreError(0, "NETWORK"));
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (Array.isArray(body) ? body[0]?.error : body?.error) ?? {};
      if (err.message) console.warn("Firestore:", err.message);
      throw new FirestoreError(res.status, err.status ?? "", friendlyFirestoreError(res.status, err.status ?? "", err.message ?? ""));
    }
    const page = parseRunQuery(body);
    all.push(...page.hits);
    opts.onPage?.(all.length);
    if (!page.next || all.length >= max) break;
    after = page.next;
  }
  return all;
}
