// Share image per session: /og/sessions/<id>.png (Tritone card + the session cover at right).
import type { APIRoute } from "astro";
import { getSessions, type Session } from "../../../lib/sessions";
import { renderOg } from "../../../lib/og";

export async function getStaticPaths() {
  return (await getSessions()).map((session) => ({ params: { id: session.id }, props: { session } }));
}

export const GET: APIRoute = async ({ props }) => {
  const { session } = props as { session: Session };
  const cover = session.data.photos[0].src as { fsPath?: string };
  const png = await renderOg({
    kicker: `Session · ${session.data.when}`,
    headline: session.data.artist,
    sub: "Hummingbird Hut · Oakland, CA",
    photo: cover.fsPath,
  });
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};
