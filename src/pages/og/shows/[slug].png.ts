// Share image per show (used when the event has no poster): /og/shows/<slug>.png
import type { APIRoute } from "astro";
import { getShows, type Show } from "../../../lib/shows";
import { renderOg } from "../../../lib/og";
import { dateParts, place, startTime } from "../../../components/shows/format";

export async function getStaticPaths() {
  return (await getShows()).map((show) => ({ params: { slug: show.slug }, props: { show } }));
}

export const GET: APIRoute = async ({ props }) => {
  const { show } = props as { show: Show };
  const { day, mon, num } = dateParts(show.start);
  const png = await renderOg({
    kicker: `${day} · ${mon} ${num} · ${startTime(show)}`,
    headline: show.band,
    sub: place(show),
    num,
    mon,
  });
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};
