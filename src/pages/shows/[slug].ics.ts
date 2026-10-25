// One .ics file per show: /shows/<slug>.ics (the "Apple / Outlook" add-to-calendar link).
import type { APIRoute } from "astro";
import { getShows, showsToIcs, type Show } from "../../lib/shows";

export async function getStaticPaths() {
  return (await getShows()).map((show) => ({ params: { slug: show.slug }, props: { show } }));
}

export const GET: APIRoute = ({ props }) => {
  const { show } = props as { show: Show };
  return new Response(showsToIcs([show], show.title), { headers: { "Content-Type": "text/calendar; charset=utf-8" } });
};
