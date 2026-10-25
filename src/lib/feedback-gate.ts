// Gate for Scott's private beta-site feedback overlay (src/lib/feedback-overlay.ts).
// The overlay is never part of the public site: it only runs on the Firebase beta host
// (tritone-site.web.app) or one of its preview channels, and only after the visitor has opened
// a page with ?feedback=on. tritone-productions.com never loads it. Pure functions, no DOM,
// so tests/feedback.test.mjs can check them directly.

export const FEEDBACK_FLAG = "tritone:feedback";

const BETA_HOST = "tritone-site.web.app";
const PREVIEW_HOST = /^tritone-site--[a-z0-9-]+\.web\.app$/;

/** True only for the beta host and its preview channels. (Feedback.astro adds localhost in `astro dev` only.) */
export function feedbackHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === BETA_HOST || PREVIEW_HOST.test(host);
}

/** What ?feedback= asks for: "on", "off", or null (leave the stored flag as it is). */
export function feedbackParam(search: string): "on" | "off" | null {
  const v = new URLSearchParams(search).get("feedback")?.toLowerCase();
  return v === "on" || v === "off" ? v : null;
}

/** Firestore REST "create document" body; every field a string, trimmed to firestore.rules' limits. */
export function feedbackDoc(n: {
  page: string;
  selector: string;
  snippet: string;
  note: string;
  viewport: string;
  createdAt: string;
  ua: string;
}) {
  const s = (v: string, max: number) => ({ stringValue: String(v ?? "").slice(0, max) });
  return {
    fields: {
      page: s(n.page, 299),
      selector: s(n.selector, 599),
      snippet: s(n.snippet, 300),
      note: s(n.note.trim(), 7999),
      viewport: s(n.viewport, 39),
      createdAt: s(n.createdAt, 39),
      ua: s(n.ua, 290),
    },
  };
}

export const FEEDBACK_ENDPOINT =
  "https://firestore.googleapis.com/v1/projects/tritone-site/databases/(default)/documents/feedback";
