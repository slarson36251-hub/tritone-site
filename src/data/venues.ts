// Public venues Tritone bands play. The ONLY source of street addresses on the site.
//
// PRIVACY: never add the Hummingbird Hut, a house concert, or any private or
// residential address here. scripts/privacy-check.mjs fails the build if any
// street address or postal code appears in a page's Event data that does not
// match an entry in this file.
//
// Only addresses and websites we are confident are correct are filled in.
// Leave a field out rather than guess; the show page then shows the venue name
// and city only. Plain data and type annotations only: the privacy check
// imports this file with Node's built-in type stripping.

export interface Venue {
  /** Display name, as the venue styles itself. */
  name: string;
  /** Other spellings seen in calendar entries ("The DeLuxe", "Deluxe"). */
  aliases?: string[];
  city: string;
  region?: string;
  /** Street address: only for public venues, only when confirmed. */
  street?: string;
  postalCode?: string;
  /** Official website. */
  url?: string;
  instagram?: string;
}

export const VENUES: Venue[] = [
  {
    name: "The DeLuxe",
    aliases: ["Club Deluxe", "The Deluxe", "Deluxe"],
    city: "San Francisco",
    street: "1511 Haight St",
    postalCode: "94117",
    url: "https://thedeluxesf.com/",
    instagram: "thedeluxesf",
  },
  {
    name: "Low Bar",
    city: "Oakland",
    street: "2300 Webster St",
    postalCode: "94612",
    url: "https://www.lowbaroakland.com/",
    instagram: "lowbaroakland",
  },
  {
    name: "Rite Spot Cafe",
    aliases: ["Rite Spot"],
    city: "San Francisco",
    street: "2099 Folsom St",
    postalCode: "94110",
    url: "https://ritespotcafe.net/",
  },
  {
    name: "The Sound Room",
    aliases: ["Sound Room"],
    city: "Oakland",
    street: "3022 Broadway",
    postalCode: "94611",
    url: "https://soundroom.org/",
    instagram: "thesoundroomoakland",
  },
  {
    name: "Salesforce Park",
    city: "San Francisco",
    street: "425 Mission St",
    postalCode: "94105",
    url: "https://www.tjpa.org/salesforce-transit-center/salesforce-park",
    instagram: "transitcentersf",
  },
  {
    name: "Verdi Club",
    aliases: ["The Verdi Club"],
    city: "San Francisco",
    street: "2424 Mariposa St",
    postalCode: "94110",
    url: "https://www.verdiclub.net/",
    instagram: "verdiclubsf",
  },
  {
    name: "Dawn Club",
    aliases: ["The Dawn Club", "Swan Club"],
    city: "San Francisco",
    street: "10 Annie St",
    postalCode: "94103",
    url: "https://www.dawnclub.com/",
    instagram: "dawnclubsf",
  },
  {
    name: "Ivy Room",
    aliases: ["The Ivy Room"],
    city: "Albany",
    street: "860 San Pablo Ave",
    postalCode: "94706",
    url: "https://www.ivyroom.com/",
    instagram: "ivyroom",
  },
  {
    name: "Broadway Studios",
    city: "San Francisco",
    street: "435 Broadway",
    postalCode: "94133",
    url: "https://www.broadwaystudios.com/",
  },
  {
    name: "Toot's Tavern",
    aliases: ["Toots Tavern", "Toots"],
    city: "Crockett",
    street: "627 2nd Ave",
    postalCode: "94525",
    url: "https://www.tootstavern.com/",
    instagram: "tootstavern",
  },
  {
    name: "Cigar Bar & Grill",
    aliases: ["The Cigar Bar & Grill", "The Cigar Bar and Grill", "Cigar Bar"],
    city: "San Francisco",
    street: "850 Montgomery St",
    postalCode: "94133",
    url: "https://www.cigarbarandgrill.com/",
    instagram: "cigarbar_sf",
  },
  {
    name: "Notte Divino",
    aliases: ["Divino", "Osteria Divino"],
    city: "Sausalito",
    street: "37 Caledonia St",
    postalCode: "94965",
    url: "https://nottedivinosausalito.com/",
    instagram: "notte.divino",
  },
  {
    name: "Jack London Square",
    city: "Oakland",
    street: "472 Water St",
    postalCode: "94607",
    url: "https://jacklondonsquare.com/",
    instagram: "jacklondonsq",
  },
  {
    name: "San Francisco Botanical Garden",
    aliases: ["Golden Gate", "Flower Piano", "SF Botanical Garden"],
    city: "San Francisco",
    street: "1199 9th Ave",
    postalCode: "94122",
    url: "https://gggp.org/",
    instagram: "gardensofgoldengatepark",
  },
  {
    name: "Boom Boom Room",
    aliases: ["The Boom Boom Room"],
    city: "San Francisco",
    url: "https://boomboomroom.com/",
    instagram: "boomboomroomsf",
  },
  {
    name: "Yoshi's",
    aliases: ["Yoshi's Oakland", "Yoshis"],
    city: "Oakland",
    street: "510 Embarcadero West",
    postalCode: "94607",
    url: "https://yoshis.com/",
  },
  {
    name: "SFJAZZ Center",
    aliases: ["SFJAZZ"],
    city: "San Francisco",
    street: "201 Franklin St",
    postalCode: "94102",
    url: "https://www.sfjazz.org/",
  },
  {
    name: "Black Cat",
    aliases: ["The Black Cat", "Black Cat SF"],
    city: "San Francisco",
    street: "400 Eddy St",
    postalCode: "94109",
  },
  {
    name: "Keys Jazz Bistro",
    city: "San Francisco",
    street: "498 Broadway",
    postalCode: "94133",
  },
  { name: "Cat's Corner", aliases: ["Cats Corner"], city: "San Francisco" },
  // Not listed on purpose: Stanford (private events) and Crescent Hotel (unconfirmed).
];

const key = (v: string) =>
  v.toLowerCase().replace(/^the\s+/, "").replace(/['’.]/g, "").replace(/&|\band\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

const INDEX = new Map<string, Venue>();
for (const v of VENUES) for (const n of [v.name, ...(v.aliases ?? [])]) INDEX.set(key(n), v);

/** The public venue a calendar venue name refers to, if it is one we list. */
export function findVenue(name: string | undefined): Venue | undefined {
  return name ? INDEX.get(key(name)) : undefined;
}

/** Full profile URL for a stored Instagram handle (or pass a full URL through). */
export const instagramUrl = (handle: string) =>
  /^https?:\/\//.test(handle) ? handle : `https://www.instagram.com/${handle.replace(/^@/, "").replace(/\/+$/, "")}/`;
