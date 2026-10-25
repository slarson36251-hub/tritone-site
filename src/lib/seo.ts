// Site-wide SEO: share-card definitions and JSON-LD builders.
// PRIVACY: Tritone and the Hummingbird Hut are only ever "Oakland, CA". Never a street
// address, postal code or geo coordinates here (scripts/privacy-check.mjs and tests/seo.test.mjs enforce it).
import type { OgCard } from "./og";

export const SITE = "https://tritone-productions.com";
export const ORG_ID = `${SITE}/#organization`;
export const SITE_ID = `${SITE}/#website`;
export const HUT_ID = `${SITE}/hummingbird-hut#studio`;
export const LOGO_URL = `${SITE}/tritone-logo.png`;
export const EMAIL = "scott@tritone-productions.com";
export const PHONE = "+1-415-200-6291";

export const SOCIALS = [
  { label: "Instagram", href: "https://www.instagram.com/tritone_productions/" },
  { label: "Facebook", href: "https://www.facebook.com/tritoneproductions" },
  { label: "SoundCloud", href: "https://soundcloud.com/skatlarson" },
];

/** City-level address only. */
export const OAKLAND = { "@type": "PostalAddress", addressLocality: "Oakland", addressRegion: "CA", addressCountry: "US" } as const;

/** "/bands.html", "/bands/" → "/bands"; "/" stays "/". */
export const cleanPath = (p: string) => p.replace(/\.html$/, "").replace(/\/index$/, "/").replace(/(.)\/+$/, "$1") || "/";
/** Canonical URL, never with a trailing slash (the home page is the bare origin). */
export const canonicalUrl = (p: string) => (cleanPath(p) === "/" ? SITE : `${SITE}${cleanPath(p)}`);

// Share cards for the site's own pages, keyed by path. Band cards are added from the collection.
export const PAGE_CARDS: Record<string, OgCard> = {
  "/": { kicker: "Music production · Oakland, CA", headline: "Tritone Productions", sub: "Hummingbird Hut studio · Bay Area bands" },
  "/hummingbird-hut": { kicker: "Recording studio · Oakland, CA", headline: "Hummingbird Hut", sub: "Tracking · Overdubs · Mixing · Mastering prep" },
  "/book-the-hut": { kicker: "Hummingbird Hut · Oakland, CA", headline: "Book the Hut", sub: "Request a recording day" },
  "/sessions": { kicker: "Hummingbird Hut · Oakland, CA", headline: "Sessions", sub: "Recorded at the Hut" },
  "/bands": { kicker: "Live · Bay Area", headline: "The Bands", sub: "Clubs · parties · festivals" },
  "/gallery": { kicker: "From the wall", headline: "Gig Poster Gallery", sub: "Tritone Productions bands" },
  "/contact": { kicker: "Tritone Productions · Oakland, CA", headline: "Say hello", sub: "Book a session or a band" },
  "/free-track": { kicker: "Tritone Productions", headline: "Free track", sub: "Straight to your inbox" },
  "/upload": { kicker: "Hummingbird Hut", headline: "Send your files", sub: "Tritone Productions · Oakland, CA" },
};

/** Path of the generated card for a page path: "/" → /og/pages/home.png, "/bands/x" → /og/pages/bands/x.png. */
export const cardPath = (p: string) => `/og/pages/${cleanPath(p) === "/" ? "home" : cleanPath(p).slice(1)}.png`;

export const bandCard = (name: string, tagline: string): OgCard => ({
  kicker: "Tritone Productions · Bay Area band",
  headline: name,
  sub: tagline.length > 60 ? "Book the band · tritone-productions.com" : tagline.replace(/\.$/, ""),
});

export function organization() {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: "Tritone Productions",
    url: SITE,
    logo: { "@type": "ImageObject", url: LOGO_URL, width: 1200, height: 483 },
    description: "Music production in Oakland, CA: the Hummingbird Hut recording studio and Tritone's Bay Area bands.",
    email: EMAIL,
    telephone: PHONE,
    founder: { "@type": "Person", name: "Scott Larson" },
    address: OAKLAND,
    areaServed: { "@type": "Place", name: "San Francisco Bay Area" },
    sameAs: SOCIALS.map((s) => s.href),
    contactPoint: { "@type": "ContactPoint", contactType: "booking", email: EMAIL, telephone: PHONE, areaServed: "US", availableLanguage: "en" },
  };
}

export function website() {
  return { "@type": "WebSite", "@id": SITE_ID, url: SITE, name: "Tritone Productions", inLanguage: "en-US", publisher: { "@id": ORG_ID } };
}

export interface Crumb { name: string; path: string }
export function breadcrumbs(crumbs: Crumb[]) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [{ name: "Home", path: "/" }, ...crumbs].map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: canonicalUrl(c.path),
    })),
  };
}

export function hummingbirdHut(image: string, services: { t: string; d: string }[]) {
  return {
    "@type": "ProfessionalService",
    "@id": HUT_ID,
    name: "Hummingbird Hut",
    alternateName: "Hummingbird Hut recording studio",
    description: "Private recording studio in Oakland, CA: whole bands tracked live in one room on multiple mics, plus overdubs and mixing.",
    url: canonicalUrl("/hummingbird-hut"),
    image,
    email: EMAIL,
    telephone: PHONE,
    address: OAKLAND,
    areaServed: { "@type": "Place", name: "San Francisco Bay Area" },
    parentOrganization: { "@id": ORG_ID },
    makesOffer: services.map((s) => ({
      "@type": "Offer",
      itemOffered: { "@type": "Service", name: s.t, description: s.d, provider: { "@id": HUT_ID } },
    })),
  };
}

/** open.spotify.com/embed/artist/ID?x → open.spotify.com/artist/ID */
export const spotifyPage = (embed: string) => {
  const u = new URL(embed);
  return `${u.origin}${u.pathname.replace(/^\/embed\//, "/")}`;
};

interface BandData {
  name: string;
  tagline: string;
  genres?: string[];
  lineup: { name: string; instrument: string }[];
  tracks: { title: string; src: string; credit?: string }[];
  spotify?: string;
}
export function musicGroup(slug: string, b: BandData, image: string) {
  const url = canonicalUrl(`/bands/${slug}`);
  const id = `${url}#band`;
  return {
    "@type": "MusicGroup",
    "@id": id,
    name: b.name,
    description: b.tagline,
    url,
    image,
    ...(b.genres?.length ? { genre: b.genres } : {}),
    foundingLocation: { "@type": "Place", name: "San Francisco Bay Area" },
    ...(b.lineup.length
      ? {
          member: b.lineup.flatMap((m) =>
            m.name.split(/\s*\/\s*/).map((name) => ({
              "@type": "OrganizationRole",
              member: { "@type": "Person", name },
              roleName: m.instrument,
            })),
          ),
        }
      : {}),
    ...(b.spotify ? { sameAs: [spotifyPage(b.spotify)] } : {}),
    ...(b.tracks.length
      ? {
          track: b.tracks.map((t) => ({
            "@type": "MusicRecording",
            name: t.title,
            byArtist: { "@id": id },
            ...(t.credit ? { recordingOf: { "@type": "MusicComposition", name: t.title, composer: { "@type": "Person", name: t.credit } } } : {}),
            ...(t.src.startsWith("/audio/")
              ? { audio: { "@type": "AudioObject", contentUrl: `${SITE}${t.src}`, encodingFormat: "audio/mpeg" } }
              : {}),
          })),
        }
      : {}),
  };
}
