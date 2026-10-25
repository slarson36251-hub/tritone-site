// All upcoming shows as one subscribable iCal feed: /shows.ics
import type { APIRoute } from "astro";
import { getUpcomingShows, showsToIcs } from "../lib/shows";

export const GET: APIRoute = async () =>
  new Response(showsToIcs(await getUpcomingShows(200)), {
    headers: { "Content-Type": "text/calendar; charset=utf-8" },
  });
