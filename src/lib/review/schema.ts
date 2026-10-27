// Mix Review data shapes (docs/mix-review-contract.md, v1.1). Shared by the client review page
// (src/pages/review.astro) and its tests. Pure: no DOM, no fetch.

export const PROJECT = "tritone-site";
export const FIRESTORE_DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
/** Document-name prefix used inside :commit writes. */
export const DOC_PREFIX = `projects/${PROJECT}/databases/(default)/documents`;

/** reviews/{reviewKey}: written by the publisher / admin; clients may only get it while open. */
export interface Review {
  key: string;
  title: string;
  artist: string;
  clients: string[];
  status: "open" | "closed";
  latestVersion: string;
}

export interface Marker {
  name: string;
  /** Seconds in the bounce, ascending. */
  t: number;
}

/** reviews/{key}/versions/{versionId} */
export interface Version {
  id: string;
  label: string;
  order: number;
  bounceName: string;
  durationSec: number;
  sampleRate: number;
  bpm: number;
  beatsPerBar: number;
  offsetSec: number;
  markers: Marker[];
  /** 1200 ints 0-255. */
  peaks: number[];
}

export type NoteKind = "text" | "voice";
export type NoteStatus = "open" | "doing" | "done";

/** reviews/{key}/notes/{noteId} as read back (client fields plus admin-only extras). */
export interface Note {
  id: string;
  versionId: string;
  t: number;
  from: number;
  section: string;
  bar: number;
  beat: number;
  kind: NoteKind;
  text: string;
  voiceId: string;
  voiceSec: number;
  author: string;
  createdAt: string;
  status: NoteStatus;
  submissionId: string;
  reply: string;
  transcript: string;
}

/** A note the client is still working on. Lives only on the device until "Send feedback". */
export interface Draft {
  id: string;
  versionId: string;
  t: number;
  from: number;
  kind: NoteKind;
  text: string;
  /** Length of the recording, 0 for text. The blob itself lives in IndexedDB. */
  voiceSec: number;
  hasVoice: boolean;
  voiceType: string;
  /** Set once the blob has been uploaded, so a retried send does not upload it twice. */
  voiceId: string;
  createdAt: number;
  updatedAt: number;
}

/** Exactly the keys a client may write on a note (firestore.rules checks keys().hasOnly / hasAll). */
export const NOTE_KEYS = [
  "versionId", "t", "from", "section", "bar", "beat", "kind", "text", "voiceId", "voiceSec",
  "author", "createdAt", "status", "submissionId",
] as const;

/** Exactly the keys a client may write on a submission. */
export const SUBMISSION_KEYS = ["author", "versionId", "noteCount", "createdAt", "status"] as const;

export const LIMITS = {
  versionId: 20,
  section: 80,
  text: 4000,
  voiceId: 64,
  voiceSec: 600,
  author: 60,
  submissionId: 40,
  maxT: 36000,
  maxBeat: 16,
  notesPerSubmission: 200,
  voiceBytes: 10 * 1024 * 1024,
} as const;

/** A share-link key: the contract makes 24 base62 characters; accept a little either side. */
export const REVIEW_KEY_RE = /^[A-Za-z0-9]{20,64}$/;
export const VERSION_ID_RE = /^[a-z0-9-]{1,20}$/;

export const STATUS_LABEL: Record<NoteStatus, string> = {
  open: "Sent",
  doing: "Scott is on it",
  done: "Done",
};
