// Firestore rules for the mix review (docs/mix-review-contract.md), run against the Firestore emulator
// over its REST API, i.e. the same requests the review page and /admin/mix-notes send (:commit with
// REQUEST_TIME transforms, GET / list, runQuery). No SDK needed.
//   npm run test:rules     (firebase-tools starts the emulator; needs Java 11+)
// Not part of `npm test` (no emulator there); CI runs it as its own step.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const M = await import("../../src/lib/admin/mixnotes.ts");
const { toFields, Double, stampedCreate, stampedUpdate, docName } = M;

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!HOST) throw new Error("FIRESTORE_EMULATOR_HOST is not set: run this through `npm run test:rules`.");
const P = "demo-tritone-rules";
const ROOT = `projects/${P}/databases/(default)/documents`;
const BASE = `http://${HOST}/v1/${ROOT}`;
const RULES = readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");

const KEY = "Ab3dEf6hIj9kLm2nOp5qRs8t"; // 24 base62
const CLOSED = "Zz9yXx8wVv7uTt6sRr5qPp4o";

// ---- who is asking: nobody (client), Scott, someone else, or the rules-bypassing "owner" (seeding)
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(uid, claims) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", kid: "fakekid", typ: "JWT" })}.${b64({
    iss: `https://securetoken.google.com/${P}`, aud: P, iat: now, exp: now + 3600, auth_time: now, sub: uid, user_id: uid,
    firebase: { sign_in_provider: "password", identities: {} }, ...claims,
  })}.`;
}
const CLIENT = null;
const ADMIN = idToken("scott", { email: "slarson36251@gmail.com", email_verified: true });
const ADMIN2 = idToken("scott2", { email: "scott@tritone-productions.com", email_verified: true });
const STRANGER = idToken("u1", { email: "someone@example.com", email_verified: true });
const UNVERIFIED = idToken("u2", { email: "slarson36251@gmail.com", email_verified: false });
const OWNER = "owner";

async function call(who, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const ok = (r, why = "") => assert.equal(r.status, 200, `${why} expected 200, got ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`);
const denied = (r, why = "") => assert.equal(r.status, 403, `${why} expected 403, got ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`);

const get = (who, ...path) => call(who, "GET", `${BASE}/${path.join("/")}`);
const list = (who, ...path) => call(who, "GET", `${BASE}/${path.join("/")}?pageSize=300`);
/** Every document of a collection, following nextPageToken (the emulator caps a page). */
async function listAll(who, ...path) {
  const docs = [];
  let token = "";
  do {
    const r = await call(who, "GET", `${BASE}/${path.join("/")}?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    ok(r, "listing");
    docs.push(...(r.json.documents ?? []));
    token = r.json.nextPageToken ?? "";
  } while (token);
  return docs;
}
const commit = (who, writes) => call(who, "POST", `${BASE}:commit`, { writes });
const name = (...path) => docName(ROOT, ...path);
const create = (who, path, fields) => commit(who, [stampedCreate(name(...path), fields)]);
const patch = (who, path, fields) => commit(who, [stampedUpdate(name(...path), fields)]);
const del = (who, ...path) => commit(who, [{ delete: name(...path) }]);
/** An update that does NOT stamp updatedAt (or sets fields exactly as given). */
const rawUpdate = (who, path, fields) => commit(who, [{ update: { name: name(...path), fields: toFields(fields) }, updateMask: { fieldPaths: Object.keys(fields) }, currentDocument: { exists: true } }]);
/** A create with a client-chosen createdAt instead of the server time. */
const rawCreate = (who, path, fields) => commit(who, [{ update: { name: name(...path), fields: toFields(fields) }, currentDocument: { exists: false } }]);

const T0 = new Date("2026-10-20T18:00:00Z");
const review = (status) => ({ title: "Translucent", artist: "Fault Line Trio", clients: ["Jay"], status, latestVersion: "v2", createdAt: T0, updatedAt: T0 });
const version = (n) => ({
  label: `v${n}`, order: n, createdAt: T0, bounceName: `Translucent v${n}.wav`, durationSec: 312.48, sampleRate: 48000, bpm: 160,
  beatsPerBar: 4, offsetSec: 0, markers: [{ name: "Intro", t: new Double(0) }, { name: "Head A", t: 18.2 }], peaks: [0, 12, 255],
  media: { wav: "Projects/x.wav", aac: "Projects/_review/x.m4a" },
});
// Client-created note / submission (createdAt is stamped by the server via the REQUEST_TIME transform).
const textNote = (o = {}) => ({
  versionId: "v2", t: 42.5, from: 37.5, section: "Head A", bar: 29, beat: 2, kind: "text", text: "Bass up here",
  voiceId: "", voiceSec: 0, author: "Jay", status: "open", submissionId: "s1", ...o,
});
const voiceNote = (o = {}) => textNote({ kind: "voice", text: "", voiceId: "0f8fad5b-d9cb-469f-a165-70867728950e.webm", voiceSec: 7.2, ...o });
const submission = (o = {}) => ({ author: "Jay", versionId: "v2", noteCount: 2, status: "new", ...o });

before(async () => {
  const r = await call(OWNER, "PUT", `http://${HOST}/emulator/v1/projects/${P}:securityRules`, { rules: { files: [{ name: "firestore.rules", content: RULES }] } });
  assert.equal(r.status, 200, `loading rules: ${JSON.stringify(r.json)}`);
});

beforeEach(async () => {
  const r = await call(OWNER, "DELETE", `http://${HOST}/emulator/v1/projects/${P}/databases/(default)/documents`);
  assert.equal(r.status, 200, "clearing the emulator");
  const w = (path, fields) => ({ update: { name: name(...path), fields: toFields(fields) } });
  const writes = [];
  for (const [k, st] of [[KEY, "open"], [CLOSED, "closed"]]) {
    writes.push(w(["reviews", k], review(st)), w(["reviews", k, "versions", "v1"], version(1)), w(["reviews", k, "versions", "v2"], version(2)));
    writes.push(w(["reviews", k, "submissions", "seed"], { ...submission({ noteCount: 1 }), createdAt: T0 }));
    writes.push(w(["reviews", k, "notes", "n0"], { ...textNote({ submissionId: "seed" }), createdAt: T0 }));
  }
  ok(await commit(OWNER, writes), "seeding");
});

// ---------------------------------------------------------------- client reads
test("client can get an open review but not a closed or missing one", async () => {
  ok(await get(CLIENT, "reviews", KEY));
  denied(await get(CLIENT, "reviews", CLOSED));
  denied(await get(CLIENT, "reviews", "Missing0Missing0Missing0"));
});

test("client can never list or query the reviews collection", async () => {
  denied(await list(CLIENT, "reviews"));
  denied(await call(CLIENT, "POST", `${BASE}:runQuery`, { structuredQuery: { from: [{ collectionId: "reviews" }], where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "open" } } } } }));
});

test("client can get / list versions, notes and submissions of an open review only", async () => {
  for (const sub of ["versions", "notes", "submissions"]) {
    ok(await list(CLIENT, "reviews", KEY, sub), `list ${sub} (open)`);
    denied(await list(CLIENT, "reviews", CLOSED, sub), `list ${sub} (closed)`);
    denied(await list(CLIENT, "reviews", "Missing0Missing0Missing0", sub), `list ${sub} (missing)`);
  }
  ok(await get(CLIENT, "reviews", KEY, "versions", "v2"));
  denied(await get(CLIENT, "reviews", CLOSED, "versions", "v2"));
  ok(await get(CLIENT, "reviews", KEY, "notes", "n0"));
  denied(await get(CLIENT, "reviews", CLOSED, "notes", "n0"));
});

// ---------------------------------------------------------------- client sends
test("one :commit (submission + text and voice notes) is allowed, stamped with the server time", async () => {
  ok(await commit(CLIENT, [
    stampedCreate(name("reviews", KEY, "submissions", "s1"), submission()),
    stampedCreate(name("reviews", KEY, "notes", "a1"), textNote()),
    stampedCreate(name("reviews", KEY, "notes", "a2"), voiceNote()),
  ]));
  const n = await get(CLIENT, "reviews", KEY, "notes", "a2");
  ok(n);
  assert.ok(n.json.fields.createdAt.timestampValue, "createdAt stamped");
  assert.equal(n.json.fields.kind.stringValue, "voice");
});

test("a whole-number time (t: 42 as an integer) is accepted too", async () => {
  ok(await commit(CLIENT, [stampedCreate(name("reviews", KEY, "submissions", "s1"), submission({ noteCount: 1 })), stampedCreate(name("reviews", KEY, "notes", "a1"), textNote({ t: 42, from: 37 }))]));
});

test("a full 200-note send fits in one :commit (rules access-call limits)", async () => {
  const writes = [stampedCreate(name("reviews", KEY, "submissions", "big"), submission({ noteCount: 200 }))];
  for (let i = 0; i < 200; i++) writes.push(stampedCreate(name("reviews", KEY, "notes", `b${i}`), (i % 2 ? voiceNote : textNote)({ submissionId: "big", t: i + 0.5, from: Math.max(0, i - 4.5) })));
  ok(await commit(CLIENT, writes));
  assert.equal((await listAll(OWNER, "reviews", KEY, "notes")).length, 201);
});

test("the whole :commit fails when one note is bad (all-or-nothing)", async () => {
  denied(await commit(CLIENT, [
    stampedCreate(name("reviews", KEY, "submissions", "s1"), submission()),
    stampedCreate(name("reviews", KEY, "notes", "a1"), textNote()),
    stampedCreate(name("reviews", KEY, "notes", "a2"), textNote({ status: "done" })),
  ]));
  assert.equal((await get(OWNER, "reviews", KEY, "submissions", "s1")).status, 404, "submission not written");
});

test("submission first, then notes as separate writes, also works", async () => {
  ok(await create(CLIENT, ["reviews", KEY, "submissions", "s1"], submission()));
  ok(await create(CLIENT, ["reviews", KEY, "notes", "a1"], textNote()));
});

test("a note needs an existing submission and an existing version", async () => {
  denied(await create(CLIENT, ["reviews", KEY, "notes", "a1"], textNote({ submissionId: "missing" })));
  denied(await create(CLIENT, ["reviews", KEY, "notes", "a1"], textNote({ submissionId: "seed", versionId: "v9" })));
  ok(await create(CLIENT, ["reviews", KEY, "notes", "a1"], textNote({ submissionId: "seed" })));
  // An existing note can't be overwritten: the exists:false precondition (409) or the rules (403) refuse it.
  const again = await create(CLIENT, ["reviews", KEY, "notes", "a1"], textNote({ submissionId: "seed", text: "changed" }));
  assert.ok([403, 409].includes(again.status), `overwrite refused, got ${again.status}`);
  assert.equal((await get(OWNER, "reviews", KEY, "notes", "a1")).json.fields.text.stringValue, "Bass up here");
});

test("note shapes the rules refuse", async () => {
  ok(await create(CLIENT, ["reviews", KEY, "submissions", "s1"], submission()));
  const { submissionId, ...noSub } = textNote();
  const bad = {
    "extra key": textNote({ email: "jay@example.com" }),
    "missing submissionId": noSub,
    "status done": textNote({ status: "done" }),
    "t too big": textNote({ t: 36001, from: 0 }),
    "t negative": textNote({ t: -1, from: 0 }),
    "from after t": textNote({ from: 50 }),
    "from negative": textNote({ from: -1 }),
    "bar 0": textNote({ bar: 0 }),
    "bar not int": textNote({ bar: 1.5 }),
    "beat 17": textNote({ beat: 17 }),
    "beat 0": textNote({ beat: 0 }),
    "section too long": textNote({ section: "x".repeat(81) }),
    "text too long": textNote({ text: "x".repeat(4001) }),
    "empty text note": textNote({ text: "" }),
    "text note with voiceId": textNote({ voiceId: "abc.webm" }),
    "text note with voiceSec": textNote({ voiceSec: 3 }),
    "voice note without voiceId": voiceNote({ voiceId: "" }),
    "voice path trick": voiceNote({ voiceId: "../../etc/passwd" }),
    "voice too long": voiceNote({ voiceSec: 601 }),
    "kind other": textNote({ kind: "video" }),
    "empty author": textNote({ author: "" }),
    "author too long": textNote({ author: "x".repeat(61) }),
    "bad versionId": textNote({ versionId: "V2/../x" }),
    "t as string": textNote({ t: "42" }),
    "reply on create": textNote({ reply: "hi" }),
  };
  for (const [why, data] of Object.entries(bad)) denied(await create(CLIENT, ["reviews", KEY, "notes", "bad"], data), why);
  denied(await rawCreate(CLIENT, ["reviews", KEY, "notes", "bad"], { ...textNote(), createdAt: new Date(Date.now() - 60e3) }), "client createdAt");
  denied(await rawCreate(CLIENT, ["reviews", KEY, "notes", "bad"], textNote()), "missing createdAt");
  denied(await create(CLIENT, ["reviews", KEY, "notes", "x".repeat(41)], textNote()), "note id too long");
});

test("submission shapes the rules refuse", async () => {
  const bad = {
    "extra key": submission({ email: "x" }),
    "noteCount 0": submission({ noteCount: 0 }),
    "noteCount 201": submission({ noteCount: 201 }),
    "noteCount not int": submission({ noteCount: 2.5 }),
    "status listening": submission({ status: "listening" }),
    "empty author": submission({ author: "" }),
    "author too long": submission({ author: "x".repeat(61) }),
    "missing version": submission({ versionId: "v9" }),
  };
  for (const [why, data] of Object.entries(bad)) denied(await create(CLIENT, ["reviews", KEY, "submissions", "bad"], data), why);
  denied(await rawCreate(CLIENT, ["reviews", KEY, "submissions", "bad"], { ...submission(), createdAt: new Date() }), "client createdAt");
  denied(await create(CLIENT, ["reviews", "Missing0Missing0Missing0", "submissions", "s1"], submission()), "missing review");
});

test("a closed review blocks every client read and write", async () => {
  denied(await create(CLIENT, ["reviews", CLOSED, "submissions", "s1"], submission()));
  denied(await create(CLIENT, ["reviews", CLOSED, "notes", "a1"], textNote({ submissionId: "seed" })));
  denied(await commit(CLIENT, [stampedCreate(name("reviews", CLOSED, "submissions", "s1"), submission()), stampedCreate(name("reviews", CLOSED, "notes", "a1"), textNote())]));
  denied(await get(CLIENT, "reviews", CLOSED, "submissions", "seed"));
});

test("clients never update or delete, and never write reviews or versions", async () => {
  denied(await rawUpdate(CLIENT, ["reviews", KEY, "notes", "n0"], { text: "changed" }));
  denied(await patch(CLIENT, ["reviews", KEY, "notes", "n0"], { status: "done" }));
  denied(await del(CLIENT, "reviews", KEY, "notes", "n0"));
  denied(await patch(CLIENT, ["reviews", KEY, "submissions", "seed"], { status: "done" }));
  denied(await del(CLIENT, "reviews", KEY, "submissions", "seed"));
  denied(await patch(CLIENT, ["reviews", KEY], { status: "closed" }));
  denied(await del(CLIENT, "reviews", KEY));
  denied(await commit(CLIENT, [{ update: { name: name("reviews", "NewKey0NewKey0NewKey0Ab"), fields: toFields(review("open")) } }]));
  denied(await commit(CLIENT, [{ update: { name: name("reviews", KEY, "versions", "v3"), fields: toFields(version(3)) } }]));
});

// ---------------------------------------------------------------- admin
test("admin reads everything, including the reviews list and closed reviews", async () => {
  for (const who of [ADMIN, ADMIN2]) {
    const r = await list(who, "reviews");
    ok(r);
    assert.equal(r.json.documents.length, 2);
    ok(await get(who, "reviews", CLOSED));
    for (const sub of ["versions", "notes", "submissions"]) ok(await list(who, "reviews", CLOSED, sub), sub);
  }
});

test("admin updates notes only in the admin fields (the queue's own writes)", async () => {
  const p = ["reviews", KEY, "notes", "n0"];
  ok(await commit(ADMIN, [M.noteStatusWrite(ROOT, KEY, "n0", "doing")]), "doing");
  ok(await commit(ADMIN, [M.noteReplyWrite(ROOT, KEY, "n0", "Done in v3")]), "reply");
  ok(await patch(ADMIN, p, { status: "done", transcript: "turn the bass up" }), "done + transcript");
  ok(await commit(ADMIN, [M.noteStatusWrite(ROOT, KEY, "n0", "open")]), "reopen");
  const n = await get(ADMIN, ...p);
  assert.equal(n.json.fields.reply.stringValue, "Done in v3");
  assert.equal(n.json.fields.text.stringValue, "Bass up here", "client text untouched");
  denied(await patch(ADMIN, p, { status: "archived" }));
  denied(await rawUpdate(ADMIN, p, { status: "done" }), "needs updatedAt = request.time");
  denied(await rawUpdate(ADMIN, p, { status: "done", updatedAt: new Date(Date.now() - 60e3) }), "client updatedAt");
  denied(await patch(ADMIN, p, { text: "rewritten" }));
  denied(await patch(ADMIN, p, { t: 1 }));
  denied(await patch(ADMIN, p, { author: "Scott" }));
  denied(await patch(ADMIN, p, { reply: "x".repeat(4001) }));
  denied(await patch(ADMIN, p, { transcript: "x".repeat(8001) }));
  denied(await patch(ADMIN, p, { reply: 5 }));
  denied(await del(ADMIN, ...p));
  denied(await create(ADMIN, ["reviews", KEY, "notes", "a9"], { ...textNote({ submissionId: "seed" }), reply: "x" }), "admin can't create odd notes either");
  ok(await commit(ADMIN, [M.noteStatusWrite(ROOT, CLOSED, "n0", "done")]), "closed review notes too");
});

test("admin moves submissions through new / listening / done", async () => {
  ok(await commit(ADMIN, [M.submissionStatusWrite(ROOT, KEY, "seed", "listening")]));
  ok(await commit(ADMIN, [M.submissionStatusWrite(ROOT, KEY, "seed", "done")]));
  ok(await commit(ADMIN, [M.submissionStatusWrite(ROOT, KEY, "seed", "new")]));
  denied(await patch(ADMIN, ["reviews", KEY, "submissions", "seed"], { status: "open" }));
  denied(await patch(ADMIN, ["reviews", KEY, "submissions", "seed"], { noteCount: 5 }));
  denied(await rawUpdate(ADMIN, ["reviews", KEY, "submissions", "seed"], { status: "done" }));
  denied(await del(ADMIN, "reviews", KEY, "submissions", "seed"));
});

test("admin closes / reopens a review and edits title and clients, nothing else", async () => {
  ok(await commit(ADMIN, [M.reviewStatusWrite(ROOT, KEY, "closed")]));
  denied(await get(CLIENT, "reviews", KEY), "closed for clients now");
  denied(await list(CLIENT, "reviews", KEY, "notes"));
  ok(await commit(ADMIN, [M.reviewStatusWrite(ROOT, KEY, "open")]));
  ok(await get(CLIENT, "reviews", KEY), "open again");
  ok(await patch(ADMIN, ["reviews", KEY], { title: "Translucent (alt)", clients: ["Jay", "Sam"] }));
  denied(await patch(ADMIN, ["reviews", KEY], { status: "archived" }));
  denied(await patch(ADMIN, ["reviews", KEY], { title: "" }));
  denied(await patch(ADMIN, ["reviews", KEY], { latestVersion: "v9" }));
  denied(await rawUpdate(ADMIN, ["reviews", KEY], { status: "closed" }), "needs updatedAt");
  denied(await commit(ADMIN, [{ update: { name: name("reviews", "NewKey0NewKey0NewKey0Ab"), fields: toFields(review("open")) } }]), "reviews are made by the publisher");
  denied(await del(ADMIN, "reviews", KEY));
  denied(await commit(ADMIN, [{ update: { name: name("reviews", KEY, "versions", "v3"), fields: toFields(version(3)) } }]), "versions are made by the publisher");
});

test("other signed-in users are not admin", async () => {
  for (const who of [STRANGER, UNVERIFIED]) {
    denied(await list(who, "reviews"));
    denied(await get(who, "reviews", CLOSED));
    denied(await commit(who, [M.noteStatusWrite(ROOT, KEY, "n0", "done")]));
    denied(await commit(who, [M.reviewStatusWrite(ROOT, KEY, "closed")]));
  }
});

// ---------------------------------------------------------------- existing rules still hold
test("existing collections keep their rules", async () => {
  ok(await commit(CLIENT, [{ update: { name: name("feedback", "f1"), fields: toFields({ page: "/", selector: "h1", snippet: "", note: "hi", viewport: "390x844", createdAt: new Date().toISOString(), ua: "test" }) } }]));
  denied(await get(CLIENT, "feedback", "f1"));
  denied(await list(CLIENT, "hits"));
  ok(await list(ADMIN, "hits"));
  denied(await list(CLIENT, "digests"));
  denied(await commit(CLIENT, [{ update: { name: name("digests", "2026-10-19"), fields: toFields({ md: "x" }) } }]));
  denied(await commit(CLIENT, [{ update: { name: name("anything", "x"), fields: toFields({ a: 1 }) } }]));
});
