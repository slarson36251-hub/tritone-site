// One .ics file per upcoming show: /shows/<id>.ics (the "Apple · Outlook" add-to-calendar link).
import type { APIRoute, GetStaticPaths } from "astro";
import { getUpcomingShows, showsToIcs, type Show } from "../../lib/shows";

export const getStaticPaths = (async () =>
  (await getUpcomingShows(200)).map((show) => ({ params: { id: show.id }, props: { show } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(showsToIcs([(props as { show: Show }).show], (props as { show: Show }).show.title), {
    headers: { "Content-Type": "text/calendar; charset=utf-8" },
  });
