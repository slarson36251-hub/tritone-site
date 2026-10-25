# Tritone Productions — Squarespace site archive

Reference-only snapshot of https://www.tritone-productions.com taken 2026-10-24, before the move to the new Firebase site (tritone-site).
Not for publishing. Lives outside every repo on purpose.

## Contents

- `pages/<slug>.md` — 20 pages as clean Markdown: headings, links, button labels, embedded media (SoundCloud iframes, audio-block MP3 URLs, YouTube links). Nested URLs use `__` (e.g. `shows__nick-culp-quartet`); `/` is `index`.
- `raw-html/<slug>.html` — the page source as served; `raw-html/_sitemap.xml`.
- `images/` — 52 files at original size, metadata stripped; `images/index.md` maps file → page, URL, alt.
- `site-map.md` — every URL, title, menu/sitemap/linked status and summary: the list the new site must cover or redirect.
- `site-wide.md` — header, footer, socials, SEO, code injection notes.
- `PRIVACY-FLAGS.md` — privacy check results.
- `.crawl.json`, `.images.json`, `.strip.json` — machine-readable crawl data.

Audio files on the band pages were listed by URL but not downloaded.
