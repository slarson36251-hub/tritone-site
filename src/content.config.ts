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
      // YouTube videos (id from the watch URL) shown as click-to-load players.
      videos: z.array(z.object({ id: z.string(), title: z.string(), note: z.string().optional() })).default([]),
      // Spotify embed URL: shows a Listen button that plays in the persistent dock.
      spotify: z.string().url().optional(),
      // Genres for the MusicGroup schema (only what the band actually plays).
      genres: z.array(z.string()).default([]),
      // Search title (~50-60 chars) and description (~140-160 chars). Defaults: name + tagline.
      seoTitle: z.string().max(65).optional(),
      seoDescription: z.string().min(70).max(165).optional(),
    }),
});


// One recording session (or a run of them) at the Hummingbird Hut: one Markdown file each in
// src/content/sessions/<id>.md, where <id> is the deep link (/sessions#<id>) and the page (/sessions/<id>).
// The body is the short intro under the name. Names, roles, dates and gear only as the session notes have them.
// Never an address: the place is "Hummingbird Hut, Oakland, CA" and nothing more.
const sessions = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/sessions" }),
  schema: ({ image }) =>
    z.object({
      artist: z.string(),
      // Second line on the tape label, e.g. "Joseph's Bones" or "Solo piano".
      project: z.string(),
      // The date on the tape. The shelf sorts newest first by it.
      date: z.coerce.date(),
      // Overrides the tape's "Aug 15 · 2026" when the day is not known, e.g. "Jul · 2025".
      dateLabel: z.string().optional(),
      // The span in the eyebrow: "Hummingbird Hut · Oakland, CA · <when>".
      when: z.string(),
      // Session log, newest first: date as shown, what happened, the hours, optional gear.
      sessions: z
        .array(z.object({ date: z.string(), what: z.string().optional(), hours: z.string().optional(), gear: z.string().optional() }))
        .default([]),
      people: z.array(z.object({ name: z.string(), role: z.string() })).default([]),
      peopleHeading: z.string().default("In the room"),
      // Gear and mic notes, grouped: [{ heading, rows: [{ label, value }] }].
      notes: z
        .array(z.object({ heading: z.string(), rows: z.array(z.object({ label: z.string(), value: z.string() })) }))
        .default([]),
      // The first photo is the cover (tape, hero, share card). `date` is the bold caption lead, e.g. "Oct 15, 2024 · 3:07 PM";
      // `label` stands in when there is no date ("Mix chain").
      photos: z
        .array(
          z.object({
            src: image(),
            alt: z.string(),
            caption: z.string(),
            date: z.string().optional(),
            label: z.string().optional(),
          }),
        )
        .min(1),
      photosHeading: z.string().default("More from the session"),
      // YouTube videos: the page shows the thumbnail and loads the player (youtube-nocookie) on click.
      videos: z
        .array(z.object({ youtubeId: z.string().regex(/^[\w-]{11}$/), title: z.string(), alt: z.string(), note: z.string().optional() }))
        .default([]),
      videosHeading: z.string().default("Watch · videos from these sessions"),
      // Where to follow the artist now: [{ label: "Instagram", url }].
      links: z.array(z.object({ label: z.string(), url: z.string().url() })).default([]),
      // A released album from the session: Bandcamp's player (album id from the page's bc-page-properties item_id).
      albums: z
        .array(z.object({ bandcampId: z.string().regex(/^\d+$/), title: z.string(), artist: z.string(), url: z.string().url(), tracks: z.number().int().positive(), note: z.string().optional() }))
        .default([]),
    }),
});

export const collections = { releases, bands, sessions };
