// Mix review (/review): timeline maths, the Firestore write shapes (must match
// docs/mix-review-contract.md v1.1 and firestore.rules), stream-server URLs, draft storage parsing,
// analytics exclusion, and the built page staying private.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const M = await import("../src/lib/review/music.ts");
const F = await import("../src/lib/review/firestore.ts");
const St = await import("../src/lib/review/stream.ts");
const D = await import("../src/lib/review/drafts.ts");
const R = await import("../src/lib/review/recorder.ts");
const Sc = await import("../src/lib/review/schema.ts");
const T = await import("../src/lib/track.ts");
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const tempo = { bpm: 160, beatsPerBar: 4, offsetSec: 0 };

test("bar and beat follow the contract formula", () => {
  assert.deepEqual(M.barBeat(0, tempo), { bar: 1, beat: 1 });
  assert.deepEqual(M.barBeat(0.375, tempo), { bar: 1, beat: 2 }); // one beat at 160 bpm
  assert.deepEqual(M.barBeat(1.5, tempo), { bar: 2, beat: 1 }); // exactly on a downbeat
  assert.deepEqual(M.barBeat(1.4999, tempo), { bar: 1, beat: 4 });
  assert.deepEqual(M.barBeat(101.3, tempo), { bar: Math.floor(Math.floor((101.3 * 160) / 60) / 4) + 1, beat: (Math.floor((101.3 * 160) / 60) % 4) + 1 });
  assert.deepEqual(M.barBeat(0, { bpm: 120, beatsPerBar: 3, offsetSec: 1 }), { bar: 1, beat: 3 }); // offset shifts session time
  assert.deepEqual(M.barBeat(0, { bpm: 120, beatsPerBar: 4, offsetSec: -3 }), { bar: 1, beat: 1 }); // before session zero clamps
});

test("no tempo (bpm 0 or missing): no bars, notes still carry bar 1 · beat 1", () => {
  for (const t of [{ bpm: 0, beatsPerBar: 4, offsetSec: 0 }, { beatsPerBar: 4, offsetSec: 0 }, { bpm: -5, beatsPerBar: 4, offsetSec: 0 }, { bpm: NaN, beatsPerBar: 4, offsetSec: 0 }, null]) {
    assert.equal(M.hasTempo(t), false, JSON.stringify(t));
    if (t) assert.deepEqual(M.barBeat(123.4, t), { bar: 1, beat: 1 });
  }
  assert.equal(M.hasTempo({ bpm: 160 }), true);
  const v0 = { ...version, bpm: 0 };
  const n = F.noteFromDraft(draft(), v0, "Jay", "S");
  assert.equal(n.bar, 1);
  assert.equal(n.beat, 1);
  assert.equal(n.section, "Head B", "section still comes from the markers");
  assert.deepEqual(F.noteFields(n).bar, { integerValue: "1" });
  assert.deepEqual(F.noteFields(n).beat, { integerValue: "1" });
  // A version written without bpm (or with 0) parses as no tempo.
  assert.equal(F.docToVersion({ name: "x/versions/v1", fields: { durationSec: { doubleValue: 60 } } }).bpm, 0);
  assert.equal(F.docToVersion({ name: "x/versions/v1", fields: { durationSec: { doubleValue: 60 }, bpm: { integerValue: "0" } } }).bpm, 0);
});

const markers = [
  { name: "Intro", t: 0 }, { name: "Head A", t: 18.2 }, { name: "Head B", t: 52 }, { name: "Coda", t: 286 }, { name: "END", t: 300 },
];

test("sections come from markers, END only closes the last one", () => {
  const s = M.sectionsOf(markers, 312.48);
  assert.deepEqual(s.map((x) => x.name), ["Intro", "Head A", "Head B", "Coda", ""]);
  assert.equal(s[3].end, 300);
  assert.equal(M.sectionNameAt(s, 0), "Intro");
  assert.equal(M.sectionNameAt(s, 18.2), "Head A");
  assert.equal(M.sectionNameAt(s, 51.99), "Head A");
  assert.equal(M.sectionNameAt(s, 305), "");
  assert.deepEqual(M.laneSections(s).map((x) => x.name), ["Intro", "Head A", "Head B", "Coda"]);
  // Time before the first marker, and no markers at all, are unnamed.
  assert.equal(M.sectionNameAt(M.sectionsOf([{ name: "A", t: 10 }], 60), 3), "");
  assert.deepEqual(M.sectionsOf([], 60), [{ name: "", start: 0, end: 60 }]);
});

test("previous / next marker", () => {
  const s = M.sectionsOf(markers, 312.48);
  assert.equal(M.prevMarkerTime(s, 30), 18.2); // well into Head A: back to its start
  assert.equal(M.prevMarkerTime(s, 19), 0); // just after: the one before
  assert.equal(M.nextMarkerTime(s, 30), 52);
  assert.equal(M.nextMarkerTime(s, 305), null);
});

test("time formatting", () => {
  assert.equal(M.fmtTime(0), "0:00.0");
  assert.equal(M.fmtTime(101.34), "1:41.3");
  assert.equal(M.fmtTime(59.96), "1:00.0");
  assert.equal(M.fmtShort(312.48), "5:12");
  assert.equal(M.fmtShort(-1), "0:00");
});

test("views, pointer maths and clip ranges", () => {
  const s = M.sectionsOf(markers, 312.48);
  assert.deepEqual(M.viewRange(s, 312.48, 30, false, null), [0, 312.48]);
  assert.deepEqual(M.viewRange(s, 312.48, 30, true, null), [18.2, 52]);
  assert.deepEqual(M.viewRange(s, 312.48, 30, true, s[2]), [52, 286]); // the loop wins
  assert.deepEqual(M.viewRange(M.sectionsOf([], 100), 100, 50, true, null), [40, 60]); // no markers: 20 s window
  assert.equal(M.xToTime(195, 390, [0, 312], 312), 156);
  assert.equal(M.xToTime(-50, 390, [0, 312], 312), 0);
  assert.equal(M.xToTime(9999, 390, [0, 312], 312), 312 - 0.05);
  assert.equal(M.clipStart(101.3, null), 101.3 - 5);
  assert.equal(M.clipStart(3, null), 0);
  assert.equal(M.clipStart(101.3, 86), 86);
  assert.deepEqual(M.moveRange(10, 15, 3, 100), { from: 13, t: 18 });
  assert.deepEqual(M.moveRange(10, 15, -30, 100), { from: 0, t: 5 });
  assert.deepEqual(M.moveRange(90, 95, 30, 100), { from: 95, t: 100 });
  assert.deepEqual(M.moveStart(10, 15, 20), { from: 15, t: 15 }); // from never passes t
  assert.deepEqual(M.moveStart(10, 15, -2), { from: 0, t: 15 });
  assert.deepEqual(M.moveEnd(10, 15, 5, 100), { from: 10, t: 10 });
});

test("overlapping drafts stack into rows", () => {
  const { rows, count } = M.assignLanes([
    { id: "a", from: 0, t: 10 }, { id: "b", from: 5, t: 12 }, { id: "c", from: 11, t: 20 }, { id: "d", from: 12, t: 13 },
  ]);
  assert.equal(rows.a, 0);
  assert.equal(rows.b, 1);
  assert.equal(rows.c, 0);
  assert.equal(rows.d, 1);
  assert.equal(count, 2);
  assert.equal(M.assignLanes([]).count, 0);
});

test("peaks pick the loudest bin in a window", () => {
  const peaks = Array.from({ length: 1200 }, (_, i) => (i === 600 ? 255 : 51));
  assert.equal(M.peakBetween(peaks, 120, 59.9, 60.2), 1);
  assert.equal(M.peakBetween(peaks, 120, 0, 1), 0.2);
  assert.equal(M.peakBetween([], 120, 0, 1), 0);
});

/* ---------------- Firestore ---------------- */

const version = {
  id: "v2", label: "v2 — final", order: 2, bounceName: "x.wav", durationSec: 312.48, sampleRate: 48000,
  bpm: 160, beatsPerBar: 4, offsetSec: 0, markers, peaks: [],
};
const draft = (o = {}) => ({
  id: "abcdefghij0123456789", versionId: "v2", t: 101.3, from: 96.3, kind: "text", text: "  Ride up a bit  ", voiceSec: 0,
  hasVoice: false, voiceType: "", voiceId: "", createdAt: 1, updatedAt: 1, ...o,
});

test("a text draft becomes exactly the note shape the contract allows", () => {
  const n = F.noteFromDraft(draft(), version, "  Jay  ", "SUB123");
  assert.deepEqual(n, {
    versionId: "v2", t: 101.3, from: 96.3, section: "Head B", bar: M.barBeat(101.3, version).bar, beat: M.barBeat(101.3, version).beat,
    kind: "text", text: "Ride up a bit", voiceId: "", voiceSec: 0, author: "Jay", submissionId: "SUB123",
  });
  const fields = F.noteFields(n);
  assert.deepEqual(F.writtenKeys(fields), F.EXPECTED_NOTE_KEYS);
  assert.deepEqual(F.EXPECTED_NOTE_KEYS, [
    "author", "bar", "beat", "createdAt", "from", "kind", "section", "status", "submissionId", "t", "text", "versionId", "voiceId", "voiceSec",
  ]);
  assert.equal(fields.status.stringValue, "open");
  assert.match(fields.bar.integerValue, /^\d+$/);
  assert.match(fields.beat.integerValue, /^\d+$/);
  assert.equal(typeof fields.t.doubleValue, "number");
});

test("a voice draft carries its uploaded id and length; limits are enforced", () => {
  const n = F.noteFromDraft(draft({ kind: "voice", text: "", voiceId: "1b2c.m4a", hasVoice: true, voiceSec: 12.3456 }), version, "Jay", "S");
  assert.equal(n.kind, "voice");
  assert.equal(n.voiceId, "1b2c.m4a");
  assert.equal(n.voiceSec, 12.346);
  assert.equal(n.text, "");
  const big = F.noteFromDraft(draft({ t: 99999, from: 99999, text: "x".repeat(5000) }), version, "N".repeat(80), "S".repeat(50));
  assert.equal(big.t, 312.48);
  assert.ok(big.from <= big.t && big.from >= 0);
  assert.equal(big.text.length, Sc.LIMITS.text);
  assert.equal(big.author.length, Sc.LIMITS.author);
  assert.equal(big.submissionId.length, Sc.LIMITS.submissionId);
  const odd = F.noteFromDraft(draft({ from: 120 }), version, "Jay", "S"); // from after t is pulled back
  assert.equal(odd.from, odd.t);
  // A voice draft whose upload never happened is sent as text, never with an empty voiceId.
  assert.equal(F.noteFromDraft(draft({ kind: "voice", voiceId: "" }), version, "Jay", "S").kind, "text");
  assert.equal(F.draftReady(draft({ text: "  " })), false);
  assert.equal(F.draftReady(draft({ kind: "voice", hasVoice: true, text: "" })), true);
});

test("one atomic commit: the submission, then its notes, all create-only with server time", () => {
  const notes = [{ id: "n1", note: F.noteFromDraft(draft(), version, "Jay", "SUB") }, { id: "n2", note: F.noteFromDraft(draft({ t: 20 }), version, "Jay", "SUB") }];
  const body = F.commitBody("KEY123", "SUB", "Jay", "v2", notes);
  assert.equal(body.writes.length, 3);
  const [sub, a, b] = body.writes;
  assert.equal(sub.update.name, "projects/tritone-site/databases/(default)/documents/reviews/KEY123/submissions/SUB");
  assert.equal(a.update.name, "projects/tritone-site/databases/(default)/documents/reviews/KEY123/notes/n1");
  assert.equal(b.update.name.split("/").pop(), "n2");
  for (const w of body.writes) {
    assert.deepEqual(w.currentDocument, { exists: false });
    assert.deepEqual(w.updateTransforms, [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]);
  }
  assert.deepEqual(F.writtenKeys(sub.update.fields), F.EXPECTED_SUBMISSION_KEYS);
  assert.deepEqual(F.EXPECTED_SUBMISSION_KEYS, ["author", "createdAt", "noteCount", "status", "versionId"]);
  assert.deepEqual(sub.update.fields.noteCount, { integerValue: "2" });
  assert.equal(sub.update.fields.status.stringValue, "new");
  assert.equal(a.update.fields.submissionId.stringValue, "SUB");
  assert.equal(F.commitUrl("K"), "https://firestore.googleapis.com/v1/projects/tritone-site/databases/(default)/documents:commit?key=K");
});

test("REST URLs and document parsing", () => {
  assert.equal(F.reviewUrl("abc", "k k"), "https://firestore.googleapis.com/v1/projects/tritone-site/databases/(default)/documents/reviews/abc?key=k%20k");
  assert.match(F.listUrl("abc", "notes", "K", "tok/1"), /\/reviews\/abc\/notes\?key=K&pageSize=300&pageToken=tok%2F1$/);
  const v = F.docToVersion({
    name: "projects/p/databases/(default)/documents/reviews/abc/versions/v2",
    fields: {
      label: { stringValue: "v2 — final" }, order: { integerValue: "2" }, durationSec: { doubleValue: 312.48 }, bpm: { integerValue: "160" },
      beatsPerBar: { integerValue: "4" }, offsetSec: { integerValue: "0" },
      markers: { arrayValue: { values: [
        { mapValue: { fields: { name: { stringValue: "Head A" }, t: { doubleValue: 18.2 } } } },
        { mapValue: { fields: { name: { stringValue: "Intro" }, t: { integerValue: "0" } } } },
      ] } },
      peaks: { arrayValue: { values: [{ integerValue: "300" }, { integerValue: "12" }] } },
    },
  });
  assert.equal(v.id, "v2");
  assert.deepEqual(v.markers.map((m) => m.name), ["Intro", "Head A"]);
  assert.deepEqual(v.peaks, [255, 12]);
  assert.equal(F.docToVersion({ fields: { durationSec: { integerValue: "0" } } }), null);
  const r = F.docToReview({ fields: { title: { stringValue: "Translucent" }, status: { stringValue: "open" }, latestVersion: { stringValue: "v2" } } }, "abc");
  assert.equal(r.status, "open");
  assert.equal(F.docToReview({ fields: { status: { stringValue: "weird" } } }, "abc").status, "closed");
  const n = F.docToNote({ name: "x/notes/n1", fields: { t: { doubleValue: 20 }, from: { doubleValue: 30 }, kind: { stringValue: "voice" }, status: { stringValue: "doing" }, author: { stringValue: "Jay" } } });
  assert.equal(n.id, "n1");
  assert.equal(n.from, 20);
  assert.equal(n.status, "doing");
  assert.equal(F.pickVersion([v, { ...v, id: "v1", order: 1 }], "v1", "v2").id, "v1");
  assert.equal(F.pickVersion([v, { ...v, id: "v1", order: 1 }], "nope", "v2").id, "v2");
  assert.equal(F.pickVersion([{ ...v, id: "v1", order: 1 }, v], null, "gone").id, "v2");
});

test("errors map to what the client is told", () => {
  assert.equal(F.classifyFirestoreError(403, { error: { status: "PERMISSION_DENIED" } }), "inactive");
  assert.equal(F.classifyFirestoreError(404, null), "inactive");
  assert.equal(F.classifyFirestoreError(400, { error: { message: "API key not valid" } }), "config");
  assert.equal(F.classifyFirestoreError(500, null), "server");
});

test("random ids are Firestore-safe", () => {
  const id = F.randomId(20);
  assert.match(id, /^[A-Za-z0-9]{20}$/);
  assert.notEqual(F.randomId(20), id);
});

/* ---------------- stream server ---------------- */

test("stream server URLs and bodies", () => {
  assert.equal(St.streamBase("https://stream.tritone-productions.com/"), "https://stream.tritone-productions.com");
  assert.equal(St.streamBase("http://localhost:8787"), "http://localhost:8787");
  assert.equal(St.streamBase("http://stream.example.com"), "", "plain http only for localhost");
  assert.equal(St.streamBase(""), "");
  assert.equal(St.streamBase(undefined), "");
  assert.equal(St.streamBase("javascript:alert(1)"), "");
  const base = "https://stream.tritone-productions.com";
  assert.equal(St.signUrl(base), `${base}/v1/sign`);
  assert.deepEqual(St.signMixBody("K", "v2", "aac"), { review: "K", version: "v2", kind: "aac" });
  assert.deepEqual(St.signVoiceBody("K", "u.m4a"), { review: "K", voiceId: "u.m4a", kind: "voice" });
  assert.equal(St.voiceUploadUrl(base, "K", "v 2"), `${base}/v1/voice?review=K&version=v%202`);
  assert.equal(St.trustedSignedUrl(base, `${base}/v1/m/abc.def`), `${base}/v1/m/abc.def`);
  assert.equal(St.trustedSignedUrl(base, "https://evil.example/v1/m/abc"), "");
  assert.equal(St.trustedSignedUrl(base, `${base}/elsewhere`), "");
  assert.equal(St.uploadType("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(St.uploadType("audio/mp4"), "audio/mp4");
  assert.equal(St.uploadType("audio/wav"), "");
});

test("recorder picks mp4 on Safari, webm elsewhere", () => {
  const all = () => true;
  assert.match(R.pickMime(all, true), /^audio\/mp4/);
  assert.match(R.pickMime(all, false), /^audio\/webm/);
  assert.equal(R.pickMime((t) => t === "audio/mp4", false), "audio/mp4");
  assert.equal(R.pickMime(() => false, false), "");
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  assert.equal(R.isIOS(iphone, 5), true);
  assert.equal(R.isSafari(iphone), true);
  assert.equal(R.isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 5), true, "iPadOS");
  assert.equal(R.isSafari("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"), false);
});

test("stored drafts are validated on load", () => {
  const good = draft();
  const parsed = D.parseDrafts(JSON.stringify([good, { id: "bad id!", t: 1 }, null, { id: "abcdefghij", t: "x" }, { ...good, id: "zzzzzzzzzz", from: 500, kind: "nope" }]));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].from, parsed[1].t);
  assert.equal(parsed[1].kind, "text");
  assert.deepEqual(D.parseDrafts("not json"), []);
  assert.deepEqual(D.parseDrafts(null), []);
  assert.equal(D.draftsKey("abc"), "tritone:review-drafts:abc");
});

test("review keys: 24 base62 from the publisher", () => {
  assert.ok(Sc.REVIEW_KEY_RE.test("aZ09aZ09aZ09aZ09aZ09aZ09"));
  for (const k of ["", "short", "has space in it 123456789", "../../etc/passwd/aaaaaaaa", "a".repeat(65)]) assert.ok(!Sc.REVIEW_KEY_RE.test(k), k);
  assert.ok(Sc.VERSION_ID_RE.test("v2"));
  assert.ok(!Sc.VERSION_ID_RE.test("V2/../x"));
});

/* ---------------- privacy ---------------- */

test("analytics never records /review (nor /admin)", () => {
  for (const p of ["/review", "/review?k=aZ09aZ09aZ09aZ09aZ09aZ09", "/review.html", "/admin"]) assert.equal(T.pathTracked(p), false, p);
  for (const p of ["/", "/shows", "/reviews-of-the-hut"]) assert.equal(T.pathTracked(p), true, p);
});

const DIST = join(ROOT, "dist");
const built = existsSync(join(DIST, "review.html"));

test("the built /review page is private and CSP-clean", { skip: !built && "dist/ not built" }, () => {
  const html = readFileSync(join(DIST, "review.html"), "utf8");
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  assert.match(html, /<meta name="referrer" content="no-referrer"/);
  assert.match(html, /tritone-wordmark-white[^"]*\.(png|webp)/, "real logo asset");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?![^>]*application\/(ld\+)?json)[^>]*>\s*\S/, "no inline executable script");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline handlers");
  const xml = readdirSync(DIST).filter((f) => /^sitemap-\d+\.xml$/.test(f)).map((f) => readFileSync(join(DIST, f), "utf8")).join("");
  assert.doesNotMatch(xml, /\/review</, "not in the sitemap");
  for (const t of ["llms.txt", "llms-full.txt"]) if (existsSync(join(DIST, t))) assert.doesNotMatch(readFileSync(join(DIST, t), "utf8"), /\/review\b/, `${t} omits /review`);
});
