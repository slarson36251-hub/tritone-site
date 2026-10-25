// Outreach link builder: page + venue/club/campaign + channel -> a clean tagged URL that the
// tracker files under "Outreach links" and the dashboard's Outreach table groups by campaign.

export const SITE_URL = "https://tritone-productions.com";

export interface Channel { id: string; label: string; source: string; medium: string; qr?: boolean }

/** utm_source / utm_medium per channel. "venue" uses the venue's own slug as the source. */
export const CHANNELS: Channel[] = [
  { id: "instagram", label: "Instagram post / story", source: "instagram", medium: "social" },
  { id: "instagram-bio", label: "Instagram bio link", source: "instagram", medium: "bio" },
  { id: "facebook", label: "Facebook", source: "facebook", medium: "social" },
  { id: "email", label: "Email / newsletter", source: "newsletter", medium: "email" },
  { id: "text", label: "Text message", source: "sms", medium: "sms" },
  { id: "flyer", label: "Flyer (QR code)", source: "flyer", medium: "qr", qr: true },
  { id: "poster", label: "Poster (QR code)", source: "poster", medium: "qr", qr: true },
  { id: "card", label: "Business card (QR code)", source: "card", medium: "qr", qr: true },
  { id: "venue", label: "Venue's website / listing", source: "venue", medium: "referral" },
  { id: "other", label: "Other", source: "other", medium: "referral" },
];

/** "The DeLuxe, Nov 8!" -> "the-deluxe-nov-8". Lowercase ASCII, hyphens, at most 60 characters. */
export function slugify(s: string): string {
  return s
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

export interface LinkInput { path: string; name: string; channel: string; content?: string; base?: string }

/** The tagged URL, or null when there is not enough to build one. */
export function buildLink({ path, name, channel, content, base = SITE_URL }: LinkInput): string | null {
  const ch = CHANNELS.find((c) => c.id === channel);
  const campaign = slugify(name);
  if (!ch || !campaign) return null;
  const clean = "/" + (path || "/").replace(/^\/+/, "").replace(/[?#].*$/, "");
  const url = new URL(clean === "/" ? "/" : clean.replace(/\/+$/, ""), base);
  url.searchParams.set("utm_source", ch.id === "venue" ? campaign : ch.source);
  url.searchParams.set("utm_medium", ch.medium);
  url.searchParams.set("utm_campaign", campaign);
  const c = slugify(content ?? "");
  if (c) url.searchParams.set("utm_content", c);
  return url.toString();
}
