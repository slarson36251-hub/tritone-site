import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// A record made at the Hut. The one with `featured: true` shows on the homepage.
const releases = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/releases" }),
  schema: z.object({
    artist: z.string(),
    featured: z.boolean().default(false),
    credits: z.string(),
    listenUrl: z.string().url().optional(),
    listenLabel: z.string().default("Listen on Spotify"),
    tracks: z.array(z.object({ title: z.string(), note: z.string() })),
  }),
});

// Tritone's own bands, in menu order.
const bands = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/bands" }),
  schema: z.object({
    name: z.string(),
    order: z.number(),
  }),
});

export const collections = { releases, bands };
