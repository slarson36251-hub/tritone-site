// "Request an earlier time" on /book-the-hut: checks the little form and builds the POST body
// for the booking web app's request path (type "request": emailed to Scott, never put on the
// calendar). Pure, so tests/booking-request.test.mjs can run it under node.

export interface TimeRequestFields {
  name: string;
  email: string;
  phone?: string;
  date: string; // yyyy-mm-dd from <input type="date">
  time: string; // HH:mm from <input type="time">
  hours: string | number;
  note?: string;
  company?: string; // honeypot
}

export interface TimeRequestPayload {
  type: "request";
  name: string;
  email: string;
  phone: string;
  date: string;
  time: string;
  hours: number;
  note: string;
  company: string;
}

export type TimeRequestErrors = Partial<Record<"name" | "email" | "date" | "time" | "hours" | "note", string>>;

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Local yyyy-mm-dd for d (the visitor's own calendar day). */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function buildTimeRequest(
  f: TimeRequestFields,
  now: Date = new Date(),
): { ok: true; payload: TimeRequestPayload } | { ok: false; errors: TimeRequestErrors } {
  const errors: TimeRequestErrors = {};
  const name = f.name.trim();
  const email = f.email.trim();
  const note = (f.note ?? "").trim();
  const hours = Number(f.hours);

  if (!name) errors.name = "Your name, please.";
  else if (name.length > 120) errors.name = "That name is too long.";
  if (!EMAIL.test(email) || email.length > 200) errors.email = "That email doesn't look right.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) errors.date = "Pick a date.";
  else if (f.date <= isoDay(now)) errors.date = "Pick a date from tomorrow on.";
  if (!/^\d{2}:\d{2}$/.test(f.time)) errors.time = "Pick a start time.";
  if (!Number.isInteger(hours) || hours < 1 || hours > 12) errors.hours = "1 to 12 hours.";
  if (note.length > 2000) errors.note = "Keep the note under 2000 characters.";

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      type: "request",
      name,
      email,
      phone: (f.phone ?? "").trim().slice(0, 40),
      date: f.date,
      time: f.time,
      hours,
      note,
      company: f.company ?? "",
    },
  };
}
