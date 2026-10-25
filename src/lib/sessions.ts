// The session log (src/content/sessions/*.md), newest first, plus small display helpers.
import { getCollection, type CollectionEntry } from "astro:content";

export type Session = CollectionEntry<"sessions">;

export async function getSessions(): Promise<Session[]> {
  return (await getCollection("sessions")).sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The date on the tape label: "Aug 15 · 2026" (or the file's dateLabel). */
export const tapeDate = (s: Session) =>
  s.data.dateLabel ?? `${MON[s.data.date.getUTCMonth()]} ${s.data.date.getUTCDate()} · ${s.data.date.getUTCFullYear()}`;

/** The Markdown body as one plain line, for meta descriptions. */
export const summary = (s: Session) =>
  (s.body ?? "").replace(/[*_`#>\[\]]/g, "").replace(/\(https?:[^)]*\)/g, "").replace(/\s+/g, " ").trim();

/** View-transition name shared by a tape's cover on /sessions and the hero on /sessions/<id>. */
export const coverTransition = (id: string) => `session-cover-${id}`;
