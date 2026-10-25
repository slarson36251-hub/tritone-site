# tritone-productions.com

Astro + Tailwind static site for Tritone Productions, hosted on Firebase Hosting.

```
src/
  pages/            one file per URL (index = Home A, sessions, shows, hummingbird-hut, bands, contact, book-the-hut, 404)
  components/       Header, Footer, Pill, PageHead
  components/home/  Hero, FeaturedRelease, PathCards, NextUp
  content/          Markdown content: releases/ (homepage "Fresh from the Hut"), bands/
  lib/              nav.ts (menu), shows.ts (Music calendar, build time)
  assets/           logo + photos (re-encoded by Astro, metadata dropped)
  gallery.html      the /sessions gallery, ported from the Squarespace code block
public/             served as-is (favicon, session photos)
scripts/privacy-check.mjs   runs after every build; fails on street address, geo, maps or photo metadata
```

## Commands
- `npm run dev`: local preview at http://localhost:4321
- `npm run build`: build to `dist/` and run the privacy check
- `npm run deploy`: build and deploy to Firebase Hosting

## Shows
Shows come from the public **Music** Google Calendar at build time (`MUSIC_CALENDAR_ID`, `GOOGLE_CALENDAR_API_KEY`
in `.env`, see `.env.example`). Put `poster: <url>` and `tickets: <url>` lines in an event's description.

## Privacy (hard rule)
The studio's street address must never be published or inferable. Only "Oakland, CA".
No maps, no geo in schema, no photo metadata, and never read the Hummingbird Hut calendar.
