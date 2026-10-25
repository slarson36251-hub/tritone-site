// Shared contract between the visitor tracker (src/lib/track.ts) and Scott's private dashboard
// (src/pages/admin.astro). First-party, cookieless analytics stored in Firestore collection "hits".
// Privacy: no IPs, no names/emails/phones, no precise location (time zone only), nothing about
// the studio's whereabouts. Clients may only create hits (firestore.rules); only Scott can read.

export const HITS_COLLECTION = "hits";
export const FIRESTORE_DOCS = "https://firestore.googleapis.com/v1/projects/tritone-site/databases/(default)/documents";

/** Where a visit came from, decided once on the landing page and repeated on every hit of that visit. */
export type Source = "ai" | "search" | "social" | "email" | "campaign" | "referral" | "direct";
export const SOURCES: Source[] = ["ai", "search", "social", "email", "campaign", "referral", "direct"];
export const SOURCE_LABELS: Record<Source, string> = {
  ai: "AI assistants",
  search: "Search",
  social: "Social",
  email: "Email",
  campaign: "Outreach links",
  referral: "Other sites",
  direct: "Direct / typed",
};

/** Interest events. Keep names stable: the dashboard groups by them. */
export type EventName =
  | "book_submit" // Book the Hut form sent (lbl: "<hours>h <weekday>", never personal details)
  | "book_earlier" // asked for an earlier / off-calendar time
  | "show_click" // opened a show page or card (lbl: show slug)
  | "ticket_click" // ticket / venue link (lbl: show slug or venue)
  | "calendar_add" // add-to-calendar (lbl: show slug)
  | "poster_click" // poster opened / enlarged (lbl: poster or show slug)
  | "play" // started listening: player dock, Bandcamp, SoundCloud, YouTube, audio (lbl: what)
  | "free_track" // free track sign-up / download
  | "contact_click" // mailto:, tel:, contact form (lbl: "email" | "phone" | "form")
  | "outbound"; // link to a band / social / streaming site (lbl: host)

export const EVENT_LABELS: Record<EventName, string> = {
  book_submit: "Booking requests",
  book_earlier: "Earlier-time requests",
  show_click: "Show clicks",
  ticket_click: "Ticket / venue clicks",
  calendar_add: "Added a show to calendar",
  poster_click: "Poster views",
  play: "Listening plays",
  free_track: "Free track",
  contact_click: "Contact clicks",
  outbound: "Outbound links",
};

/**
 * One Firestore document per page view (k "pv") or interest event (k "ev").
 * Every value is a string except t (timestamp, must equal request.time) and first (boolean).
 * Max lengths are enforced in firestore.rules.
 */
export interface Hit {
  k: "pv" | "ev";
  t: string; // ISO time; written as Firestore timestampValue = server request.time
  sid: string; // random id for this visit (memory only, no cookie / storage), <= 16
  path: string; // page path, no query string, <= 200
  first: boolean; // true on the landing page view of a visit. False on a reload, back/forward, or a new tab
  //                  opened from an in-site link: those continue a visit. The digest counts a visit only for a
  //                  sid with a first:true page view and reports the others as "continued".
  src: Source;
  ref: string; // referrer hostname only ("" if none), <= 100
  us: string; // utm_source <= 80
  um: string; // utm_medium <= 80
  uc: string; // utm_campaign <= 80
  ux: string; // utm_content <= 80
  land: string; // landing path of the visit, <= 200
  dev: "m" | "t" | "d"; // phone / tablet / desktop by viewport width
  tz: string; // IANA time zone, e.g. America/Los_Angeles, <= 40
  lang: string; // navigator.language, <= 12
  ev: string; // EventName for k "ev", "" for page views
  lbl: string; // event detail, <= 120, "" for page views
}

/** Admin emails allowed to read hits (firestore.rules must match). */
export const ADMIN_EMAILS = ["slarson36251@gmail.com", "scott@tritone-productions.com"];

/** Set in localStorage on Scott's own devices (by visiting /admin) so his visits are not counted. */
export const SELF_FLAG = "tritone:no-track";
