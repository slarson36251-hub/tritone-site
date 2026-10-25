// Share image per site page (1200x630, same look as the show cards): /og/pages/home.png,
// /og/pages/hummingbird-hut.png, /og/pages/bands/<slug>.png ... Base.astro points og:image here.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { renderOg, type OgCard } from "../../../lib/og";
import { PAGE_CARDS, bandCard, cardPath } from "../../../lib/seo";

export async function getStaticPaths() {
  const bands = await getCollection("bands");
  const cards: [string, OgCard][] = [
    ...Object.entries(PAGE_CARDS),
    ...bands.map((b) => [`/bands/${b.id}`, bandCard(b.data.name, b.data.tagline)] as [string, OgCard]),
  ];
  return cards.map(([path, card]) => ({ params: { page: cardPath(path).replace(/^\/og\/pages\//, "").replace(/\.png$/, "") }, props: { card } }));
}

export const GET: APIRoute = async ({ props }) =>
  new Response(new Uint8Array(await renderOg((props as { card: OgCard }).card)), { headers: { "Content-Type": "image/png" } });
