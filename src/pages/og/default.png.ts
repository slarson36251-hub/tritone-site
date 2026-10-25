// Default share image: /og/default.png
import type { APIRoute } from "astro";
import { renderOg } from "../../lib/og";

export const GET: APIRoute = async () =>
  new Response(
    new Uint8Array(await renderOg({ kicker: "Live · Bay Area", headline: "Shows", sub: "Tritone Productions · Oakland, CA" })),
    { headers: { "Content-Type": "image/png" } },
  );
