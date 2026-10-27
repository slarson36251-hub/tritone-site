# Mix Review — shared contract (v1)

Scott (Tritone Productions / Hummingbird Hut) shares a mix bounce with a client through a hidden page on
tritone-productions.com. The client opens a share link (or scans a QR code in the email), types their name once,
plays the mix with Scott's Logic markers over the waveform, and leaves time-stamped notes, typed or talked over the
music. Notes land in Scott's queue. Audio never leaves the NAS: it streams from the Synology through a small
token-checking server. Phone first: it must be easy on an iPhone in Safari.

## The pieces

| | Where | Owner |
|---|---|---|
| Client review page `/review?k=<reviewKey>` | repo `slarson36251-hub/tritone-site` (Astro static site, Firebase Hosting, project `tritone-site`) | A |
| Firestore rules, hosting headers/CSP, Scott's queue in `/admin` | `tritone-site` | B |
| NAS stream server (Docker on the Synology, behind a tunnel) | repo `slarson36251-hub/tritone`, `studio/review-stream/` | C |
| Publisher + bounce watcher + notes export (Mac Studio) | `tritone`, `studio/Automation/scripts/review/` | D |

## Access model: the link is the key

- `reviewKey` = 24 random base62 characters (≥140 bits), made by the publisher. It is the Firestore document id
  of the review, so knowing the link is the only way in. Clients never sign in.
- Share URL: `https://tritone-productions.com/review?k=<reviewKey>` (optional `&v=<versionId>`; default = latest).
- The page is `noindex, nofollow`, never in the sitemap, never linked from the site, `Referrer-Policy: no-referrer`,
  and analytics (`src/lib/track.ts`) must not record it (or must record path `/review` only, never the query).
- Scott closes a review by setting `status: "closed"`: rules then refuse every client read and write.
- Scott (admin) reads and updates everything after signing in on `/admin` (existing email-link auth; `isAdmin()` in
  `firestore.rules`: verified `slarson36251@gmail.com` or `scott@tritone-productions.com`).

## Firestore (project `tritone-site`)

All client reads/writes go through the Firestore REST API with the public web API key
(`PUBLIC_FEEDBACK_API_KEY`, same as `track.ts` / `feedback-overlay.ts`); no Firebase JS SDK on the client page.

### `reviews/{reviewKey}`
```
title         string   "Translucent"
artist        string   "Fault Line Trio"
clients       string[] ["Jay"]              display only
status        string   "open" | "closed"
latestVersion string   "v2"
createdAt     timestamp
updatedAt     timestamp
```
Clients: `get` only when `status == "open"`. Never `list` the collection. Writes: publisher (service account) and admin only.

### `reviews/{reviewKey}/versions/{versionId}`  (versionId: `v1`, `v2`, … `[a-z0-9-]{1,20}`)
```
label        string   "v2 — final"
order        number   2
createdAt    timestamp
bounceName   string   "Translucent v2 - final.wav"
durationSec  number   312.48
sampleRate   number   48000
bpm          number   160          project tempo from Logic (single tempo)
beatsPerBar  number   4
offsetSec    number   0            session time at bounce sample 0 (markers are already shifted to bounce time)
markers      array    [{ name: "Intro", t: 0.0 }, { name: "Head A", t: 18.2 }, …]   t = seconds in the bounce, ascending
peaks        array    1200 ints 0–255, max |sample| per bin across both channels, scaled to the file's peak
media        map      { wav: "<path>", aac: "<path>" }   paths relative to the NAS shared folder root "Tritone",
                      e.g. "Projects/Logic /Fault Line/Mix/Final Mixes/Translucent/Bounce/Translucent v2 - final.wav"
                      and  "Projects/Logic /Fault Line/Mix/Final Mixes/Translucent/Bounce/_review/Translucent v2 - final.m4a"
```
Bar/beat for a time t: `beat = floor((t + offsetSec) * bpm / 60)`; `bar = floor(beat / beatsPerBar) + 1`; `beatInBar = beat % beatsPerBar + 1`.
Clients: `get`/`list` when the parent review is open. Writes: publisher/admin only.

### `reviews/{reviewKey}/notes/{noteId}`
Client-created fields (exactly these keys on create):
```
versionId   string  ≤20
t           number  0 ≤ t ≤ 36000     where the note points (seconds in that version)
from        number  0 ≤ from ≤ t       start of the clip the client had just heard (t − 5 s, or the loop start)
section     string  ≤80   marker name at t ("" if none)
bar         number  int ≥ 1
beat        number  int 1–16
kind        string  "text" | "voice"
text        string  ≤4000 (may be "" only for voice)
voiceId     string  ≤64   "" for text; for voice the id returned by the stream server's upload
voiceSec    number  0–600  length of the recording (0 for text)
author      string  1–60   the name the client typed
createdAt   timestamp == request.time
status      string  == "open"
```
Admin-only fields added later: `status` ("open" | "doing" | "done"), `reply` (string ≤4000), `transcript` (string ≤8000),
`updatedAt` (timestamp). Clients may `list`/`get` notes of an open review (everyone on the review sees all its notes),
may `create` in the exact shape above, never update or delete.

## v1.1 change (Scott, 21:49): drafts on the device, then "Send feedback"

- The client works on DRAFT notes that live only on their device (localStorage for the notes, IndexedDB for voice
  blobs) until they press **Send feedback**. While drafting they can: make many notes anywhere (several may overlap the
  same area), edit text, re-record, delete, LISTEN to a note (plays its clip from `from` to `t`, and their recording),
  and MOVE a note on the timeline: each draft shows on the waveform as a range [from, t]; drag the range body to move
  both, drag its start handle to change `from` (`from` ≤ `t`; snap nothing, show time/bar while dragging).
- **Send feedback** uploads each voice blob (POST /v1/voice), then writes one submission doc and its notes, then clears
  the sent drafts and shows "Sent to Scott" with the sent list (read-only, still playable). They can start a new round
  later; each send is a new submission.
- Firestore additions:
  - `reviews/{key}/submissions/{submissionId}` (client create-only, exact keys):
    `author` string 1–60, `versionId` string ≤20, `noteCount` int 1–200, `createdAt` == request.time,
    `status` == "new". Admin-only later: `status` ("new" | "listening" | "done"), `updatedAt`.
  - Notes gain `submissionId` (string ≤40, must exist: `exists(.../submissions/$(submissionId))`) — added to the
    client-created key set. Notes are still create-only for clients (edits happen before sending, on the device).
  - Write order: submission doc first, then notes (or one Firestore `:commit` batch with all writes — preferred, so a
    send is all-or-nothing; rules must allow that).
- Scott's queue groups by **song (review) → client (author) → submission**, newest first, with new/listening/done.
  Clicking a note plays the song from that note's `from` through `t`, then the client's voice note (if any).
- **Follow-along mode** (Scott on a tablet or second screen while he works in Logic): pick a submission (or all open
  notes of a version), the song plays with the waveform + markers + note ranges; as playback reaches each note it
  highlights and shows the note big and readable (author, bar·beat, section, text/transcript, voice play button);
  options: "pause at each note" on/off, "play voice note automatically" on/off; big Next/Previous note, Replay clip,
  Mark done (moves on). Large type and targets, works landscape on an iPad, screen stays awake (Wake Lock API where available).

## v1.2 change (Scott, 22:20): cycle range, no tempo

- Scott bounces the Logic CYCLE range. Markers = only those inside the cycle; marker time in the bounce =
  (markerTick − cycleStartTick) / (cycleEndTick − cycleStartTick) × bounce duration. No tempo, no click.
- Versions are written with `bpm: 0`; pages show no Bar·Beat when bpm is 0 (time m:ss.s + section only).
  Notes still carry `bar: 1, beat: 1` as placeholders so the rules' shape is unchanged.

## NAS stream server  (base URL from `PUBLIC_REVIEW_STREAM_URL`, e.g. `https://stream.tritone-productions.com`)

- `POST /v1/sign` JSON `{ "review": key, "version": id, "kind": "aac" | "wav" }` → `{ "url": "<base>/v1/m/<token>", "expiresAt": iso }`.
  The server itself fetches `reviews/{key}` and `reviews/{key}/versions/{id}` from Firestore REST with the public API key
  (so the rules decide), refuses if missing or closed, takes the path from `media[kind]`, and signs it.
  Same endpoint with `{ "review", "voiceId", "kind": "voice" }` signs a voice note (checks the voice file belongs to that review).
- `GET /v1/m/<token>`: streams the file with full HTTP Range support (206, `Accept-Ranges: bytes`, correct
  `Content-Type`: `audio/wav`, `audio/mp4`, `audio/webm`), `Cache-Control: private, max-age=3600`.
  Token = base64url(JSON `{p, e, r}`) + "." + base64url(HMAC-SHA256); expires after 6 h; path must stay inside the media root.
- `POST /v1/voice?review=<key>&version=<id>` raw body `audio/webm` | `audio/mp4` | `audio/ogg`, ≤ 10 MB → `{ "voiceId": "<uuid>.<ext>" }`.
  Stored at `<dir of that version's wav>/_review/notes/<reviewKey>/<voiceId>`. Refused if the review is closed.
- CORS allowlist: `https://tritone-productions.com`, `https://www.tritone-productions.com`, `https://tritone-site.web.app`,
  `https://tritone-site--*.web.app` (preview channels), `http://localhost:4321`. Methods GET, POST, OPTIONS; header `Range`, `Content-Type`.
- Never logs IPs alongside review keys longer than needed; never serves a directory listing; never follows a path outside the root.

## Logic markers and bounce

- Marker names and positions come from the `.logicx` project with the existing reader
  `studio/Automation/scripts/logic/marker-split/lib/logic_markers.py` (`read_markers`, `marker_ranges`, `project_bpm`).
  Scott drops an `END` marker after the last real marker (Logic stores the last marker without a position).
- Bounces are made by hand in Logic from bar 1 (session zero) unless `offsetSec` says otherwise.
- NAS mount on the Mac Studio: `/Volumes/Tritone` (kept alive by `com.tritone.nasmount`). Media paths in Firestore are
  relative to that root, so the Mac (`/Volumes/Tritone/<path>`) and the Synology (`/volume1/Tritone/<path>`) agree.
- Example project: `/Volumes/Tritone/Projects/Logic /Fault Line/Mix/Final Mixes/Translucent/` (bounce in `Bounce/`).
  Note the NAS folder is literally `Logic ` with a trailing space.

## House rules (both repos)

- One branch per task, never commit to main; small commits; push; open a PR with `gh`; Scott approves the merge. No deploys.
- Never commit secrets, audio or Logic projects. Secrets live in macOS Keychain (`com.tritone.automation`) / Google Secret Manager.
- Never publish or infer the studio's street address; "Oakland, CA" only.
- Branded output carries the real Tritone logo asset. Brand: charcoal `#38383B`, white, stone `#A8A6A1`;
  Archivo Black uppercase headlines, Space Grotesk body; pill buttons.
- Client-facing email goes through the Apps Script mailer (it embeds the logo), never the Gmail connector.
