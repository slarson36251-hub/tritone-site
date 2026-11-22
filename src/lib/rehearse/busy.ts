// Build-time busy times for the rehearsal planner: Scott's Music calendar and the Hummingbird Hut
// calendar, read through Google's FreeBusy API with the same read-only service account as the Shows
// list. FreeBusy returns start and end times only: no titles, guests, notes or locations, so nothing
// about a client or the studio's address can reach the page. Each page bakes in only the blocks for
// its own dates. Without the service account (local builds, the fixture build) it returns no blocks
// and says which calendars were missing.
import { serviceAccountToken } from "../shows";
import { toBlocks, type Block } from "./core";

const TZ = "America/Los_Angeles";
const MUSIC_ID = "226gr9pmhmg1mcrfmm1fre0nf4@group.calendar.google.com";
// The Hut calendar's id (not its address). Read for free/busy times only, never event details.
const HUT_ID = "9b331c53dfa0611fb51e4388cb98a6198173473324b041e718afd7f7ecb335a4@group.calendar.google.com";

const env = (k: string): string | undefined =>
  (typeof process !== "undefined" ? process.env[k] : undefined) || (import.meta as any).env?.[k] || undefined;

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
export function pacificWall(d: Date): { date: string; min: number } {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

export interface Busy { blocks: Block[]; at: string; sources: { gigs: boolean; hut: boolean } }

let cache: Promise<{ music?: { start: string; end: string }[]; hut?: { start: string; end: string }[] }> | undefined;

async function freeBusy() {
  const sa = env("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!sa || env("SHOWS_FIXTURE")) return {};
  try {
    const token = await serviceAccountToken(sa);
    const now = Date.now();
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        timeMin: new Date(now - 864e5).toISOString(),
        timeMax: new Date(now + 120 * 864e5).toISOString(), // FreeBusy allows a window of a few months
        timeZone: TZ,
        items: [{ id: env("MUSIC_CALENDAR_ID") ?? MUSIC_ID }, { id: env("HUT_CALENDAR_ID") ?? HUT_ID }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FreeBusy answered ${res.status}`);
    const cals = (await res.json()).calendars ?? {};
    const pick = (id: string) => {
      const c = cals[id];
      if (!c || c.errors?.length) {
        console.warn(`[rehearse] no free/busy for ${id === HUT_ID ? "the Hut" : "the Music"} calendar: ${JSON.stringify(c?.errors ?? "missing")}`);
        return undefined;
      }
      return (c.busy ?? []) as { start: string; end: string }[];
    };
    return { music: pick(env("MUSIC_CALENDAR_ID") ?? MUSIC_ID), hut: pick(env("HUT_CALENDAR_ID") ?? HUT_ID) };
  } catch (e) {
    console.warn(`[rehearse] free/busy unavailable: ${(e as Error).message}`);
    return {};
  }
}

/** Blocks between from..to (inclusive dates) for one plan. */
export async function busyBetween(from: string, to: string): Promise<Busy> {
  cache ??= freeBusy();
  const fb = await cache;
  const inRange = (b: Block) => b.date >= from && b.date <= to;
  const blocks = [
    ...toBlocks(fb.music ?? [], "Scott busy", pacificWall).filter(inRange),
    ...toBlocks(fb.hut ?? [], "Hut booked", pacificWall).filter(inRange),
  ];
  return { blocks, at: new Date().toISOString(), sources: { gigs: !!fb.music, hut: !!fb.hut } };
}
