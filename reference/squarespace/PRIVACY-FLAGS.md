# Privacy flags

Hard rule: the Hummingbird Hut studio street address, maps, coordinates and Synology/DDNS hostnames are never copied into this archive.

## Result

- No studio street address, studio map, coordinates or NAS/DDNS hostname appears on any crawled page. Nothing had to be removed.

## Checked and kept (not the studio)

- /shows and /shows/nick-culp-quartet show the Low Bar venue address (2300 Webster St, Oakland) with a Google Maps link. Low Bar is a public bar, not the studio, so it is kept.
- /upload, /book-the-hut, /sessions, /free-track mention only "Oakland, CA".
- /upload script lists the generic domains quickconnect.to and synology.me as allowed link hosts; no specific NAS hostname.
- Images: none of the originals carried GPS or camera EXIF; all metadata stripped anyway.

Method: regex scan of every page's text and raw HTML for street-address patterns, map links and map-block coordinates, and Synology/QuickConnect/DDNS hostnames, then a manual read of the studio pages.
