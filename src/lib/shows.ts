// Shows, read at build time from the public "Music" Google Calendar.
//
// PRIVACY: only ever read the Music calendar. The Hummingbird Hut calendar's
// event locations contain the studio's street address and must never feed
// any page of this site. Every show published here carries a public venue
// name and a city, never a street address.
//
// Sources, first match wins:
//   1. SHOWS_FIXTURE=<path to .ics>       (tests, offline builds)
//   2. GOOGLE_CALENDAR_API_KEY + MUSIC_CALENDAR_ID   (Calendar API v3)
//   3. MUSIC_CALENDAR_ID only             (the calendar's public iCal feed)
// Any failure logs a warning and yields no shows, so a build never breaks.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findVenue, instagramUrl, VENUES, type Venue } from "../data/venues";

export interface LineupMember {
  name: string;
  role?: string;
}

export interface Show {
  id: string;
  /** "Band at Venue", for listings and calendar entries. */
  title: string;
  band: string;
  /** Public venue name, or the city when no venue name is known. Never a street address. */
  venue: string;
  city?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  lineup: LineupMember[];
  genre?: string;
  presenter?: string;
  notes?: string;
  tickets?: string;
  poster?: string;
  /** The venue's own listing for this show ("venue page:" line). */
  venuePage?: string;
  /** "price:" line, as written ("$15", "Free", "$10–20"). */
  price?: string;
  cancelled: boolean;
  /** Original start when the event was moved ("rescheduled:" line or title prefix). */
  rescheduled: boolean;
  previousStart?: Date;
  /** Public venue record (street address, website) when the venue is in src/data/venues.ts. */
  place?: Venue;
  /** URL slug: band-venue-city-yyyy-mm-dd. */
  slug: string;
  /** Last time the calendar entry changed. */
  updated?: Date;
}

export const TZ = "America/Los_Angeles";
const HUT_GUARD = /hummingbird/i;
const DEFAULT_ID = "226gr9pmhmg1mcrfmm1fre0nf4@group.calendar.google.com";

// Calendar entries that are not public shows.
const SKIP_TITLE = /^\s*\[template\]|\b(rehearsal|practice|private|wedding|corporate|holiday party|hold|tentative)\b/i;
const SKIP_DESC = /^\s*(private|public:\s*no)\s*$/im;
const PUBLIC_YES = /^\s*public:\s*(yes|y|true)\s*$/im;

/**
 * OPT-IN publishing. The Music calendar also holds personal entries (errands,
 * appointments, house addresses), so an event is public only when:
 *   - its location names a public venue in src/data/venues.ts (by name, alias or street address), or
 *   - its description has a "venue:" line naming such a venue, or
 *   - its description has a "public: yes" line.
 * Everything else is dropped before it can reach a page, a feed or JSON-LD.
 * The template and rehearsals are dropped even at a listed venue.
 */
export function isPublic(e: { summary: string; description: string; location: string }): boolean {
  if (SKIP_TITLE.test(e.summary) || SKIP_DESC.test(e.description)) return false;
  if (PUBLIC_YES.test(e.description)) return true;
  const venueLine = e.description.match(/^\s*venue\s*:\s*(.+)$/im)?.[1]?.trim();
  if (findVenue(venueLine)) return true;
  const loc = e.location.trim();
  if (!loc) return false;
  if (findVenue(loc.split(/\s*,\s*|\n/)[0])) return true;
  return !!venueByAddress(loc);
}

/** The listed venue whose street address and ZIP both appear in a location string. */
function venueByAddress(location: string): Venue | undefined {
  const flat = location.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ");
  return VENUES.find((v) => v.street && v.postalCode && flat.includes(v.street.toLowerCase().replace(/[.,]/g, " ")) && flat.includes(v.postalCode));
}

const env = (k: string): string | undefined =>
  (typeof process !== "undefined" ? process.env[k] : undefined) || (import.meta as any).env?.[k] || undefined;

// ---------------------------------------------------------------- loading

/** Raw event in a source-neutral shape, after recurrence expansion. */
interface RawEvent {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  allDay: boolean;
  cancelled: boolean;
  updated?: Date;
  recurring?: boolean;
}

const WINDOW_BACK_DAYS = 550; // past shows (pages older than a year are noindex)
const WINDOW_AHEAD_DAYS = 365; // one-off shows
export const RECURRING_AHEAD_DAYS = 90; // repeating series (monthly residencies) stop here

let cache: Promise<Show[]> | undefined;

/** Every public show in the build window, sorted by start time. */
export function getShows(): Promise<Show[]> {
  cache ??= load().catch((err) => {
    console.warn(`Shows: could not load the Music calendar (${err?.message ?? err}); building without dates.`);
    return [];
  });
  return cache;
}

export async function getUpcomingShows(limit = 3): Promise<Show[]> {
  const now = Date.now();
  return (await getShows()).filter((s) => s.end.getTime() > now).slice(0, limit);
}

export async function getPastShows(limit = 20): Promise<Show[]> {
  const now = Date.now();
  return (await getShows())
    .filter((s) => s.end.getTime() <= now && !s.cancelled)
    .reverse()
    .slice(0, limit);
}

async function load(): Promise<Show[]> {
  const now = Date.now();
  const from = new Date(now - WINDOW_BACK_DAYS * 864e5);
  const to = new Date(now + WINDOW_AHEAD_DAYS * 864e5);

  let raw: RawEvent[];
  const fixture = env("SHOWS_FIXTURE");
  if (fixture) {
    raw = parseIcs(await readFile(fixture, "utf8"), from, to);
  } else {
    const calendarId = env("MUSIC_CALENDAR_ID") ?? DEFAULT_ID;
    if (HUT_GUARD.test(calendarId)) throw new Error("Refusing to read the Hut calendar on a public page.");
    // Preferred: a service account the (private) Music calendar is shared with, read-only.
    // Fallbacks: an API key (public calendar only), then the public iCal feed.
    const sa = env("GOOGLE_SERVICE_ACCOUNT_JSON");
    const key = env("GOOGLE_CALENDAR_API_KEY");
    raw = sa
      ? await fromApi(calendarId, { token: await serviceAccountToken(sa) }, from, to)
      : key
        ? await fromApi(calendarId, { key }, from, to)
        : await fromIcsFeed(calendarId, from, to);
  }

  const seen = new Set<string>();
  const shows = raw
    .filter((e) => !(e.recurring && e.start.getTime() > now + RECURRING_AHEAD_DAYS * 864e5))
    .filter(isPublic)
    .map(toShow)
    .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return assignSlugs(shows);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}

// Signs a JWT for the service account and swaps it for a read-only Calendar access token.
async function serviceAccountToken(json: string): Promise<string> {
  const { createSign } = await import("node:crypto");
  const sa = JSON.parse(json);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Service account token request answered ${res.status}`);
  return (await res.json()).access_token;
}

async function fromApi(calendarId: string, auth: { key?: string; token?: string }, from: Date, to: Date): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      ...(auth.key ? { key: auth.key } : {}),
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "2500",
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      auth.token ? { headers: { authorization: `Bearer ${auth.token}` } } : undefined,
    );
    if (!res.ok) throw new Error(`Calendar API answered ${res.status}`);
    const data: any = await res.json();
    for (const e of data.items ?? []) {
      const allDay = !e.start?.dateTime;
      const start = allDay ? dateOnly(e.start?.date) : new Date(e.start?.dateTime);
      const end = allDay ? dateOnly(e.end?.date ?? e.start?.date) : new Date(e.end?.dateTime ?? e.start?.dateTime);
      if (isNaN(start.getTime())) continue;
      out.push({
        id: e.id,
        summary: e.summary ?? "",
        description: htmlToText(e.description ?? ""),
        location: e.location ?? "",
        start,
        end: end.getTime() > start.getTime() ? end : new Date(start.getTime() + (allDay ? 864e5 : 2 * 36e5)),
        allDay,
        cancelled: e.status === "cancelled",
        updated: e.updated ? new Date(e.updated) : undefined,
        recurring: !!e.recurringEventId,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function fromIcsFeed(calendarId: string, from: Date, to: Date): Promise<RawEvent[]> {
  const res = await fetchWithTimeout(
    `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`,
  );
  if (!res.ok) throw new Error(`public iCal feed answered ${res.status} (is the Music calendar public?)`);
  return parseIcs(await res.text(), from, to);
}

// Google's event editor stores rich text as light HTML.
function htmlToText(s: string): string {
  if (!/<[a-z][^>]*>/i.test(s)) return s;
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href, text) => (text.includes("http") ? text : href))
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ---------------------------------------------------------------- iCal parsing

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Unfold, then split into VEVENT property lists. */
function icsEvents(text: string): Prop[][] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events: Prop[][] = [];
  let cur: Prop[] | null = null;
  let depth = 0; // nested components inside a VEVENT (VALARM)
  for (const line of lines) {
    if (!line) continue;
    if (line === "BEGIN:VEVENT") { cur = []; depth = 0; continue; }
    if (!cur) continue;
    if (line === "END:VEVENT") { events.push(cur); cur = null; continue; }
    if (line.startsWith("BEGIN:")) { depth++; continue; }
    if (line.startsWith("END:")) { depth--; continue; }
    if (depth > 0) continue;
    const prop = parseLine(line);
    if (prop) cur.push(prop);
  }
  return events;
}

function parseLine(line: string): Prop | null {
  // Name and params end at the first colon not inside a quoted param value.
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) { colon = i; break; }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeText = (v: string) =>
  v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

interface IcsTime {
  /** Wall-clock parts in `tz` (or UTC). */
  y: number; m: number; d: number; h: number; mi: number; s: number;
  tz: string;
  allDay: boolean;
}

function parseIcsTime(p: Prop, fallbackTz: string): IcsTime | null {
  const v = p.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const allDay = p.params.VALUE === "DATE" || !m[4];
  return {
    y: +m[1], m: +m[2], d: +m[3],
    h: allDay ? 0 : +m[4], mi: allDay ? 0 : +m[5], s: allDay ? 0 : +m[6],
    tz: m[7] ? "UTC" : validTz(p.params.TZID) ?? fallbackTz,
    allDay,
  };
}

function validTz(tz?: string): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** Offset of `tz` from UTC at instant `ms`, in ms. */
function tzOffset(ms: number, tz: string): number {
  if (tz === "UTC") return 0;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in `tz` to a UTC instant (DST-correct for real times). */
function wallToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  let ms = guess - tzOffset(guess, tz);
  ms = guess - tzOffset(ms, tz);
  return new Date(ms);
}

/** All-day dates are pinned to local midnight in the site's time zone. */
const dateOnly = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return wallToUtc(y, m, d, 0, 0, 0, TZ);
};

const toInstant = (t: IcsTime) =>
  t.allDay ? wallToUtc(t.y, t.m, t.d, 0, 0, 0, TZ) : wallToUtc(t.y, t.m, t.d, t.h, t.mi, t.s, t.tz);

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Expand an RRULE into local calendar dates (y, m, d), starting at dtstart. */
function* expandRule(rule: Record<string, string>, t: IcsTime, until: Date): Generator<[number, number, number]> {
  const freq = rule.FREQ;
  const interval = Math.max(1, +(rule.INTERVAL ?? 1));
  const count = rule.COUNT ? +rule.COUNT : Infinity;
  const ruleUntil = rule.UNTIL ? parseIcsTime({ name: "UNTIL", params: {}, value: rule.UNTIL }, t.tz) : null;
  const untilMs = Math.min(until.getTime(), ruleUntil ? toInstant(ruleUntil).getTime() + (ruleUntil.allDay ? 864e5 - 1 : 0) : Infinity);
  const byday = (rule.BYDAY ?? "").split(",").filter(Boolean).map((x) => {
    const mm = x.match(/^([+-]?\d+)?([A-Z]{2})$/);
    return mm ? { n: mm[1] ? +mm[1] : 0, dow: DOW.indexOf(mm[2]) } : null;
  }).filter((x): x is { n: number; dow: number } => !!x && x.dow >= 0);
  const bymonthday = (rule.BYMONTHDAY ?? "").split(",").filter(Boolean).map(Number);

  const startDay = Date.UTC(t.y, t.m - 1, t.d);
  let emitted = 0;
  const emit = function* (ms: number): Generator<[number, number, number]> {
    if (ms < startDay) return;
    const dt = new Date(ms);
    const parts: [number, number, number] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    const inst = t.allDay ? wallToUtc(...parts, 0, 0, 0, TZ) : wallToUtc(...parts, t.h, t.mi, t.s, t.tz);
    if (inst.getTime() > untilMs) { emitted = Infinity; return; }
    emitted++;
    yield parts;
  };

  for (let i = 0; i < 2000 && emitted < count; i++) {
    let days: number[] = [];
    if (freq === "DAILY") {
      days = [startDay + i * interval * 864e5];
    } else if (freq === "WEEKLY") {
      const startDow = new Date(startDay).getUTCDay();
      const weekStart = startDay - ((startDow + 6) % 7) * 864e5 + i * interval * 7 * 864e5; // Monday
      const dows = byday.length ? byday.map((b) => b.dow) : [startDow];
      days = dows.map((dw) => weekStart + ((dw + 6) % 7) * 864e5).sort((a, b) => a - b);
    } else if (freq === "MONTHLY" || freq === "YEARLY") {
      const monthsAhead = freq === "MONTHLY" ? i * interval : i * interval * 12;
      const y = t.y + Math.floor((t.m - 1 + monthsAhead) / 12);
      const m = ((t.m - 1 + monthsAhead) % 12) + 1;
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      if (byday.length) {
        for (const b of byday) {
          const all: number[] = [];
          for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === b.dow) all.push(d);
          const picks = b.n === 0 ? all : [b.n > 0 ? all[b.n - 1] : all[all.length + b.n]];
          for (const d of picks) if (d) days.push(Date.UTC(y, m - 1, d));
        }
      } else {
        for (const md of bymonthday.length ? bymonthday : [t.d]) {
          const d = md < 0 ? dim + md + 1 : md;
          if (d >= 1 && d <= dim) days.push(Date.UTC(y, m - 1, d));
        }
      }
      days.sort((a, b) => a - b);
    } else {
      yield [t.y, t.m, t.d];
      return;
    }
    for (const ms of days) {
      if (emitted >= count) return;
      yield* emit(ms);
    }
  }
}

/** Parse an iCal feed into concrete events in [from, to], expanding RRULEs. */
export function parseIcs(text: string, from: Date, to: Date): RawEvent[] {
  const calTz = validTz(text.match(/^X-WR-TIMEZONE:(.+)$/m)?.[1]?.trim()) ?? TZ;
  const masters: Prop[][] = [];
  const overrides = new Map<string, Prop[]>(); // uid|instantMs -> event
  for (const ev of icsEvents(text)) {
    const rid = ev.find((p) => p.name === "RECURRENCE-ID");
    const uid = ev.find((p) => p.name === "UID")?.value ?? "";
    if (rid) {
      const t = parseIcsTime(rid, calTz);
      if (t) overrides.set(`${uid}|${toInstant(t).getTime()}`, ev);
    } else masters.push(ev);
  }

  const out: RawEvent[] = [];
  const build = (ev: Prop[], id: string, start: Date, allDay: boolean, durMs: number): RawEvent => {
    const get = (n: string) => ev.find((p) => p.name === n)?.value ?? "";
    return {
      id,
      summary: unescapeText(get("SUMMARY")),
      description: htmlToText(unescapeText(get("DESCRIPTION"))),
      location: unescapeText(get("LOCATION")),
      start,
      end: new Date(start.getTime() + durMs),
      allDay,
      cancelled: /^cancelled$/i.test(get("STATUS")),
      updated: (() => {
        const lm = ev.find((p) => p.name === "LAST-MODIFIED");
        const t = lm && parseIcsTime(lm, "UTC");
        return t ? toInstant(t) : undefined;
      })(),
    };
  };
  const inWindow = (e: RawEvent) => e.end.getTime() >= from.getTime() && e.start.getTime() <= to.getTime();

  const timesOf = (ev: Prop[]) => {
    const ds = ev.find((p) => p.name === "DTSTART");
    const t = ds && parseIcsTime(ds, calTz);
    if (!t) return null;
    const start = toInstant(t);
    const de = ev.find((p) => p.name === "DTEND");
    const te = de && parseIcsTime(de, calTz);
    let dur = te ? toInstant(te).getTime() - start.getTime() : NaN;
    if (!(dur > 0)) {
      const dm = ev.find((p) => p.name === "DURATION")?.value.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
      dur = dm ? ((+(dm[1] ?? 0) * 7 + +(dm[2] ?? 0)) * 24 + +(dm[3] ?? 0)) * 36e5 + +(dm[4] ?? 0) * 6e4 : 0;
    }
    if (!(dur > 0)) dur = t.allDay ? 864e5 : 2 * 36e5;
    return { t, start, dur };
  };

  for (const ev of masters) {
    const uid = ev.find((p) => p.name === "UID")?.value ?? "";
    const base = uid.replace(/@google\.com$/, "").replace(/[^A-Za-z0-9_-]/g, "") || `ev${out.length}`;
    const tm = timesOf(ev);
    if (!tm) continue;
    const rrule = ev.find((p) => p.name === "RRULE");
    if (!rrule) {
      const e = build(ev, base, tm.start, tm.t.allDay, tm.dur);
      if (inWindow(e)) out.push(e);
      continue;
    }
    const rule = Object.fromEntries(rrule.value.split(";").map((kv) => kv.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
    const exdates = new Set<number>();
    for (const p of ev.filter((p) => p.name === "EXDATE")) {
      for (const v of p.value.split(",")) {
        const t = parseIcsTime({ ...p, value: v }, calTz);
        if (t) exdates.add(toInstant(t).getTime());
      }
    }
    const recurTo = new Date(Math.min(to.getTime(), Date.now() + RECURRING_AHEAD_DAYS * 864e5));
    for (const [y, m, d] of expandRule(rule, tm.t, recurTo)) {
      const inst = tm.t.allDay ? wallToUtc(y, m, d, 0, 0, 0, TZ) : wallToUtc(y, m, d, tm.t.h, tm.t.mi, tm.t.s, tm.t.tz);
      const ms = inst.getTime();
      if (exdates.has(ms)) continue;
      const id = `${base}_${tm.t.allDay ? stamp(inst).slice(0, 8) : stamp(inst)}`;
      const ov = overrides.get(`${uid}|${ms}`);
      overrides.delete(`${uid}|${ms}`);
      let e: RawEvent;
      if (ov) {
        const ot = timesOf(ov);
        if (!ot) continue;
        e = build(ov, id, ot.start, ot.t.allDay, ot.dur);
      } else e = build(ev, id, inst, tm.t.allDay, tm.dur);
      e.recurring = true;
      if (inWindow(e) && e.start.getTime() <= recurTo.getTime()) out.push(e);
    }
  }
  // Overrides whose original slot fell outside the expansion (moved instances, detached exceptions).
  for (const [key, ev] of overrides) {
    const [uid, ms] = key.split("|");
    const tm = timesOf(ev);
    if (!tm) continue;
    const base = uid.replace(/@google\.com$/, "").replace(/[^A-Za-z0-9_-]/g, "");
    const e = build(ev, `${base}_${stamp(new Date(+ms))}`, tm.start, tm.t.allDay, tm.dur);
    if (inWindow(e)) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------- shaping


const STREET = /\b(st|street|ave|avenue|blvd|boulevard|rd|road|way|dr|drive|ln|lane|ct|court|pl|place|hwy|highway|pkwy|parkway|ter|terrace|cir|circle|sq|square|suite|ste|apt|unit)\b\.?/i;
const STATE = /^(ca|california)(\s+\d{5}(-\d{4})?)?$/i;

const STREET_ADDR = new RegExp(String.raw`\b\d{1,6}[a-z]?\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.'’ -]{1,40}?\s+` + STREET.source, "i");

/** True when free text contains something shaped like a street address or ZIP. */
export function containsAddress(s: string): boolean {
  return STREET_ADDR.test(s) || /\b9\d{4}\b/.test(s);
}

/** True when a location segment could be (part of) a street address. */
export function looksLikeAddress(s: string): boolean {
  return /\d/.test(s) && (/^\s*#?\d+[a-z]?\b/i.test(s) || STREET.test(s) || containsAddress(s));
}

/**
 * Venue name and city from the title ("Band @ Venue") and the location. A street
 * address is never returned: when no venue name is recognizable, venue is the city.
 */
export function placeOf(title: string, location: string): { venue: string; city?: string } {
  if (HUT_GUARD.test(location) || HUT_GUARD.test(title)) return { venue: "Hummingbird Hut", city: "Oakland" };
  const segs = location.split(/\s*,\s*|\s*\n\s*/).map((s) => s.trim()).filter(Boolean);

  let city: string | undefined;
  const stateIdx = segs.findIndex((s, i) => i > 0 && STATE.test(s));
  if (stateIdx > 0 && !looksLikeAddress(segs[stateIdx - 1])) city = segs[stateIdx - 1];
  else {
    const inline = segs.map((s) => s.match(/^([A-Za-z .'-]+?)\s+CA(\s+\d{5})?$/)).find(Boolean);
    if (inline && !looksLikeAddress(inline[1])) city = inline[1];
  }

  const fromTitle = title.match(/\s@\s*(.+)$/)?.[1]?.trim();
  const first = segs[0];
  const fromLocation = first && !looksLikeAddress(first) && first !== city && !STATE.test(first) ? first : undefined;
  let venue = [fromTitle, fromLocation].find((v) => v && !looksLikeAddress(v)) ?? "";
  if (venue && !city) city = findVenue(venue)?.city;
  if (!venue) venue = city ?? "Bay Area";
  return { venue, city };
}

const FIELD = /^\s*(genre|style|lineup|line-up|band|personnel|presented by|presenter|notes?|tickets?|poster|flyer|image|venue page|venue link|venue listing|venue|city|cover|price|rescheduled|moved from|public|private)\s*:\s*(.*)$/i;
const URL_RE = /^(https?:\/\/\S+|\/[^\s]*)$/;

/** True when a site-local path ("/x/y.jpg") is served by the build: a file in public/ or a route in src/pages. */
export function localFileExists(path: string): boolean {
  const clean = decodeURIComponent(path.split(/[?#]/)[0]).replace(/^\/+/, "");
  if (!clean || clean.split("/").includes("..")) return false;
  const root = process.cwd();
  if (existsSync(join(root, "public", clean))) return true;
  return [".ts", ".js", ".mjs"].some((ext) => existsSync(join(root, "src", "pages", clean + ext)));
}

/** Parse the free-form description: "key: value" fields plus bare "Name - instrument" lineup lines. */
export function parseDescription(desc: string) {
  const fields: Record<string, string> = {};
  const lineup: LineupMember[] = [];
  const extra: string[] = [];
  const addLineup = (s: string) => {
    for (const part of s.split(/\s*;\s*/).filter(Boolean)) {
      const m = part.match(/^(.+?)\s*[-–—:]\s*(.+)$/) ?? part.match(/^(.+?)\s*\((.+)\)$/);
      lineup.push(m ? { name: m[1].trim(), role: m[2].trim() } : { name: part.trim() });
    }
  };
  for (const raw of desc.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.match(FIELD);
    if (f) {
      const key = f[1].toLowerCase().replace(/^(style)$/, "genre").replace(/^(line-up|band|personnel)$/, "lineup")
        .replace(/^presenter$/, "presented by").replace(/^note$/, "notes").replace(/^ticket$/, "tickets")
        .replace(/^(flyer|image)$/, "poster");
      const val = f[2].trim();
      if (!val) continue;
      // "public: yes" / "private: …" only decide whether a show is listed; never show them.
      if (key === "public" || key === "private") continue;
      if (key === "lineup") addLineup(val);
      else if (/^venue (page|link|listing)$/.test(key)) fields["venue page"] = val;
      else if (key === "moved from") fields.rescheduled = val;
      else if (key === "cover") {
        fields.notes = [fields.notes, `${val} cover`].filter(Boolean).join(" · ");
        fields.price ??= val;
      }
      else fields[key] = fields[key] ? `${fields[key]} · ${val}` : val;
    } else if (/^[A-Z][\w.'’ -]{1,40}?\s*[-–—]\s*[a-z][\w /&.,-]{1,40}$/i.test(line) && !/https?:/.test(line)) {
      addLineup(line);
    } else extra.push(line);
  }
  const url = (v?: string) => (v && URL_RE.test(v.split(/\s+/)[0]) ? v.split(/\s+/)[0] : undefined);
  // A Google Drive share link is a viewer page, not an image: point at the file's image URL.
  const image = (v?: string) => {
    const u = url(v);
    const drive = u?.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/);
    if (drive) return `https://lh3.googleusercontent.com/d/${drive[1]}=w1100`;
    // A site-local poster that is not in public/ (or a page route) would be a broken image:
    // drop it so the typographic fallback renders instead.
    return u?.startsWith("/") && !localFileExists(u) ? undefined : u;
  };
  const notes = [fields.notes, ...extra].filter(Boolean).join(" · ") || undefined;
  return {
    lineup,
    genre: fields.genre,
    presenter: fields["presented by"],
    notes: notes?.split(" · ").filter((n) => !containsAddress(n)).join(" · ") || undefined,
    tickets: url(fields.tickets),
    poster: image(fields.poster),
    venue: fields.venue,
    venuePage: url(fields["venue page"]),
    price: fields.price,
    rescheduled: fields.rescheduled,
    city: fields.city,
  };
}

function toShow(e: RawEvent): Show {
  const d = parseDescription(e.description);
  const movedTitle = /^\s*(rescheduled|moved)\s*[:\-–—]?\s*/i;
  const band = e.summary.replace(/\s@\s*.+$/, "").replace(/^\s*cancel+ed\s*[:\-–—]?\s*/i, "").replace(movedTitle, "").replace(/\s+/g, " ").trim() || "Live music";
  let { venue, city } = placeOf(e.summary, e.location);
  if (d.venue && !looksLikeAddress(d.venue)) venue = d.venue;
  if (d.city && !looksLikeAddress(d.city)) city = d.city;
  if (city && venue === city && d.venue) venue = d.venue;
  // A listed public venue: use its own name and city (and, on show pages, its address).
  const place = (venue !== city ? findVenue(venue) : undefined) ?? venueByAddress(e.location);
  if (place) {
    venue = place.name;
    city = place.city;
  }
  const prev = d.rescheduled ? new Date(d.rescheduled) : undefined;
  return {
    id: e.id.replace(/[^A-Za-z0-9_-]/g, ""),
    title: venue && venue !== city ? `${band} at ${venue}` : band,
    band,
    venue,
    city,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    lineup: d.lineup,
    genre: d.genre,
    presenter: d.presenter,
    notes: d.notes,
    tickets: d.tickets,
    poster: d.poster,
    venuePage: d.venuePage,
    price: d.price,
    cancelled: e.cancelled || /^\s*cancel+ed\b/i.test(e.summary),
    rescheduled: !!d.rescheduled || movedTitle.test(e.summary),
    previousStart: prev && !isNaN(prev.getTime()) ? prev : undefined,
    place,
    slug: "",
    updated: e.updated,
  };
}

export const kebab = (s: string) =>
  s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['’]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** yyyy-mm-dd in the site's time zone. */
export const localDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Assign unique slugs: band-venue-city-yyyy-mm-dd (venue dropped when it is just the city). */
function assignSlugs(shows: Show[]): Show[] {
  const used = new Map<string, number>();
  for (const s of shows) {
    const parts = [s.band, s.venue !== s.city ? s.venue : "", s.city ?? "", localDate(s.start)];
    const base = kebab(parts.filter(Boolean).join(" "));
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    s.slug = n === 1 ? base : `${base}-${n}`;
  }
  return shows;
}

/** ISO 8601 with the Bay Area's UTC offset, e.g. 2026-11-13T20:00:00-08:00 (Google prefers this to Z). */
export function isoLocal(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  const off = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

// ---------------------------------------------------------------- calendar links

export const SITE = "https://tritone-productions.com";

export const showUrl = (s: Show) => `${SITE}/shows/${s.slug}`;

/**
 * Location for calendar apps: a listed public venue gets its street address
 * (from src/data/venues.ts only); anything else is "Venue, City, CA".
 */
export function publicLocation(s: Show): string {
  const p = s.place;
  if (p?.street && p.postalCode) return `${p.name}, ${p.street}, ${p.city}, ${p.region ?? "CA"} ${p.postalCode}`;
  if (!s.city) return s.venue;
  return s.venue === s.city ? `${s.city}, CA` : `${s.venue}, ${s.city}, CA`;
}

function calendarDetails(s: Show): string {
  return [
    s.lineup.length ? s.lineup.map((m) => (m.role ? `${m.name} (${m.role})` : m.name)).join(", ") : "",
    s.notes ?? "",
    s.tickets ? `Tickets: ${s.tickets}` : "",
    showUrl(s),
  ].filter(Boolean).join("\n");
}

const ymd = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replace(/-/g, "");

export function googleCalendarUrl(s: Show): string {
  const dates = s.allDay ? `${ymd(s.start)}/${ymd(new Date(s.end.getTime()))}` : `${stamp(s.start)}/${stamp(s.end)}`;
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: s.title,
    dates,
    ctz: TZ,
    details: calendarDetails(s),
    location: publicLocation(s),
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

const icsText = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Fold to 75 octets per RFC 5545, without splitting a UTF-8 sequence. */
function fold(line: string): string {
  const bytes = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = bytes.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; size = 0; }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function showsToIcs(shows: Show[], name = "Tritone Productions shows"): string {
  const now = stamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tritone Productions//Shows//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`,
    `X-WR-TIMEZONE:${TZ}`,
  ];
  for (const s of shows) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.id}@tritone-productions.com`,
      `DTSTAMP:${now}`,
      ...(s.allDay
        ? [`DTSTART;VALUE=DATE:${ymd(s.start)}`, `DTEND;VALUE=DATE:${ymd(s.end)}`]
        : [`DTSTART:${stamp(s.start)}`, `DTEND:${stamp(s.end)}`]),
      `SUMMARY:${icsText(s.title)}`,
      `LOCATION:${icsText(publicLocation(s))}`,
      `DESCRIPTION:${icsText(calendarDetails(s))}`,
      `URL:${showUrl(s)}`,
      `STATUS:${s.cancelled ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- show pages and schema

/** Tritone's own bands and their pages. */
export const TRITONE_BANDS: Record<string, string> = {
  "hard-bop-quintet": "Hard Bop Quintet",
  "franco-nero": "Franco Nero",
  "lucky-7": "Lucky 7",
  "scott-larson-quartet": "Scott Larson Quartet",
  "fault-line-trio": "Fault Line Trio",
};
export const bandSlug = (band: string) => kebab(band);
/** /bands/<slug> when the band is a Tritone band. */
export function bandPage(s: Show): string | undefined {
  const slug = bandSlug(s.band);
  return slug in TRITONE_BANDS ? `/bands/${slug}` : undefined;
}

export const ogImagePath = (s: Show) => `/og/shows/${s.slug}.png`;

/** Upcoming means it has not ended yet. */
export const isUpcoming = (s: Show, now = Date.now()) => s.end.getTime() > now;

/** "Free"/"no cover" -> 0, "$15" -> 15, "$10-20" -> 10. */
function priceValue(p?: string): number | undefined {
  if (!p) return undefined;
  if (/\b(free|no cover)\b/i.test(p)) return 0;
  const n = p.match(/\d+(?:\.\d{1,2})?/);
  return n ? Number(n[0]) : undefined;
}

/** One schema.org MusicEvent for a show page, shaped for Google's Event rich results. */
export function eventSchema(s: Show) {
  const p = s.place;
  const band = bandPage(s);
  const address = p?.street && p.postalCode
    ? {
        "@type": "PostalAddress",
        streetAddress: p.street,
        addressLocality: p.city,
        addressRegion: p.region ?? "CA",
        postalCode: p.postalCode,
        addressCountry: "US",
      }
    : {
        "@type": "PostalAddress",
        addressLocality: s.city ?? "San Francisco Bay Area",
        addressRegion: "CA",
        addressCountry: "US",
      };
  const offerUrl = s.tickets ?? s.venuePage;
  const price = priceValue(s.price);
  const lineup = s.lineup.map((m) => (m.role ? `${m.name} (${m.role})` : m.name)).join(", ");
  const description = [
    `${s.band} live at ${s.venue}${s.city && s.city !== s.venue ? `, ${s.city}` : ""}.`,
    s.genre ? `${s.genre}.` : "",
    lineup ? `With ${lineup}.` : "",
    s.notes ?? "",
  ].filter(Boolean).join(" ");

  return {
    "@context": "https://schema.org",
    "@type": "MusicEvent",
    name: s.title,
    description,
    url: showUrl(s),
    startDate: s.allDay ? localDate(s.start) : isoLocal(s.start),
    endDate: s.allDay ? localDate(new Date(s.end.getTime() - 1)) : isoLocal(s.end),
    eventStatus: s.cancelled
      ? "https://schema.org/EventCancelled"
      : s.rescheduled
        ? "https://schema.org/EventRescheduled"
        : "https://schema.org/EventScheduled",
    ...(s.rescheduled && s.previousStart ? { previousStartDate: isoLocal(s.previousStart) } : {}),
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: {
      "@type": "Place",
      name: s.venue,
      address,
      ...(p?.url ? { url: p.url } : {}),
      ...(p?.url || p?.instagram ? { sameAs: [p.url, p.instagram && instagramUrl(p.instagram)].filter(Boolean) } : {}),
    },
    image: [new URL(s.poster ?? ogImagePath(s), SITE).href],
    performer: {
      "@type": "MusicGroup",
      name: s.band,
      ...(band ? { url: new URL(band, SITE).href } : {}),
    },
    organizer: { "@type": "Organization", name: "Tritone Productions", url: SITE },
    ...(s.venuePage ? { sameAs: s.venuePage } : {}),
    ...(offerUrl && !s.cancelled
      ? {
          offers: {
            "@type": "Offer",
            url: offerUrl,
            availability: "https://schema.org/InStock",
            ...(price !== undefined ? { price: price.toFixed(2), priceCurrency: "USD" } : {}),
          },
        }
      : {}),
  };
}
