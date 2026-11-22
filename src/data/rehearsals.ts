// Rehearsal planners: one private page per band at /rehearse/<key>. The key is the whole secret
// (24 random letters and digits): send the link to the band, nobody signs in. To add a band, copy an
// entry, give it a new key (any 24 random letters/digits), and push. Answers live in Firestore under
// rehearsals/<key>/answers/<player-slug> (firestore.rules). Scott's gigs (Music calendar) and
// Hummingbird Hut bookings are blocked out automatically at build time (src/lib/rehearse/busy.ts),
// refreshed by the 2-hourly rebuild. All times are Pacific wall-clock.

export interface RehearsalSlot {
  /** Short id used in stored answers: lowercase letters, digits, hyphen. */
  id: string;
  label: string;
  /** "HH:MM", 24h, Pacific. */
  start: string;
  end: string;
}

export interface RehearsalPlan {
  key: string;
  band: string;
  /** One line under the band name, e.g. the gig this rehearsal is for. */
  gig: string;
  /** First and last date offered, "YYYY-MM-DD". */
  from: string;
  to: string;
  roster: { name: string; role?: string }[];
  slots: RehearsalSlot[];
  /** Extra blocked times beyond the calendars, e.g. a day Scott's away. */
  extraBlocks?: { date: string; start: string; end: string; label: string }[];
}

export const DEFAULT_SLOTS: RehearsalSlot[] = [
  { id: "midday", label: "Midday", start: "11:00", end: "14:00" },
  { id: "afternoon", label: "Afternoon", start: "14:00", end: "17:00" },
  { id: "evening", label: "Evening", start: "19:00", end: "22:00" },
];

export const REHEARSALS: RehearsalPlan[] = [
  {
    key: "OlzPbIEA3a3xcmLiZ2YINfX8",
    band: "Lucky 7",
    gig: "Scotch Larson presents his Lucky 7 · Verdi Club, San Francisco · Tue Dec 15",
    from: "2026-11-23",
    to: "2026-12-14",
    roster: [
      { name: "Scott Larson", role: "trombone" },
      { name: "Henry Hung", role: "trumpet" },
      { name: "James Dunning", role: "trumpet" },
      { name: "Patrick Wolff", role: "clarinet, tenor" },
      { name: "Myles Boisen", role: "guitar" },
      { name: "Safa Shokrai", role: "bass" },
      { name: "Benny Amon", role: "drums" },
      { name: "Allegra Bandy", role: "vocals" },
    ],
    slots: DEFAULT_SLOTS,
  },
];
