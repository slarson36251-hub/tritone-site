// Pure logic for the rehearsal planner (tests/rehearse.test.mjs): dates, blocked slots, ranking,
// and the Firestore REST shapes. No DOM, no fetch.

export type Answer = "yes" | "maybe" | "no";
export interface Slot { id: string; label: string; start: string; end: string }
export interface Block { date: string; start: string; end: string; label: string }
export interface Player { name: string; role?: string }
export interface PlanData {
  key: string;
  band: string;
  gig: string;
  from: string;
  to: string;
  roster: Player[];
  slots: Slot[];
  blocks: Block[];
  /** When the calendars were read (ISO), and which ones answered. */
  busyAt: string;
  sources: { gigs: boolean; hut: boolean };
}
export interface PlayerAnswers { name: string; answers: Record<string, Answer>; note: string; updatedAt?: string }

export const LIMITS = { name: 60, note: 280, answers: 600 } as const;
export const KEY_RE = /^[A-Za-z0-9]{24}$/;
export const ANSWER_KEY_RE = /^\d{4}-\d{2}-\d{2}_[a-z0-9-]{1,20}$/;

export const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
export const answerKey = (date: string, slotId: string) => `${date}_${slotId}`;
export const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};
export const NEXT: Record<string, Answer | undefined> = { "": "yes", yes: "maybe", maybe: "no", no: undefined };

/** Every date from..to inclusive, "YYYY-MM-DD" (pure calendar math, no time zone). */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let i = 0; d <= end && i < 400; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayParts(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  return { dow: DOW[d.getUTCDay()], md: `${MON[d.getUTCMonth()]} ${d.getUTCDate()}` };
}
export function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 && h < 24 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""}${ap}`;
}

/** The block a slot runs into, if any (any overlap counts). */
export function blockFor(blocks: Block[], date: string, slot: Slot): Block | undefined {
  const a = minutes(slot.start), b = minutes(slot.end);
  return blocks.find((k) => k.date === date && minutes(k.start) < b && minutes(k.end) > a);
}

/**
 * Busy intervals (absolute instants) -> Pacific wall-clock blocks, one per day touched.
 * `wall` turns an instant into {date, min}; injected so tests need no time-zone data.
 */
export function toBlocks(
  busy: { start: string; end: string }[],
  label: string,
  wall: (d: Date) => { date: string; min: number },
): Block[] {
  const out: Block[] = [];
  const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  for (const b of busy) {
    const s = wall(new Date(b.start)), e = wall(new Date(b.end));
    if (!s.date || !e.date) continue;
    if (s.date === e.date) {
      if (e.min > s.min) out.push({ date: s.date, start: hhmm(s.min), end: hhmm(e.min), label });
      continue;
    }
    const days = datesBetween(s.date, e.date);
    days.forEach((date, i) => {
      const from = i === 0 ? s.min : 0;
      const to = i === days.length - 1 ? e.min : 24 * 60;
      if (to > from) out.push({ date, start: hhmm(from), end: to === 1440 ? "24:00" : hhmm(to), label });
    });
  }
  return out;
}

export interface SlotStats { yes: string[]; maybe: string[]; no: string[]; waiting: string[] }
export function statsFor(roster: Player[], all: Record<string, PlayerAnswers>, date: string, slotId: string): SlotStats {
  const st: SlotStats = { yes: [], maybe: [], no: [], waiting: [] };
  const k = answerKey(date, slotId);
  for (const p of roster) {
    const v = all[slug(p.name)]?.answers?.[k];
    (v ? st[v] : st.waiting).push(p.name);
  }
  return st;
}

/** Open slots, best first: no "no", then most yes, then most maybe, then earliest. */
export function rank(plan: Pick<PlanData, "from" | "to" | "slots" | "blocks" | "roster">, all: Record<string, PlayerAnswers>) {
  const out: { date: string; slot: Slot; st: SlotStats }[] = [];
  datesBetween(plan.from, plan.to).forEach((date) =>
    plan.slots.forEach((slot) => {
      if (!blockFor(plan.blocks, date, slot)) out.push({ date, slot, st: statsFor(plan.roster, all, date, slot.id) });
    }),
  );
  const score = (x: SlotStats) => (x.no.length ? -1000 * x.no.length : 0) + x.yes.length * 2 + x.maybe.length;
  return out
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => score(b.st) - score(a.st) || b.st.yes.length - a.st.yes.length || a.i - b.i)
    .map(({ i, ...x }) => x);
}

/* ---------------------------------------------------------- Firestore REST ---------------------------------------------------------- */

export const PROJECT = "tritone-site";
export const DOC_PREFIX = `projects/${PROJECT}/databases/(default)/documents`;
export const FIRESTORE_DOCS = `https://firestore.googleapis.com/v1/${DOC_PREFIX}`;
const enc = encodeURIComponent;
export const answersListUrl = (key: string, apiKey: string, pageToken = "") =>
  `${FIRESTORE_DOCS}/rehearsals/${enc(key)}/answers?key=${enc(apiKey)}&pageSize=100${pageToken ? `&pageToken=${enc(pageToken)}` : ""}`;
export const commitUrl = (apiKey: string) => `${FIRESTORE_DOCS}:commit?key=${enc(apiKey)}`;

/** Keep only well-formed answers (and only for this plan's dates and slots, when given). */
export function cleanAnswers(raw: Record<string, unknown>, valid?: Set<string>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!ANSWER_KEY_RE.test(k) || (valid && !valid.has(k))) continue;
    if (v === "yes" || v === "maybe" || v === "no") out[k] = v;
  }
  return out;
}

/** One write: the player's whole document, stamped with the server time (rules check updatedAt == request.time). */
export function saveBody(key: string, member: string, data: PlayerAnswers) {
  const answers = cleanAnswers(data.answers);
  return {
    writes: [
      {
        update: {
          name: `${DOC_PREFIX}/rehearsals/${key}/answers/${member}`,
          fields: {
            name: { stringValue: data.name.slice(0, LIMITS.name) },
            note: { stringValue: (data.note ?? "").slice(0, LIMITS.note) },
            answers: { mapValue: { fields: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { stringValue: v }])) } },
          },
        },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
      },
    ],
  };
}

export function docToAnswers(doc: any, valid?: Set<string>): [string, PlayerAnswers] | null {
  const id = String(doc?.name ?? "").split("/").pop() ?? "";
  const f = doc?.fields;
  if (!id || !f) return null;
  const raw = Object.fromEntries(Object.entries(f.answers?.mapValue?.fields ?? {}).map(([k, v]: [string, any]) => [k, v?.stringValue]));
  return [
    id,
    {
      name: String(f.name?.stringValue ?? "").slice(0, LIMITS.name),
      note: String(f.note?.stringValue ?? "").slice(0, LIMITS.note),
      answers: cleanAnswers(raw, valid),
      updatedAt: f.updatedAt?.timestampValue,
    },
  ];
}
