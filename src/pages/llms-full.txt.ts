// /llms-full.txt: the whole site in one plain-text file for AI assistants and agents,
// built from the same content collections as the pages. Oakland, CA only, never an address.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE } from "../lib/seo";
import { HUT_FAQS } from "../lib/faq";

const clean = (md: string | undefined) => (md ?? "").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();

export const GET: APIRoute = async () => {
  const intro = readFileSync(join(process.cwd(), "public/llms.txt"), "utf8").trim();
  const bands = (await getCollection("bands")).sort((a, b) => a.data.order - b.data.order);
  const sessions = (await getCollection("sessions")).sort((a, b) => +b.data.date - +a.data.date);

  const out = [
    intro,
    "",
    "## Hummingbird Hut FAQ",
    "",
    ...HUT_FAQS.flatMap((f) => [`### ${f.q}`, "", f.a, ""]),
    "## Bands in detail",
    "",
    ...bands.flatMap(({ id, data, body }) => [
      `### ${data.name}`,
      "",
      `${SITE}/bands/${id}`,
      "",
      data.tagline,
      ...(data.genres.length ? ["", `Genres: ${data.genres.join(", ")}`] : []),
      ...(data.lineup.length ? ["", `Lineup: ${data.lineup.map((m) => `${m.name} (${m.instrument})`).join("; ")}`] : []),
      ...(data.tracks.length ? ["", `Tracks on the site: ${data.tracks.map((t) => t.title).join(", ")}`] : []),
      ...(clean(body) ? ["", clean(body)] : []),
      "",
    ]),
    "## Sessions recorded at the Hummingbird Hut, Oakland, CA",
    "",
    ...sessions.flatMap(({ id, data, body }) => [
      `### ${data.artist}: ${data.project} (${data.when})`,
      "",
      `${SITE}/sessions/${id}`,
      ...(data.people.length ? ["", `In the room: ${data.people.map((p) => `${p.name} (${p.role})`).join("; ")}`] : []),
      ...(clean(body) ? ["", clean(body)] : []),
      "",
    ]),
  ].join("\n");

  return new Response(out.trim() + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
