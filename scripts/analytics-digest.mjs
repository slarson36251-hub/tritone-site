// Weekly analytics digest: reads the last 14 days of visitor hits (Firestore "hits"), renders a
// Markdown summary of this week against last week, writes it to a local file and, with a token,
// stores it in Firestore collection "digests" (document id = ISO week start, YYYY-MM-DD) where only
// Scott's dashboard (/admin) can read it. The repository is public, so the digest is never posted
// anywhere on GitHub; the workflow keeps it only as a private artifact.
//   GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token) node scripts/analytics-digest.mjs [out.md]
//   HITS_JSON=hits.json node scripts/analytics-digest.mjs      (offline: a JSON array of plain hits; no write)
//   DIGEST_NO_WRITE=1                                           (read hits, skip the Firestore write)
//
// Document fields in `digests/<week>`:
//   week        string     "YYYY-MM-DD", the Monday starting the ISO week of the window start (= the id)
//   from, to    timestamp  the current 7-day window [from, to)
//   generatedAt timestamp  when this digest was made
//   visits, pageViews, bookings  integer  headline numbers for this week
//   md          string     the rendered Markdown digest
//   summary     string     JSON of digestSummary() (scripts/lib/analytics-agg.mjs: DigestSummary)
import { readFileSync, writeFileSync } from "node:fs";
import { decodeDoc, digestDoc, digestSummary, renderDigest, weekWindows } from "./lib/analytics-agg.mjs";

const out = process.argv[2] ?? "analytics-digest.md";
const now = process.env.DIGEST_NOW ? new Date(process.env.DIGEST_NOW) : new Date();
const project = process.env.FIRESTORE_PROJECT ?? "tritone-site";
const docs = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const token = process.env.GOOGLE_ACCESS_TOKEN;
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function fetchHits() {
  if (process.env.HITS_JSON) return JSON.parse(readFileSync(process.env.HITS_JSON, "utf8"));
  if (!token) throw new Error("GOOGLE_ACCESS_TOKEN is not set");
  const since = weekWindows(now).prevStart.toISOString();
  const PAGE = 1000;
  const hits = [];
  let after = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: "hits" }],
      where: { fieldFilter: { field: { fieldPath: "t" }, op: "GREATER_THAN_OR_EQUAL", value: { timestampValue: since } } },
      orderBy: [
        { field: { fieldPath: "t" }, direction: "ASCENDING" },
        { field: { fieldPath: "__name__" }, direction: "ASCENDING" },
      ],
      limit: PAGE,
      ...(after ? { startAt: { values: [{ timestampValue: after.t }, { referenceValue: after.name }], before: false } } : {}),
    };
    const res = await fetch(`${docs}:runQuery`, { method: "POST", headers: auth, body: JSON.stringify({ structuredQuery }) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Firestore runQuery failed: HTTP ${res.status} ${body?.[0]?.error?.message ?? body?.error?.message ?? ""}`);
    const page = (body ?? []).filter((r) => r.document).map((r) => r.document);
    for (const d of page) hits.push(decodeDoc(d));
    if (page.length < PAGE) break;
    const last = page[page.length - 1];
    after = { t: last.fields.t.timestampValue, name: last.name };
  }
  return hits;
}

async function storeDigest(summary, md) {
  const res = await fetch(`${docs}/digests/${encodeURIComponent(summary.week)}`, { method: "PATCH", headers: auth, body: JSON.stringify(digestDoc(summary, md)) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Firestore write failed: HTTP ${res.status} ${body?.error?.message ?? ""} (the service account needs roles/datastore.user on ${project})`);
  }
}

const hits = await fetchHits();
const md = renderDigest(hits, now);
const summary = digestSummary(hits, now);
writeFileSync(out, md + "\n");
console.log(md);
console.error(`\n${hits.length} hit(s) read → ${out}`);
if (token && !process.env.HITS_JSON && !process.env.DIGEST_NO_WRITE) {
  await storeDigest(summary, md);
  console.error(`stored as digests/${summary.week}`);
}
