// Weekly analytics digest: reads the last 14 days of visitor hits (Firestore "hits") and writes a
// Markdown summary of this week against last week. Used by .github/workflows/analytics-digest.yml,
// which posts it on the "Weekly site analytics" issue. Read-only.
//   GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token) node scripts/analytics-digest.mjs [out.md]
//   HITS_JSON=hits.json node scripts/analytics-digest.mjs      (offline: a JSON array of plain hits)
import { readFileSync, writeFileSync } from "node:fs";
import { decodeDoc, renderDigest, weekWindows } from "./lib/analytics-agg.mjs";

const out = process.argv[2] ?? "analytics-digest.md";
const now = process.env.DIGEST_NOW ? new Date(process.env.DIGEST_NOW) : new Date();

async function fetchHits() {
  if (process.env.HITS_JSON) return JSON.parse(readFileSync(process.env.HITS_JSON, "utf8"));
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error("GOOGLE_ACCESS_TOKEN is not set");
  const project = process.env.FIRESTORE_PROJECT ?? "tritone-site";
  const docs = `projects/${project}/databases/(default)/documents`;
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
    const res = await fetch(`https://firestore.googleapis.com/v1/${docs}:runQuery`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery }),
    });
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

const hits = await fetchHits();
const md = renderDigest(hits, now);
writeFileSync(out, md + "\n");
console.log(md);
console.error(`\n${hits.length} hit(s) read → ${out}`);
