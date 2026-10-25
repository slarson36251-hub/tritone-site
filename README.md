# tritone-productions.com

Astro + Tailwind static site for Tritone Productions, hosted on Firebase Hosting.

```
src/
  pages/            one file per URL (index = Home A, sessions, shows, hummingbird-hut, bands, bands/[slug], gallery, contact, book-the-hut, 404)
  components/       Header, Footer, Pill, PageHead
  components/home/  Hero, FeaturedRelease, PathCards, NextUp
  content/          Markdown content: releases/ (homepage "Fresh from the Hut"), bands/, sessions/
  lib/              nav.ts (menu), shows.ts (Music calendar, build time)
  assets/           logo + photos (re-encoded by Astro, metadata dropped)
  components/sessions/  Shelf, Tape, SessionDetail, LiteYouTube (the /sessions tape shelf)
public/             served as-is (favicon, audio)
scripts/privacy-check.mjs   runs after every build; fails on street address, geo, maps or photo metadata
```

## Commands
- `npm run dev`: local preview at http://localhost:4321
- `npm run build`: build to `dist/` and run the privacy check
- `npm run deploy`: build and deploy to Firebase Hosting

## Shows
Shows come from the public **Music** Google Calendar at build time (`MUSIC_CALENDAR_ID`, `GOOGLE_CALENDAR_API_KEY`
in `.env`, see `.env.example`). Put `poster: <url>` and `tickets: <url>` lines in an event's description.

## Sessions
`/sessions` is the tape shelf (newest left) with the open session below; `/sessions#<id>` opens one, and each
session also has its own page `/sessions/<id>` with a share card `/og/sessions/<id>.png`.
To add a session:
1. Put the photos (metadata stripped, descriptive names like `artist-what-mon-yyyy-hummingbird-hut-oakland.webp`)
   in `src/assets/sessions/`. The first photo listed is the cover.
2. Copy a file in `src/content/sessions/` to `<id>.md` (the id is the URL) and fill in the frontmatter
   (fields documented in `src/content.config.ts`): artist, project, date (the tape date; shelf sorts by it), when,
   sessions, people, notes, photos, videos. The body is the short intro.
3. `npm run build`. Never an address: "Hummingbird Hut, Oakland, CA" only.

## Bands, audio and posters
- Band pages come from `src/content/bands/<slug>.md` (frontmatter: tagline, poster, lineup, tracks; body = bio).
  `/bands` is the index, `/bands/<slug>` each band. Posters for the band pages and `/gallery` are listed in `src/lib/posters.ts`
  (files in `src/assets/posters/`).
- Track audio still points at the old Squarespace MP3 URLs. To host it ourselves, run on the Mac:
  `bash scripts/fetch-audio.sh` (downloads into `public/audio/<band>/<title>.mp3` and rewrites each track's `src`), then build.
  Do it before the Squarespace site is cancelled, or the players go silent.
- Old Squarespace URLs (`/hard-bop-quintet`, `/franco-nero`, `/lucky-7`, `/about`, `/home`, ...) are 301 redirects in `firebase.json`.

## Beta-site feedback (Scott only)
On https://tritone-site.web.app (or a preview channel), open any page with `?feedback=on` once: a **Feedback** button
appears bottom-left on every page in that browser. Tap it, tap the thing to comment on (or **Whole page**), tap **Talk**
and speak (or type), then **Send**. `?feedback=off` hides it again. It never loads on tritone-productions.com.
- Notes go to Firestore (`feedback` collection, create-only per `firestore.rules`) with the `FEEDBACK_API_KEY` repo
  variable (built in as `PUBLIC_FEEDBACK_API_KEY`). Read them with the **Feedback notes** workflow (artifact `feedback.json`).
- Code: `src/components/Feedback.astro` (gate), `src/lib/feedback-overlay.ts` (overlay, loaded on demand).
  Browser check: `PUBLIC_FEEDBACK_API_KEY=test-key npm run build && node scripts/check-feedback.mjs`.

## Privacy (hard rule)
The studio's street address must never be published or inferable. Only "Oakland, CA".
No maps, no geo in schema, no photo metadata, and never read the Hummingbird Hut calendar.
