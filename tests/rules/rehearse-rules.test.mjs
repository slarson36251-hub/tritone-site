// Firestore rules for the rehearsal planner (rehearsals/<key>/answers/<member>), run against the
// emulator over REST with the exact :commit body the page sends (src/lib/rehearse/core.ts).
//   npm run test:rules
import { test } from "node:test";
import assert from "node:assert/strict";

const C = await import("../../src/lib/rehearse/core.ts");

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!HOST) throw new Error("FIRESTORE_EMULATOR_HOST is not set: run this through `npm run test:rules`.");
const P = "demo-tritone-rules";
const ROOT = `projects/${P}/databases/(default)/documents`;
const BASE = `http://${HOST}/v1/${ROOT}`;
const KEY = "Rh3aRs4lKeY5xYz6AbC7dEf8";

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
/** The page's body, pointed at the emulator's project. */
function commit(key, member, data) {
  const b = C.saveBody(key, member, data);
  b.writes[0].update.name = b.writes[0].update.name.replace(C.DOC_PREFIX, ROOT);
  return call("POST", `${BASE}:commit`, b);
}
const raw = (fields, key = KEY, member = "raw-doc") =>
  call("POST", `${BASE}:commit`, {
    writes: [{ update: { name: `${ROOT}/rehearsals/${key}/answers/${member}`, fields }, updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }] }],
  });
const S = (v) => ({ stringValue: v });
const good = { name: "Henry Hung", note: "weeknights until 9", answers: { "2026-11-29_evening": "yes", "2026-11-30_midday": "no" } };

test("a player can save, then change, their answers", async () => {
  assert.equal((await commit(KEY, "henry-hung", good)).status, 200);
  assert.equal((await commit(KEY, "henry-hung", { ...good, answers: { "2026-11-29_evening": "maybe" } })).status, 200);
  const r = await call("GET", `${BASE}/rehearsals/${KEY}/answers/henry-hung`);
  assert.equal(r.status, 200);
  assert.equal(C.docToAnswers(r.json)[1].answers["2026-11-29_evening"], "maybe");
});

test("anyone with the link can list the band's answers", async () => {
  await commit(KEY, "safa-shokrai", { ...good, name: "Safa Shokrai" });
  const r = await call("GET", `${BASE}/rehearsals/${KEY}/answers`);
  assert.equal(r.status, 200);
  assert.ok((r.json.documents ?? []).length >= 2);
});

test("bad keys, bad member ids and the plan documents themselves are refused", async () => {
  assert.equal((await commit("short", "henry-hung", good)).status, 403);
  assert.equal((await commit(KEY, "Henry_Hung", good)).status, 403);
  assert.equal((await call("GET", `${BASE}/rehearsals/${KEY}`)).status, 403);
  assert.equal((await call("GET", `${BASE}/rehearsals`)).status, 403);
  assert.equal((await call("GET", `${BASE}/rehearsals/bad/answers`)).status, 403);
});

test("only the exact shape, stamped with the server time, is accepted", async () => {
  assert.equal((await raw({ name: S("X"), note: S(""), answers: { mapValue: { fields: {} } } })).status, 200);
  assert.equal((await raw({ name: S(""), note: S(""), answers: { mapValue: { fields: {} } } })).status, 403, "empty name");
  assert.equal((await raw({ name: S("X"), note: S("x".repeat(281)), answers: { mapValue: { fields: {} } } })).status, 403, "long note");
  assert.equal((await raw({ name: S("X"), note: S(""), answers: S("yes") })).status, 403, "answers not a map");
  assert.equal((await raw({ name: S("X"), note: S(""), answers: { mapValue: { fields: {} } }, extra: S("x") })).status, 403, "extra field");
  const noStamp = await call("POST", `${BASE}:commit`, {
    writes: [{ update: { name: `${ROOT}/rehearsals/${KEY}/answers/no-stamp`, fields: { name: S("X"), note: S(""), answers: { mapValue: { fields: {} } }, updatedAt: { timestampValue: "2020-01-01T00:00:00Z" } } } }],
  });
  assert.equal(noStamp.status, 403, "client-made timestamp");
});

test("nobody can delete answers", async () => {
  const r = await call("POST", `${BASE}:commit`, { writes: [{ delete: `${ROOT}/rehearsals/${KEY}/answers/henry-hung` }] });
  assert.equal(r.status, 403);
});
