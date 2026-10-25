// Date and time formatting for show listings, always in the Bay Area's time zone.
import { TZ, type Show } from "../../lib/shows";

const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...o });
const weekday = f({ weekday: "short" });
const month = f({ month: "short" });
const dayNum = f({ day: "numeric" });
const time = f({ hour: "numeric", minute: "2-digit" });
const longDate = f({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
const shortDate = f({ month: "short", day: "numeric", year: "numeric" });

export const dateParts = (d: Date) => ({
  day: weekday.format(d).toUpperCase(),
  mon: month.format(d).toUpperCase(),
  num: dayNum.format(d),
});

/** "8:00 – 11:00 PM", "11:30 AM – 1:00 PM", or "All day". */
export function timeRange(s: Show): string {
  if (s.allDay) return "All day";
  const a = time.format(s.start);
  const b = time.format(s.end);
  const [, aT, aM] = a.match(/^(.*)\s(AM|PM)$/) ?? [];
  const [, , bM] = b.match(/^(.*)\s(AM|PM)$/) ?? [];
  return aM && aM === bM ? `${aT} – ${b}` : `${a} – ${b}`;
}

export const startTime = (s: Show) => (s.allDay ? "All day" : time.format(s.start));
export const fullDate = (s: Show) => longDate.format(s.start);
export const pastDate = (s: Show) => shortDate.format(s.start);
export const isoDate = (d: Date) => d.toISOString();

export const place = (s: Show) => (s.city && s.city !== s.venue ? `${s.venue} · ${s.city}` : s.venue);
