// Scott's mix-review queue (/admin/mix-notes): the pure pieces in src/lib/admin/mixnotes.ts (links,
// time and bar / beat, plain text and CSV, grouping song -> client -> submission, follow-along helpers,
// Firestore REST encoding) and the built page staying private. The rules themselves: tests/rules/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const M = await import("../src/lib/admin/mixnotes.ts");
const { demoQueue } = await import("../src/lib/admin/mixnotes-demo.ts");
const { encodeQr } = await import("../src/lib/admin/qr.ts");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEY = "Ab3dEf6hIj9kLm2nOp5qRs8t";

const V2 = { id: "v2", label: "v2 — final", order: 2, bpm: 160, beatsPerBar: 4, offsetSec: 0, markers: [{ name: "Intro", t: 0 }, { name: "Head A", t: 18.2 }, { name: "END", t: 300 }], peaks: [], durationSec: 312.48, createdAt: "", bounceName: "" };
const V1 = { ...V2, id: "v1", label: "v1", order: 1 };
let seq = 0;
const note = (o = {}) => ({
  id: `n${seq++}`, versionId: "v2", t: 42.5, from: 37.5, section: "Head A", bar: 29, beat: 2, kind: "text", text: "Bass up here", voiceId: "", voiceSec: 0,
  author: "Jay", createdAt: "2026-10-26T20:00:00Z", status: "open", submissionId: "s1", reply: "", transcript: "", updatedAt: "", ...o,
});

test("share link: https://tritone-productions.com/review?k=<key>, optional version", () => {
  assert.equal(M.shareLink(KEY), `https://tritone-productions.com/review?k=${KEY}`);
  assert.equal(M.shareLink(KEY, "v2"), `https://tritone-productions.com/review?k=${KEY}&v=v2`);
  assert.equal(M.shareLink("a b&c"), "https://tritone-productions.com/review?k=a+b%26c");
  assert.ok(M.isReviewKey(KEY));
  assert.ok(!M.isReviewKey("short"));
  assert.ok(!M.isReviewKey("../../etc/passwd/xxxxxxxxxx"));
  // The QR code for a share link fits comfortably (version <= 5 at level M).
  assert.ok(encodeQr(M.shareLink(KEY)).version <= 5);
});

test("stream base URL and the /v1/sign bodies", () => {
  assert.equal(M.streamBase(undefined), "https://stream.tritone-productions.com");
  assert.equal(M.streamBase(" https://s.example.com/ "), "https://s.example.com");
  assert.deepEqual(M.signBody(KEY, { version: "v2", kind: "aac" }), { review: KEY, version: "v2", kind: "aac" });
  assert.deepEqual(M.signBody(KEY, { voiceId: "abc.webm" }), { review: KEY, voiceId: "abc.webm", kind: "voice" });
});

test("time as m:ss.s, never rounded up past the note", () => {
  assert.equal(M.fmtTime(0), "0:00.0");
  assert.equal(M.fmtTime(42.56), "0:42.5");
  assert.equal(M.fmtTime(59.99), "0:59.9");
  assert.equal(M.fmtTime(60), "1:00.0");
  assert.equal(M.fmtTime(312.48), "5:12.4");
  assert.equal(M.fmtTime(3600), "60:00.0");
  assert.equal(M.fmtTime(-3), "0:00.0");
  assert.equal(M.fmtTime(NaN), "0:00.0");
});

test("bar / beat follow the contract formula", () => {
  assert.deepEqual(M.barBeat(0, V2), { bar: 1, beat: 1 });
  assert.deepEqual(M.barBeat(0.375, V2), { bar: 1, beat: 2 }); // 160 bpm: a beat is 0.375 s
  assert.deepEqual(M.barBeat(1.5, V2), { bar: 2, beat: 1 });
  assert.deepEqual(M.barBeat(42.5, V2), { bar: 29, beat: 2 });
  assert.deepEqual(M.barBeat(1.5, { bpm: 160, beatsPerBar: 3, offsetSec: 0 }), { bar: 2, beat: 2 });
  assert.deepEqual(M.barBeat(0, { bpm: 160, beatsPerBar: 4, offsetSec: 1.5 }), { bar: 2, beat: 1 });
  assert.equal(M.barBeatLabel({ bar: 29, beat: 2 }), "Bar 29 · Beat 2");
  assert.equal(M.sectionAt(20, V2.markers), "Head A");
  assert.equal(M.sectionAt(301, V2.markers), "");
});

test("words: typed text, or a voice note's transcript, or a placeholder", () => {
  assert.equal(M.noteWords(note()), "Bass up here");
  assert.equal(M.noteWords(note({ kind: "voice", text: "", transcript: "more snare" })), "more snare");
  assert.equal(M.noteWords(note({ kind: "voice", text: "", voiceSec: 7.2 })), "(voice note, 0:07)");
});

test("plain-text notes: by version, timeline order, with replies", () => {
  const txt = M.notesPlainText({ title: "Translucent", artist: "Fault Line Trio", key: KEY }, [V1, V2], [
    note({ t: 100, from: 95, bar: 67, beat: 3, section: "Solo", text: "Piano\nlouder", status: "doing" }),
    note({ t: 42.5, reply: "Fixed in v3" }),
    note({ versionId: "v1", t: 10, from: 5, bar: 7, beat: 3, section: "", text: "Ride" , status: "done" }),
    note({ t: 60, kind: "voice", text: "", voiceId: "a.webm", voiceSec: 5, transcript: "tuck the fill", author: "Maya" }),
  ]);
  assert.equal(txt, [
    "Translucent — Fault Line Trio",
    `https://tritone-productions.com/review?k=${KEY}`,
    "",
    "v1",
    "- 0:10.0  Bar 7 · Beat 3 — Jay: Ride (done)",
    "",
    "v2 — final",
    "- 0:42.5  Bar 29 · Beat 2  Head A — Jay: Bass up here (open)",
    "    Reply: Fixed in v3",
    "- 1:00.0  Bar 29 · Beat 2  Head A — Maya [voice]: tuck the fill (open)",
    "- 1:40.0  Bar 67 · Beat 3  Solo — Jay: Piano louder (doing)",
    "",
  ].join("\n"));
  assert.match(M.notesPlainText({ title: "X", artist: "", key: KEY }, [], []), /^X\n.*\n\nNo notes\.\n$/);
});

test("CSV: the agreed columns, quoting, formula-safe, CRLF", () => {
  const csv = M.notesCsv([
    note({ t: 100, bar: 67, beat: 3, section: "Solo", text: 'Say "more", please' }),
    note({ t: 42.5, text: "=HYPERLINK(\"x\")" }),
    note({ t: 50, kind: "voice", text: "", voiceId: "a.webm", voiceSec: 5, transcript: "line one\nline two", status: "done" }),
  ], [V2]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "time,bar,beat,section,author,kind,text,status");
  assert.equal(lines[1], `0:42.5,29,2,Head A,Jay,text,"'=HYPERLINK(""x"")",open`);
  assert.equal(lines[2], `0:50.0,29,2,Head A,Jay,voice,"line one\nline two",done`);
  assert.equal(lines[3], `1:40.0,67,3,Solo,Jay,text,"Say ""more"", please",open`);
  assert.ok(csv.endsWith("\r\n"));
  assert.deepEqual([...M.CSV_COLUMNS], ["time", "bar", "beat", "section", "author", "kind", "text", "status"]);
  assert.equal(M.fileSlug("Translucent (v2) — Fault Line"), "translucent-v2-fault-line");
});

test("queue groups song -> client -> submission, newest first, notes in timeline order", () => {
  const review = { key: KEY, title: "Translucent", artist: "FLT", clients: ["Jay"], status: "open", latestVersion: "v2", createdAt: "2026-10-01T00:00:00Z", updatedAt: "" };
  const subs = [
    { id: "old", author: "Jay", versionId: "v1", noteCount: 1, createdAt: "2026-10-02T00:00:00Z", status: "done", updatedAt: "" },
    { id: "new", author: "Jay", versionId: "v2", noteCount: 2, createdAt: "2026-10-20T00:00:00Z", status: "new", updatedAt: "" },
    { id: "maya", author: "Maya", versionId: "v2", noteCount: 1, createdAt: "2026-10-10T00:00:00Z", status: "listening", updatedAt: "" },
  ];
  const notes = [
    note({ submissionId: "new", t: 90, status: "doing" }), note({ submissionId: "new", t: 12 }),
    note({ submissionId: "old", versionId: "v1", t: 5, status: "done" }),
    note({ submissionId: "maya", author: "Maya", t: 30 }),
  ];
  const closed = { review: { ...review, key: "Closed0Closed0Closed0Abc", status: "closed", updatedAt: "2026-10-25T00:00:00Z" }, versions: [V2], submissions: [], notes: [] };
  const [song, other] = M.groupQueue([closed, { review, versions: [V2, V1], submissions: subs, notes }], "all");
  assert.equal(song.review.key, KEY, "open reviews first");
  assert.equal(other.review.status, "closed");
  assert.deepEqual(song.versions.map((v) => v.id), ["v1", "v2"]);
  assert.equal(song.openNotes, 3);
  assert.equal(song.newSubs, 1);
  assert.deepEqual(song.clients.map((c) => c.author), ["Jay", "Maya"]);
  assert.deepEqual(song.clients[0].submissions.map((s) => s.submission.id), ["new", "old"]);
  assert.deepEqual(song.clients[0].submissions[0].notes.map((n) => n.t), [12, 90]);
  assert.equal(song.clients[0].open, 2);

  const open = M.groupQueue([{ review, versions: [V2, V1], submissions: subs, notes }], "open")[0];
  assert.deepEqual(open.clients.map((c) => [c.author, c.submissions.map((s) => s.notes.length)]), [["Jay", [1]], ["Maya", [1]]]);
  const done = M.groupQueue([{ review, versions: [V2, V1], submissions: subs, notes }], "done")[0];
  assert.deepEqual(done.clients.map((c) => c.submissions.map((s) => s.submission.id)), [["old"]]);

  // A note whose submission is missing still shows up, grouped by author and version.
  const orphan = M.groupQueue([{ review, versions: [V2], submissions: [], notes: [note({ submissionId: "gone" })] }])[0];
  assert.equal(orphan.clients[0].submissions[0].submission.id, "");
  assert.equal(orphan.clients[0].submissions[0].notes.length, 1);
});

test("follow-along: clip ranges, crossings and the note at a time", () => {
  assert.deepEqual(M.clipFor({ from: 37.5, t: 42.5 }), { start: 37.5, end: 42.5 });
  assert.deepEqual(M.clipFor({ from: 42.5, t: 42.5 }), { start: 37.5, end: 42.5 }, "zero-length -> 5 s before");
  assert.deepEqual(M.clipFor({ from: 0, t: 2 }), { start: 0, end: 2 });
  assert.deepEqual(M.clipFor({ from: 0.1, t: 0.2 }), { start: 0, end: 0.2 });
  const ns = [{ t: 10 }, { t: 20 }, { t: 30 }];
  assert.equal(M.crossedNote(ns, 9.9, 10.02), 0);
  assert.equal(M.crossedNote(ns, 10, 10.1), -1, "already past");
  assert.equal(M.crossedNote(ns, 19.95, 20), 1);
  assert.equal(M.crossedNote(ns, 5, 25), -1, "a seek is not a crossing");
  assert.equal(M.crossedNote(ns, 21, 20), -1, "backwards");
  assert.equal(M.noteAt(ns, 0), 0);
  assert.equal(M.noteAt(ns, 25), 1);
  assert.equal(M.noteAt(ns, 99), 2);
  assert.equal(M.noteAt([], 5), -1);
  const d = M.waveformPath([0, 255, 128, 64], 100, 40, 4);
  assert.equal((d.match(/M/g) ?? []).length, 4);
  assert.equal(M.waveformPath([], 100, 40), "");
});

test("Firestore REST: typed values and the admin's stamped writes", () => {
  assert.deepEqual(M.toValue(29), { integerValue: "29" });
  assert.deepEqual(M.toValue(42.5), { doubleValue: 42.5 });
  assert.deepEqual(M.toValue(new M.Double(42)), { doubleValue: 42 });
  assert.deepEqual(M.toValue(["a"]), { arrayValue: { values: [{ stringValue: "a" }] } });
  assert.deepEqual(M.toValue({ t: 1.5 }), { mapValue: { fields: { t: { doubleValue: 1.5 } } } });
  assert.deepEqual(M.toValue(new Date("2026-10-26T00:00:00Z")), { timestampValue: "2026-10-26T00:00:00.000Z" });
  const w = M.noteStatusWrite(M.DB_ROOT, KEY, "n1", "done");
  assert.deepEqual(w, {
    update: { name: `projects/tritone-site/databases/(default)/documents/reviews/${KEY}/notes/n1`, fields: { status: { stringValue: "done" } } },
    updateMask: { fieldPaths: ["status"] },
    updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
    currentDocument: { exists: true },
  });
  assert.deepEqual(M.noteReplyWrite(M.DB_ROOT, KEY, "n1", "x".repeat(5000)).update.fields.reply.stringValue.length, 4000);
  assert.deepEqual(M.reviewStatusWrite(M.DB_ROOT, KEY, "closed").updateMask, { fieldPaths: ["status"] });
  assert.deepEqual(M.submissionStatusWrite(M.DB_ROOT, KEY, "s1", "listening").update.name.split("/").slice(-4), ["reviews", KEY, "submissions", "s1"]);
});

test("Firestore REST: documents decode into reviews, versions, submissions and notes", () => {
  const doc = (path, fields) => ({ name: `projects/tritone-site/databases/(default)/documents/${path}`, fields: M.toFields(fields) });
  const r = M.docToReview(doc(`reviews/${KEY}`, { title: "Translucent", artist: "FLT", clients: ["Jay"], status: "closed", latestVersion: "v2" }));
  assert.deepEqual([r.key, r.status, r.clients], [KEY, "closed", ["Jay"]]);
  const v = M.docToVersion(doc(`reviews/${KEY}/versions/v2`, { label: "v2", order: 2, bpm: 160, beatsPerBar: 4, offsetSec: 0, durationSec: 312.48, markers: [{ name: "B", t: 20 }, { name: "A", t: 1.5 }], peaks: [1, 2] }));
  assert.deepEqual(v.markers.map((m) => m.name), ["A", "B"]);
  assert.deepEqual(v.peaks, [1, 2]);
  const n = M.docToNote(doc(`reviews/${KEY}/notes/n9`, { ...note(), status: "weird", kind: "voice" }));
  assert.deepEqual([n.id, n.status, n.kind, n.t, n.bar], ["n9", "open", "voice", 42.5, 29]);
  const s = M.docToSubmission(doc(`reviews/${KEY}/submissions/s1`, { author: "Jay", versionId: "v2", noteCount: 3, status: "listening" }));
  assert.deepEqual([s.id, s.status, s.noteCount], ["s1", "listening", 3]);
  assert.equal(M.docToNote({}), null);
});

test("demo data is made up and fits the grouping", () => {
  const q = demoQueue(Date.parse("2026-10-26T20:00:00Z"));
  const g = M.groupQueue(q, "all");
  assert.equal(g[0].review.status, "open");
  assert.ok(g[0].clients.length >= 2);
  assert.ok(q.every((d) => d.review.key.startsWith("DEMO")));
  assert.ok(!/street|\b9\d{4}\b/i.test(JSON.stringify(q)));
});

// ---- built page (CI builds before npm test) ----
const DIST = join(ROOT, "dist");
const page = join(DIST, "admin", "mix-notes.html");
test("/admin/mix-notes is noindex, unlinked and out of the sitemap", { skip: !existsSync(page) && "dist/ not built" }, () => {
  const html = readFileSync(page, "utf8");
  assert.match(html, /<meta name="robots" content="noindex"/);
  for (const f of ["sitemap-0.xml", "llms.txt", "llms-full.txt"]) {
    if (existsSync(join(DIST, f))) assert.ok(!/mix-notes|\/review\b/.test(readFileSync(join(DIST, f), "utf8")), `${f} mentions the review pages`);
  }
  for (const f of ["index.html", "hummingbird-hut.html", "shows.html", "404.html"]) {
    if (existsSync(join(DIST, f))) assert.ok(!/href="\/admin\/mix-notes/.test(readFileSync(join(DIST, f), "utf8")), `${f} links /admin/mix-notes`);
  }
  assert.match(html, /tritone-wordmark-white/, "carries the real logo");
});
