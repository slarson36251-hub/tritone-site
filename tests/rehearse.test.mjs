// Rehearsal planner logic (src/lib/rehearse/core.ts) and the built pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const C = await import("../src/lib/rehearse/core.ts");
const { REHEARSALS } = await import("../src/data/rehearsals.ts");

test("dates run inclusive across a month end", () => {
  const d = C.datesBetween("2026-11-29", "2026-12-02");
  assert.deepEqual(d, ["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
  assert.deepEqual(C.dayParts("2026-12-15"), { dow: "Tue", md: "Dec 15" });
});

test("a slot is blocked by any overlap, not by a touch", () => {
  const blocks = [{ date: "2026-12-04", start: "12:00", end: "15:00", label: "Hut booked" }];
  const slot = (start, end) => ({ id: "x", label: "x", start, end });
  assert.ok(C.blockFor(blocks, "2026-12-04", slot("11:00", "14:00")));
  assert.ok(C.blockFor(blocks, "2026-12-04", slot("14:00", "17:00")));
  assert.equal(C.blockFor(blocks, "2026-12-04", slot("15:00", "17:00")), undefined);
  assert.equal(C.blockFor(blocks, "2026-12-05", slot("11:00", "14:00")), undefined);
});

test("busy times split at midnight into per-day blocks", () => {
  const wall = (d) => ({ date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() });
  const b = C.toBlocks([{ start: "2026-11-25T19:00:00Z", end: "2026-11-26T01:30:00Z" }], "Scott busy", wall);
  assert.deepEqual(b, [
    { date: "2026-11-25", start: "19:00", end: "24:00", label: "Scott busy" },
    { date: "2026-11-26", start: "00:00", end: "01:30", label: "Scott busy" },
  ]);
});

test("ranking puts all-yes first and any no last", () => {
  const plan = {
    from: "2026-12-01", to: "2026-12-01",
    slots: [{ id: "a", label: "A", start: "11:00", end: "14:00" }, { id: "b", label: "B", start: "19:00", end: "22:00" }],
    blocks: [],
    roster: [{ name: "One Player" }, { name: "Two Player" }],
  };
  const all = {
    "one-player": { name: "One Player", note: "", answers: { "2026-12-01_a": "no", "2026-12-01_b": "yes" } },
    "two-player": { name: "Two Player", note: "", answers: { "2026-12-01_a": "yes", "2026-12-01_b": "yes" } },
  };
  const r = C.rank(plan, all);
  assert.equal(r[0].slot.id, "b");
  assert.deepEqual(r[1].st.no, ["One Player"]);
});

test("the save body keeps only well-formed answers and stamps the server time", () => {
  const b = C.saveBody("OlzPbIEA3a3xcmLiZ2YINfX8", "henry-hung", {
    name: "Henry Hung", note: "x", answers: { "2026-12-01_evening": "yes", junk: "yes", "2026-12-02_midday": "sure" },
  });
  const w = b.writes[0];
  assert.match(w.update.name, /rehearsals\/OlzPbIEA3a3xcmLiZ2YINfX8\/answers\/henry-hung$/);
  assert.deepEqual(Object.keys(w.update.fields.answers.mapValue.fields), ["2026-12-01_evening"]);
  assert.deepEqual(w.updateTransforms, [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]);
});

test("every plan is well formed", () => {
  const keys = new Set();
  for (const p of REHEARSALS) {
    assert.match(p.key, C.KEY_RE, `${p.band}: key is 24 letters/digits`);
    assert.ok(!keys.has(p.key), "keys are unique");
    keys.add(p.key);
    assert.ok(p.from <= p.to, `${p.band}: dates in order`);
    const slugs = p.roster.map((x) => C.slug(x.name));
    assert.equal(new Set(slugs).size, slugs.length, `${p.band}: player names are distinct`);
    for (const s of p.slots) assert.match(C.answerKey(p.from, s.id), C.ANSWER_KEY_RE);
  }
});

test("built planner pages are private and carry no studio details", { skip: !existsSync("dist/rehearse") }, () => {
  for (const f of readdirSync("dist/rehearse")) {
    const html = readFileSync(`dist/rehearse/${f}`, "utf8");
    assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
    assert.doesNotMatch(html, /9b331c53|226gr9pmhmg1/, "no calendar ids in the page");
  }
  const sitemap = existsSync("dist/sitemap-0.xml") ? readFileSync("dist/sitemap-0.xml", "utf8") : "";
  assert.doesNotMatch(sitemap, /rehearse/);
});
