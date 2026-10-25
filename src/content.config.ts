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

// Tritone's own bands, in menu order. The Markdown body is the bio (may be empty).
// Only facts from the old site or the brand sheet go here: never invent personnel, venues or dates.
const bands = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/bands" }),
  schema: ({ image }) =>
    z.object({
      name: z.string(),
      order: z.number(),
      tagline: z.string(),
      // Hero image: a gig poster (or a band photo). Without one the page uses a typographic card.
      poster: image().optional(),
      posterAlt: z.string().optional(),
      // A wide band photo shown under the bio.
      photo: image().optional(),
      photoAlt: z.string().optional(),
      lineup: z.array(z.object({ name: z.string(), instrument: z.string() })).default([]),
      // Audio for the track list. `src` is an absolute URL or a /audio/... path (see scripts/fetch-audio.sh).
      tracks: z
        .array(z.object({ title: z.string(), src: z.string(), credit: z.string().optional() }))
        .default([]),
      // Spotify embed URL: shows a Listen button that plays in the persistent dock.
      spotify: z.string().url().optional(),
    }),
});

export const collections = { releases, bands };
