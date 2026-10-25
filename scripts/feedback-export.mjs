// Read-only export of Scott's beta-site feedback notes (Firestore collection "feedback").
// Used by .github/workflows/feedback.yml; GOOGLE_ACCESS_TOKEN is a service-account token
// (gcloud auth print-access-token). Writes feedback.json (oldest first) and prints a table.
//   GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token) node scripts/feedback-export.mjs [out.json]
import { writeFileSync } from "node:fs";

const token = process.env.GOOGLE_ACCESS_TOKEN;
if (!token) throw new Error("GOOGLE_ACCESS_TOKEN is not set");
const project = process.env.FIRESTORE_PROJECT ?? "tritone-site";
const out = process.argv[2] ?? "feedback.json";
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/feedback`;

const notes = [];
let pageToken = "";
do {
  const url = `${base}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Firestore list failed: HTTP ${res.status} ${body?.error?.message ?? ""}`);
  for (const d of body.documents ?? []) {
    const f = Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, v.stringValue ?? Object.values(v)[0]]));
    notes.push({ id: d.name.split("/").pop(), createTime: d.createTime, ...f });
  }
  pageToken = body.nextPageToken ?? "";
} while (pageToken);

notes.sort((a, b) => String(a.createdAt ?? a.createTime).localeCompare(String(b.createdAt ?? b.createTime)));
writeFileSync(out, JSON.stringify(notes, null, 2) + "\n");

const cell = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ");
  return (t.length > n ? t.slice(0, n - 1) + "…" : t).padEnd(n);
};
console.log(`${notes.length} feedback note(s) → ${out}\n`);
console.log(`${cell("createdAt", 24)} | ${cell("page", 24)} | ${cell("selector", 40)} | note`);
console.log("-".repeat(130));
for (const n of notes) console.log(`${cell(n.createdAt, 24)} | ${cell(n.page, 24)} | ${cell(n.selector, 40)} | ${String(n.note ?? "").replace(/\s+/g, " ")}`);
