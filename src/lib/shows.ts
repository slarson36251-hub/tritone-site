// Upcoming shows, read at build time from the public "Music" Google Calendar.
//
// PRIVACY: only ever read the Music calendar. The Hummingbird Hut calendar's
// event locations contain the studio's street address and must never feed
// any page of this site.

export interface Show {
  id: string;
  title: string;
  start: Date;
  venue: string;
  poster?: string;
  url?: string;
}

const HUT_GUARD = /hummingbird/i;

export async function getUpcomingShows(limit = 3): Promise<Show[]> {
  const calendarId = import.meta.env.MUSIC_CALENDAR_ID;
  const key = import.meta.env.GOOGLE_CALENDAR_API_KEY;
  if (!calendarId || !key) return [];
  if (HUT_GUARD.test(calendarId)) throw new Error("Refusing to read the Hut calendar on a public page.");

  const params = new URLSearchParams({
    key,
    timeMin: new Date().toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(limit + 5),
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
  );
  if (!res.ok) {
    console.warn(`Shows: calendar request failed (${res.status}); building without dates.`);
    return [];
  }
  const data = await res.json();

  return (data.items ?? [])
    .filter((e: any) => !/^\[TEMPLATE\]/i.test(e.summary ?? ""))
    .slice(0, limit)
    .map((e: any): Show => {
      const desc: string = e.description ?? "";
      return {
        id: e.id,
        title: e.summary ?? "",
        start: new Date(e.start?.dateTime ?? e.start?.date),
        // Venue name only: the first line of the location, never a full street address.
        venue: (e.location ?? "").split(",")[0].trim(),
        poster: desc.match(/poster:\s*(https?:\/\/\S+)/i)?.[1],
        url: desc.match(/tickets:\s*(https?:\/\/\S+)/i)?.[1],
      };
    });
}
