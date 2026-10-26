// Weekly digests: the analytics-digest workflow writes one document per ISO week to the Firestore
// collection "digests" (id = week = week start, YYYY-MM-DD; fields week, from, to, generatedAt,
// visits, pageViews, bookings, md, summary [a JSON string]).
// The dashboard only renders `md` (src/lib/admin/markdown.ts); it never recomputes the digest.
import { FIRESTORE_DOCS } from "../analytics-schema.ts";
import { FirestoreError, friendlyFirestoreError, fromValue } from "./firestore.ts";

export const DIGESTS_COLLECTION = "digests";

export interface Digest { id: string; week: string; md: string; createdAt: string; summary: Record<string, unknown>; visits?: number; pageViews?: number; bookings?: number }

/** The newest `limit` digests, by week (start date) descending. */
export function digestsQuery(limit = 12) {
  return {
    structuredQuery: {
      from: [{ collectionId: DIGESTS_COLLECTION }],
      orderBy: [{ field: { fieldPath: "week" }, direction: "DESCENDING" }],
      limit,
    },
  };
}

export function docToDigest(doc: { name?: string; fields?: Record<string, any> } | undefined): Digest | null {
  const f = doc?.fields;
  if (!f) return null;
  const md = fromValue(f.md);
  if (typeof md !== "string" || !md.trim()) return null;
  const id = (doc!.name ?? "").split("/").pop() ?? "";
  let summary = fromValue(f.summary);
  if (typeof summary === "string") { try { summary = JSON.parse(summary); } catch { summary = {}; } }
  const str = (k: string) => (typeof fromValue(f[k]) === "string" ? (fromValue(f[k]) as string) : "");
  const num = (k: string) => (typeof fromValue(f[k]) === "number" ? (fromValue(f[k]) as number) : undefined);
  const week = str("week") || id;
  return {
    id: week,
    week,
    md,
    createdAt: str("generatedAt") || str("createdAt"),
    summary: summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {},
    visits: num("visits"), pageViews: num("pageViews"), bookings: num("bookings"),
  };
}

export function parseDigests(rows: any[]): Digest[] {
  return (Array.isArray(rows) ? rows : []).map((r) => docToDigest(r?.document)).filter((d): d is Digest => !!d).sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** "2026-10-19" -> "Oct 19 – Oct 25, 2026". */
export function weekLabel(id: string): string {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return id;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const end = new Date(start.getTime() + 6 * 864e5);
  const f = (d: Date, year: boolean) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });
  return `${f(start, false)} – ${f(end, true)}`;
}

export async function fetchDigests(idToken: string, opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<Digest[]> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${FIRESTORE_DOCS}:runQuery`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify(digestsQuery()),
      signal: opts.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw e;
    throw new FirestoreError(0, "NETWORK", friendlyFirestoreError(0, "NETWORK"));
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (Array.isArray(body) ? body[0]?.error : body?.error) ?? {};
    throw new FirestoreError(res.status, err.status ?? "", friendlyFirestoreError(res.status, err.status ?? "", err.message ?? ""));
  }
  return parseDigests(body);
}
