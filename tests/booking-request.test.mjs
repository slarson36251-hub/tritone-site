// "Request an earlier time" on /book-the-hut: the form check and the POST body the booking web app's
// request path expects (type "request"; any day and time; never put on the calendar).
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildTimeRequest } = await import("../src/lib/booking-request-core.ts");
const now = new Date(2026, 9, 25, 12, 0);
const good = { name: " Ray Skjelbred ", email: "ray@example.com", date: "2026-10-27", time: "09:30", hours: "3", note: " Trio " };

test("a good request becomes a type:request body with trimmed fields", () => {
  const r = buildTimeRequest(good, now);
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, { type: "request", name: "Ray Skjelbred", email: "ray@example.com", phone: "",
    date: "2026-10-27", time: "09:30", hours: 3, note: "Trio", company: "" });
});

test("any start time is allowed, mornings included", () => {
  for (const time of ["06:00", "09:15", "13:00", "23:30"]) assert.equal(buildTimeRequest({ ...good, time }, now).ok, true, time);
});

test("bad input is caught per field", () => {
  const cases = [
    [{ name: "  " }, "name"], [{ email: "nope" }, "email"], [{ date: "" }, "date"],
    [{ date: "2026-10-25" }, "date"], [{ time: "9am" }, "time"], [{ hours: "0" }, "hours"],
    [{ hours: "13" }, "hours"], [{ hours: "2.5" }, "hours"], [{ note: "x".repeat(2001) }, "note"],
  ];
  for (const [patch, field] of cases) {
    const r = buildTimeRequest({ ...good, ...patch }, now);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.errors[field], `${field} for ${JSON.stringify(patch)}`);
  }
});

test("the honeypot is passed through for the server to swallow", () => {
  assert.equal(buildTimeRequest({ ...good, company: "spam" }, now).payload.company, "spam");
});
