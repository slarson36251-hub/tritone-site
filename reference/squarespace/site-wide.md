# Site-wide settings

## Header

- Logo: `images/white-tritone-lettering.png` (alt "Tritone Productions"), links to /.
- Menu: About · Hummingbird Hut · Book the Hut · Bands ▸ (Hard Bop Quintet, Franco Nero, Lucky 7) · Gallery · Shows · Contact.
- Social icons (header and mobile menu): Instagram https://www.instagram.com/tritone_productions/ · Facebook https://www.facebook.com/tritoneproductions · SoundCloud https://soundcloud.com/skatlarson

## Footer

- Social icons only (same three links); no footer text.

## SEO

- Site title: "Tritone Productions". Page titles follow "<Page> — Tritone Productions" (home and /about are just "Tritone Productions").
- Meta description: empty on every page. No per-page SEO descriptions set.
- og:image (site-wide): the black trident oval logo (`images/black-trident-logo-oval-2.jpg`). Favicon: `images/favicon.ico`.
- Time zone America/Los_Angeles. Squarespace site id 62b7586b3006a46437ca5e0c; internal domain tritone-productions.squarespace.com.
- JSON-LD: WebSite + Organization (name, logo); the Nick Culp event page carries Event JSON-LD with the Low Bar venue.

## Contact details shown publicly

- scott@tritone-productions.com, (415) 200-6291, "Hummingbird Hut — Oakland, California" (city only; no street address anywhere on the site).

## Code injection / custom code

- No site-wide header/footer injection beyond Squarespace's own scripts.
- Google Fonts Archivo Black + Space Grotesk are loaded by the custom code blocks on /book-the-hut, /sessions, /upload, /free-track.
- /book-the-hut: custom booking form + JS; submits to a Google Apps Script web app (the "Hummingbird Hut Booking" deployment).
- /free-track: custom sign-up form + JS; posts to a second Apps Script web app.
- /upload: custom page + "Tritone upload landing" JS that only accepts links on quickconnect.to, synology.me or tritone-productions.com (no NAS hostname is in the page itself).
- /sessions: custom "tape shelf" HTML/JS, click-to-load YouTube video cards.
- /shows and its event page: a script that reads a public Google Calendar (CAL_ID constant) to list shows.
- Apps Script endpoints found in the page source (public, not secrets):
  - https://script.google.com/macros/s/AKfycbwVzX-VCx7_UCAj6rZ_DplyZaNdT4MGNOJXVinDPWn1pTem6T6Pt07gBkeKu8NykfJX/exec (on /book-the-hut)
  - https://script.google.com/macros/s/AKfycby7DXnYPXt2odT9N5PLVtecmN9ZJNuJFt20iwsX8rMxPHS5TJu6g5QXnfWEO3U2ejI_eA/exec (on /free-track)
