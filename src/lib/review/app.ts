// The client review page (/review?k=<reviewKey>[&v=<versionId>]): player, waveform, markers,
// draft notes on the device, and "Send feedback". Contract: docs/mix-review-contract.md (v1.1).
// All text from Firestore (titles, other people's notes) goes into the page with textContent only.
import type { Draft, Note, Review, Version } from "./schema.ts";
import { LIMITS, REVIEW_KEY_RE, STATUS_LABEL, VERSION_ID_RE } from "./schema.ts";
import {
  assignLanes, barBeat, clamp, hasTempo, clipStart, fmtShort, fmtTime, frac, laneSections, moveRange, moveStart,
  nextMarkerTime, prevMarkerTime, round3, sectionIndexAt, sectionsOf, viewRange, xToTime, type Section,
} from "./music.ts";
import {
  ReviewError, cleanName, commitBody, commitSubmission, draftReady, getReview, listNotes, listVersions,
  noteExists, noteFromDraft, pickVersion, randomId, type ErrorKind,
} from "./firestore.ts";
import { fetchSigned, signMix, signVoice, streamBase, uploadVoice, type MediaKind } from "./stream.ts";
import { deleteVoice, getVoice, loadDrafts, loadName, planSend, putVoice, saveDrafts, saveName } from "./drafts.ts";
import { Dictation, VoiceRecorder, dictationCtor, isIOS, isSafari } from "./recorder.ts";
import { drawWave } from "./waveform.ts";
import { BufferPlayer, Sound, audioSession } from "./webaudio.ts";
import { DEMO_KEY, demoNotes, demoReview, demoVersions, demoWav } from "./demo.ts";

/* ------------------------------------------------------------- data access ------------------------------------------------------------- */

interface Api {
  review(): Promise<Review>;
  versions(): Promise<Version[]>;
  notes(): Promise<Note[]>;
  /** A signed stream URL for the mix (live), or the whole file (demo). */
  mix(version: string, kind: MediaKind): Promise<{ url: string } | { data: ArrayBuffer }>;
  /** A sent voice note's bytes (decoded and played with Web Audio). */
  voiceData(voiceId: string): Promise<ArrayBuffer>;
  uploadVoice(version: string, blob: Blob): Promise<string>;
  commit(body: ReturnType<typeof commitBody>): Promise<void>;
  noteExists(noteId: string): Promise<boolean>;
}

/** What the player needs from the mix: an <audio> element, or BufferPlayer in the demo. */
interface MixPlayer {
  currentTime: number;
  readonly paused: boolean;
  readonly readyState: number;
  readonly error: { code: number } | null;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, fn: () => void): void;
}

function liveApi(key: string, apiKey: string, stream: string): Api {
  return {
    review: () => getReview(key, apiKey),
    versions: () => listVersions(key, apiKey),
    notes: () => listNotes(key, apiKey),
    mix: async (v, kind) => ({ url: await signMix(stream, key, v, kind) }),
    voiceData: async (id) => fetchSigned(await signVoice(stream, key, id)),
    uploadVoice: (v, blob) => uploadVoice(stream, key, v, blob),
    commit: (body) => commitSubmission(apiKey, body),
    noteExists: (id) => noteExists(key, id, apiKey),
  };
}

function demoApi(): Api {
  const voices = new Map<string, Blob>();
  const sent: Note[] = demoNotes();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    review: async () => demoReview,
    versions: async () => demoVersions(),
    notes: async () => sent.slice(),
    mix: async () => ({ data: await demoWav().arrayBuffer() }),
    voiceData: async (id) => {
      const b = voices.get(id);
      if (!b) throw new ReviewError("server", "no demo voice");
      return b.arrayBuffer();
    },
    uploadVoice: async (_v, blob) => {
      await wait(400);
      const id = `${randomId(16)}.${blob.type.includes("mp4") ? "m4a" : "webm"}`;
      voices.set(id, blob);
      return id;
    },
    noteExists: async (id) => sent.some((n) => n.id === id),
    commit: async (body) => {
      await wait(500);
      if (sent.some((n) => n.id === body.writes[1]?.update.name.split("/").pop())) throw new ReviewError("exists", "already sent", 409);
      for (const w of body.writes.slice(1)) {
        const f = w.update.fields as Record<string, any>;
        const v = (k: string) => f[k]?.stringValue ?? Number(f[k]?.doubleValue ?? f[k]?.integerValue ?? 0);
        sent.push({
          id: w.update.name.split("/").pop()!, versionId: v("versionId"), t: v("t"), from: v("from"), section: v("section"),
          bar: v("bar"), beat: v("beat"), kind: v("kind"), text: v("text"), voiceId: v("voiceId"), voiceSec: v("voiceSec"),
          author: v("author"), createdAt: new Date().toISOString(), status: "open", submissionId: v("submissionId"), reply: "", transcript: "",
        });
      }
    },
  };
}

/* ------------------------------------------------------------- helpers ------------------------------------------------------------- */

const ICON = {
  play: '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  small: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',
  mic: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/></svg>',
  lines: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg>',
  pin: '<svg width="18" height="26" viewBox="0 0 18 26" aria-hidden="true"><path d="M9 25 L9 12" stroke="currentColor" stroke-width="2"/><rect x="1" y="1" width="16" height="12" rx="3" fill="currentColor"/></svg>',
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}
function btn(cls: string, text: string, onClick: (e: MouseEvent) => void, label?: string): HTMLButtonElement {
  const b = h("button", cls, text);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}
const isTextField = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ERROR_TEXT: Record<ErrorKind, { title: string; body: string }> = {
  inactive: {
    title: "This review link isn't active",
    body: "The link may have been mistyped, or the review has been closed. Check the link in your email, or reply to Scott for a fresh one.",
  },
  closed: {
    title: "This review link isn't active",
    body: "This review has been closed. Reply to Scott if you still have notes.",
  },
  offline: {
    title: "You're offline",
    body: "The mix couldn't be loaded because there's no connection. Check your signal or Wi-Fi and try again.",
  },
  config: {
    title: "Mix review isn't set up yet",
    body: "This part of the site isn't configured yet. Reply to Scott and he'll send the mix another way.",
  },
  exists: {
    title: "Something went wrong",
    body: "The review couldn't be loaded just now. Try again in a minute.",
  },
  server: {
    title: "Something went wrong",
    body: "The review couldn't be loaded just now. Try again in a minute.",
  },
};

/* ------------------------------------------------------------- the app ------------------------------------------------------------- */

type Drag =
  | { kind: "wave"; id: number; view: [number, number]; rect: DOMRect; wasPlaying: boolean }
  | { kind: "range"; id: number; draftId: string; mode: "move" | "start"; view: [number, number]; rect: DOMRect; x0: number; from0: number; t0: number; moved: boolean };

interface Composer {
  draftId: string | null;
  t: number;
  from: number;
  mode: "type" | "talk";
  recording: boolean;
  /** New recording made in this composer (not yet stored). */
  rec: { blob: Blob; sec: number } | null;
  /** The draft already has a stored recording. */
  stored: { sec: number } | null;
}

export class ReviewApp {
  root: HTMLElement;
  api!: Api;
  key = "";
  demo = false;
  review!: Review;
  versions: Version[] = [];
  version!: Version;
  sections: Section[] = [];
  notes: Note[] = [];
  drafts: Draft[] = [];
  name = "";
  ios = false;
  safari = false;

  /** The mix: the <audio> element streaming from the NAS, or a Web Audio player for the demo. */
  A!: MixPlayer;
  audioEl!: HTMLAudioElement;
  sound = new Sound();
  canvas!: HTMLCanvasElement;
  mediaKind: MediaKind = "aac";
  mediaTries = 0;
  wantPlay = false;
  pendingSeek: number | null = null;
  unlocked = false;
  zoom = false;
  loop: Section | null = null;
  clipEnd: number | null = null;
  afterClip: (() => void) | null = null;
  drag: Drag | null = null;
  dragT: number | null = null;
  activeDraft: string | null = null;
  composer: Composer | null = null;
  recorder = new VoiceRecorder();
  dictation: Dictation | null = null;
  sending = false;
  justSent = 0;
  /** Decoded voice notes by key ("draft:<id>:<updated>", "voice:<voiceId>"). */
  voiceBufs = new Map<string, AudioBuffer>();
  /** Recordings sent in this visit, so they play back without a round trip. */
  sentBlobs = new Map<string, Blob>();
  lastFrame = { t: -1, view: "", sec: -1, w: 0 };
  laneKey = "";
  raf = 0;
  lastNotesFetch = 0;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  el<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`) ?? (document.getElementById(id) as T);
  }

  /* ---------------- boot ---------------- */

  async start() {
    const p = new URLSearchParams(location.search);
    this.ios = isIOS(navigator.userAgent, navigator.maxTouchPoints || 0);
    this.safari = isSafari(navigator.userAgent);
    this.demo = p.get("demo") === "1";
    this.audioEl = this.el<HTMLAudioElement>("rv-audio");
    this.A = this.audioEl;
    this.canvas = this.el<HTMLCanvasElement>("rv-canvas");
    this.name = cleanName(loadName());

    let env: Record<string, string | undefined> = {};
    try {
      env = (import.meta as any).env ?? {};
    } catch {
      env = {};
    }
    const apiKey = String(env.PUBLIC_FEEDBACK_API_KEY ?? "").trim();
    const stream = streamBase(env.PUBLIC_REVIEW_STREAM_URL);

    if (this.demo) {
      this.key = DEMO_KEY;
      this.api = demoApi();
      this.A = new BufferPlayer(this.sound) as unknown as MixPlayer;
      this.el("rv-demo").hidden = false;
    } else {
      this.key = p.get("k") ?? "";
      if (!REVIEW_KEY_RE.test(this.key)) return this.fail("inactive");
      if (!apiKey || !stream) return this.fail("config");
      this.api = liveApi(this.key, apiKey, stream);
    }
    this.wireStatic();
    await this.load(p.get("v"));
  }

  async load(wantedVersion: string | null) {
    this.setState("loading");
    try {
      const [review, versions] = await Promise.all([this.api.review(), this.api.versions()]);
      this.review = review;
      this.versions = versions;
      const v = pickVersion(versions, wantedVersion && VERSION_ID_RE.test(wantedVersion) ? wantedVersion : null, review.latestVersion);
      if (!v) return this.fail("inactive");
      this.drafts = loadDrafts(this.key);
      this.renderTitle();
      this.setVersion(v, false);
      this.setState("ready");
      if (!this.name) this.askName();
      this.refreshNotes();
      this.loop1();
    } catch (e) {
      this.fail(e instanceof ReviewError ? e.kind : "server");
    }
  }

  setState(s: "loading" | "ready" | "error") {
    this.root.dataset.state = s;
  }

  fail(kind: ErrorKind) {
    const t = ERROR_TEXT[kind] ?? ERROR_TEXT.server;
    this.el("rv-err-title").textContent = t.title;
    this.el("rv-err-body").textContent = t.body;
    const retry = this.el<HTMLButtonElement>("rv-err-retry");
    retry.hidden = !(kind === "offline" || kind === "server");
    this.setState("error");
    this.el("rv-name-btn").hidden = true;
    document.title = `${t.title} · Tritone Productions`;
  }

  async refreshNotes() {
    try {
      const notes = await this.api.notes();
      this.lastNotesFetch = Date.now();
      // Keep anything just sent that the list doesn't show yet.
      const ids = new Set(notes.map((n) => n.id));
      this.notes = [...notes, ...this.notes.filter((n) => !ids.has(n.id) && n.createdAt.startsWith("local:"))].sort((a, b) => a.t - b.t);
      this.renderSent();
      this.renderLane(true);
    } catch (e) {
      if (e instanceof ReviewError && e.kind === "inactive") this.fail("closed");
    }
  }

  /* ---------------- version + audio ---------------- */

  setVersion(v: Version, keepTime: boolean) {
    this.pause();
    this.version = v;
    this.sections = sectionsOf(v.markers, v.durationSec);
    this.loop = null;
    this.clipEnd = null;
    this.closeComposer();
    const sel = this.el<HTMLSelectElement>("rv-version");
    const pill = this.el("rv-version-pill");
    if (this.versions.length > 1) {
      sel.replaceChildren(...this.versions.map((x) => {
        const o = h("option", "", x.label);
        o.value = x.id;
        return o;
      }));
      sel.value = v.id;
      sel.parentElement!.hidden = false;
      pill.hidden = true;
    } else {
      pill.textContent = v.label;
      pill.hidden = false;
      sel.parentElement!.hidden = true;
    }
    this.el("rv-total").textContent = `of ${fmtTime(v.durationSec)}`;
    this.el("rv-bb").hidden = !hasTempo(v);
    this.renderMarkers();
    this.renderDrafts();
    this.renderSent();
    this.renderLane(true);
    this.renderTransport();
    this.mediaKind = "aac";
    this.mediaTries = 0;
    this.loadMedia(keepTime ? this.now() : 0);
  }

  async loadMedia(at: number): Promise<void> {
    this.playerMsg("");
    try {
      const m = await this.api.mix(this.version.id, this.mediaKind);
      this.pendingSeek = at;
      if ("url" in m) {
        this.audioEl.src = m.url;
        this.audioEl.load();
      } else await (this.A as unknown as BufferPlayer).load(m.data);
    } catch (e) {
      if (this.mediaKind === "aac" && !(e instanceof ReviewError && e.kind === "offline")) {
        this.mediaKind = "wav";
        return this.loadMedia(at);
      }
      this.playerMsg(e instanceof ReviewError && e.kind === "offline"
        ? "You're offline, so the mix can't play. It will work again once you're back online."
        : e instanceof ReviewError && e.kind === "inactive"
          ? "The mix isn't available on this link any more."
          : "The mix couldn't be loaded. Try again in a minute.", true);
    }
  }

  onMediaError() {
    // AAC not playable here, or the 6-hour signed link expired: sign again (WAV as the fallback).
    if (this.mediaTries >= 3) return this.playerMsg("This browser couldn't play the mix. Try Safari or Chrome.", true);
    this.mediaTries++;
    if (this.mediaKind === "aac" && this.A.error?.code === 4) this.mediaKind = "wav";
    this.loadMedia(this.now());
  }

  playerMsg(text: string, error = false) {
    const m = this.el("rv-player-msg");
    m.textContent = text;
    m.classList.toggle("rv-error", error);
  }

  now(): number {
    if (this.dragT !== null) return this.dragT;
    if (this.pendingSeek !== null) return this.pendingSeek;
    return this.A.currentTime || 0;
  }

  /** Bar · Beat only when the version has a tempo (bpm > 0). */
  get hasBars(): boolean {
    return !!this.version && hasTempo(this.version);
  }

  get duration() {
    return this.version?.durationSec ?? 0;
  }

  seek(t: number, play = false) {
    const v = clamp(t, 0, Math.max(0, this.duration - 0.05));
    if (this.A.readyState >= 1) {
      try {
        this.A.currentTime = v;
        this.pendingSeek = null;
      } catch {
        this.pendingSeek = v;
      }
    } else this.pendingSeek = v;
    if (play) this.play();
    this.frame(true);
  }

  play() {
    this.stopVoice();
    this.wantPlay = true;
    const p = this.A.play();
    if (p) p.catch((e) => {
      this.wantPlay = false;
      if (e?.name === "NotAllowedError") this.playerMsg("Tap play to start the music.");
      this.renderTransport();
    });
    this.renderTransport();
  }

  pause() {
    this.wantPlay = false;
    this.clipEnd = null;
    this.afterClip = null;
    try {
      this.A.pause();
    } catch {
      /* not loaded */
    }
    this.renderTransport();
  }

  get playing() {
    return this.wantPlay && !this.A.paused;
  }

  /** Plays [from, to] of the mix, then `after` (a voice note) if given. */
  playClip(from: number, to: number, after: (() => void) | null) {
    this.seek(from);
    this.clipEnd = to;
    this.afterClip = after;
    this.wantPlay = true;
    this.stopVoice();
    const p = this.A.play();
    if (p) p.catch(() => {
      this.wantPlay = false;
      this.clipEnd = null;
      this.renderTransport();
    });
    this.renderTransport();
  }

  /** Decode (once) and play a voice note with Web Audio. */
  async playVoice(key: string, load: () => Promise<ArrayBuffer | null>) {
    this.pause();
    try {
      let buf = this.voiceBufs.get(key);
      if (!buf) {
        const data = await load();
        if (!data) throw new Error("missing");
        buf = await this.sound.decode(data);
        this.voiceBufs.set(key, buf);
      }
      this.sound.play(buf);
    } catch (e) {
      this.playerMsg(e instanceof ReviewError && e.kind === "offline"
        ? "You're offline, so that voice note can't play right now."
        : "That voice note couldn't be played. Try again in a minute.", true);
    }
  }

  stopVoice() {
    this.sound.stop();
  }

  /** iOS only lets audio start from a tap: prime the mix player and Web Audio on the first touch. */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.sound.unlock();
    const a = this.audioEl;
    if (this.A !== a || !a.src || !a.paused) return;
    a.muted = true;
    const p = a.play();
    const restore = () => {
      if (!this.wantPlay) a.pause();
      a.muted = false;
    };
    if (p) p.then(restore, () => (a.muted = false));
    else restore();
  }

  /* ---------------- per-frame ---------------- */

  loop1() {
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.tick();
    };
    cancelAnimationFrame(this.raf);
    tick();
  }

  tick() {
    if (!this.version) return;
    const t = this.A.currentTime || 0;
    if (this.playing && this.drag?.kind !== "wave") {
      if (this.clipEnd !== null && t >= this.clipEnd) {
        const after = this.afterClip;
        this.pause();
        after?.();
      } else if (this.loop && !this.clipEnd && !this.composer?.recording && t >= this.loop.end - 0.02) {
        this.A.currentTime = this.loop.start;
      }
    }
    if (this.composer?.recording) {
      const sec = this.recorder.elapsed;
      if (sec >= LIMITS.voiceSec) this.stopRecording();
      else this.renderRecStatus();
    }
    this.frame(false);
  }

  view(): [number, number] {
    return viewRange(this.sections, this.duration, this.now(), this.zoom, this.loop);
  }

  frame(force: boolean) {
    if (!this.version) return;
    const t = this.now();
    const v = this.drag ? this.drag.view : this.view();
    const vk = `${v[0]}|${v[1]}`;
    const w = this.canvas.clientWidth;
    if (!force && Math.abs(t - this.lastFrame.t) < 0.02 && vk === this.lastFrame.view && w === this.lastFrame.w) return;
    const viewChanged = vk !== this.lastFrame.view || w !== this.lastFrame.w;
    this.lastFrame = { ...this.lastFrame, t, view: vk, w };

    const si = sectionIndexAt(this.sections, t);
    const sec = this.sections[si];
    const { bar, beat } = barBeat(t, this.version);
    const bars = this.hasBars;
    this.setText("rv-now", fmtTime(t));
    this.setText("rv-sec", sec?.name || "—");
    this.setText("rv-bb", bars ? `Bar ${bar} · Beat ${beat}` : "");
    this.setText("rv-capture-time", fmtTime(t));
    if (si !== this.lastFrame.sec) {
      this.lastFrame.sec = si;
      this.markActiveSection(si);
      this.renderTransport();
    }

    const f = clamp(frac(t, v), 0, 1);
    const head = this.el("rv-playhead");
    head.style.left = `${f * 100}%`;
    const wave = this.el("rv-wave");
    wave.setAttribute("aria-valuenow", t.toFixed(1));
    wave.setAttribute("aria-valuetext", `${fmtTime(t)}${sec?.name ? ", " + sec.name : ""}${bars ? `, bar ${bar}` : ""}`);
    if (this.drag?.kind === "wave") {
      const b = this.el("rv-bubble");
      b.textContent = [fmtTime(t), sec?.name, bars ? `Bar ${bar}` : ""].filter(Boolean).join(" · ");
      b.style.left = `${clamp(f * 100, 14, 86)}%`;
    }

    drawWave(this.canvas, {
      peaks: this.version.peaks,
      duration: this.duration,
      view: v,
      t,
      markers: this.sections.map((s) => s.start).filter((x) => x > 0),
      loop: this.loop ? [this.loop.start, this.loop.end] : null,
      ranges: this.versionDrafts().map((d) => ({ from: d.from, t: d.t, active: d.id === this.activeDraft || d.id === this.composer?.draftId })),
    });
    if (viewChanged) {
      this.renderTicks(v);
      this.renderLane(false);
    }
  }

  setText(id: string, text: string) {
    const n = this.el(id);
    if (n && n.textContent !== text) n.textContent = text;
  }

  /* ---------------- static wiring ---------------- */

  wireStatic() {
    const on = (id: string, f: (e: MouseEvent) => void) => this.el(id).addEventListener("click", f);
    document.addEventListener("pointerdown", () => this.unlock(), { capture: true, once: true });
    document.addEventListener("keydown", () => this.unlock(), { capture: true, once: true });

    this.A.addEventListener("loadedmetadata", () => {
      // A (re)signed link worked: a tab left open for days keeps re-signing after every 6 h expiry.
      this.mediaTries = 0;
      if (this.pendingSeek !== null) {
        const t = this.pendingSeek;
        try {
          this.A.currentTime = t;
        } catch {
          /* retried on play */
        }
        this.pendingSeek = null;
      }
      this.frame(true);
    });
    this.A.addEventListener("error", () => this.onMediaError());
    for (const ev of ["play", "pause", "ended", "waiting", "playing"]) this.A.addEventListener(ev, () => {
      if (ev === "ended") this.wantPlay = false;
      if (ev === "play" && this.A.muted && this.wantPlay) this.A.muted = false;
      this.renderTransport();
    });

    on("rv-err-retry", () => location.reload());
    on("rv-play", () => (this.playing ? this.pause() : this.play()));
    on("rv-back5", () => this.seek(this.now() - 5));
    on("rv-back1", () => this.seek(this.now() - 1));
    on("rv-fwd1", () => this.seek(this.now() + 1));
    on("rv-fwd5", () => this.seek(this.now() + 5));
    on("rv-replay", () => this.replay());
    on("rv-loop", () => this.toggleLoop());
    on("rv-zoom", () => this.toggleZoom());
    on("rv-prev", () => this.seek(prevMarkerTime(this.sections, this.now())));
    on("rv-next", () => {
      const n = nextMarkerTime(this.sections, this.now());
      if (n !== null) this.seek(n);
    });
    on("rv-capture", () => this.capture());
    on("rv-name-btn", () => this.askName());
    on("rv-send", () => this.send());
    on("rv-send-bar-btn", () => this.send());
    this.el<HTMLSelectElement>("rv-version").addEventListener("change", (e) => {
      const v = this.versions.find((x) => x.id === (e.target as HTMLSelectElement).value);
      if (v) this.setVersion(v, false);
    });

    // Composer
    on("rv-c-type", () => this.setMode("type"));
    on("rv-c-talk", () => this.setMode("talk"));
    on("rv-c-rec", () => (this.composer?.recording ? this.stopRecording() : this.startRecording()));
    on("rv-c-listen", () => this.listenComposer());
    on("rv-c-save", () => this.saveComposer());
    on("rv-c-cancel", () => this.closeComposer());
    on("rv-c-delete", () => this.composer?.draftId && this.deleteDraft(this.composer.draftId));
    for (const [id, dt, which] of [["rv-c-from-minus", -0.5, "from"], ["rv-c-from-plus", 0.5, "from"], ["rv-c-t-minus", -0.5, "t"], ["rv-c-t-plus", 0.5, "t"]] as const)
      on(id, () => this.nudgeComposer(which, dt));
    this.el<HTMLTextAreaElement>("rv-c-text").addEventListener("input", () => this.renderComposerButtons());

    // Name dialog
    const dlg = this.el<HTMLDialogElement>("rv-name-dlg");
    this.el<HTMLFormElement>("rv-name-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = cleanName(this.el<HTMLInputElement>("rv-name-input").value);
      if (!v) return this.el<HTMLInputElement>("rv-name-input").focus();
      this.name = v;
      saveName(v);
      this.renderName();
      dlg.close();
      const next = this.afterName;
      this.afterName = null;
      next?.();
    });
    on("rv-name-later", () => dlg.close());

    this.wireWave();
    this.wireLane();
    document.addEventListener("keydown", (e) => this.onKey(e));
    new ResizeObserver(() => {
      this.frame(true);
      this.renderLane(true);
    }).observe(this.el("rv-wave"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - this.lastNotesFetch > 60_000 && this.root.dataset.state === "ready") this.refreshNotes();
      if (document.visibilityState === "hidden" && this.composer?.recording) this.stopRecording();
    });
    window.addEventListener("pagehide", () => this.recorder.close());
    this.renderName();
  }

  afterName: (() => void) | null = null;

  askName(then?: () => void) {
    this.afterName = then ?? null;
    const dlg = this.el<HTMLDialogElement>("rv-name-dlg");
    const input = this.el<HTMLInputElement>("rv-name-input");
    input.value = this.name;
    if (!dlg.open) dlg.showModal();
    input.focus();
  }

  renderName() {
    const b = this.el("rv-name-btn");
    this.el("rv-name-initial").textContent = (this.name || "?").slice(0, 1).toUpperCase();
    this.el("rv-name-text").textContent = this.name || "Add your name";
    b.setAttribute("aria-label", this.name ? `Your name: ${this.name}. Change it` : "Add your name");
  }

  /* ---------------- waveform pointer + keyboard ---------------- */

  wireWave() {
    const wave = this.el("rv-wave");
    wave.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const rect = wave.getBoundingClientRect();
      const view = this.view();
      try {
        wave.setPointerCapture(e.pointerId);
      } catch {
        /* older Safari */
      }
      this.drag = { kind: "wave", id: e.pointerId, view, rect, wasPlaying: this.playing };
      this.dragT = xToTime(e.clientX - rect.left, rect.width, view, this.duration);
      this.root.classList.add("rv-dragging");
      this.frame(true);
    });
    wave.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (d?.kind !== "wave" || d.id !== e.pointerId) return;
      this.dragT = xToTime(e.clientX - d.rect.left, d.rect.width, d.view, this.duration);
      this.frame(true);
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (d?.kind !== "wave" || d.id !== e.pointerId) return;
      const t = this.dragT ?? this.now();
      this.drag = null;
      this.dragT = null;
      this.root.classList.remove("rv-dragging");
      this.clipEnd = null;
      this.seek(t);
    };
    wave.addEventListener("pointerup", end);
    wave.addEventListener("pointercancel", end);
    wave.addEventListener("keydown", (e) => {
      if (e.key === "Home") this.seek(0);
      else if (e.key === "End") this.seek(this.duration);
      else if (e.key === "PageUp") this.seek(this.now() + 10);
      else if (e.key === "PageDown") this.seek(this.now() - 10);
      else if (e.key === "ArrowUp") this.seek(this.now() + 1);
      else if (e.key === "ArrowDown") this.seek(this.now() - 1);
      else return;
      e.preventDefault();
    });
  }

  onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || isTextField(e.target)) return;
    if (this.root.dataset.state !== "ready" || this.el<HTMLDialogElement>("rv-name-dlg").open) return;
    const t = e.target as HTMLElement | null;
    const onButton = !!t?.closest?.("button, a, summary, [role=button]");
    const k = e.key;
    if (k === " " || k === "Spacebar") {
      if (onButton) return; // Space presses the focused button
      e.preventDefault();
      this.playing ? this.pause() : this.play();
    } else if (k === "ArrowLeft" || k === "ArrowRight") {
      e.preventDefault();
      this.seek(this.now() + (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1));
    } else if (k === "r" || k === "R") this.replay();
    else if (k === "l" || k === "L") this.toggleLoop();
    else if (k === "n" || k === "N") {
      e.preventDefault();
      this.capture();
    }
  }

  replay() {
    this.clipEnd = null;
    this.seek(this.now() - 5, true);
  }

  toggleLoop() {
    if (this.loop) this.loop = null;
    else this.loop = this.sections[sectionIndexAt(this.sections, this.now())] ?? null;
    this.renderTransport();
    this.frame(true);
  }

  toggleZoom() {
    this.zoom = !this.zoom;
    const b = this.el("rv-zoom");
    b.setAttribute("aria-pressed", String(this.zoom));
    this.el("rv-zoom-label").textContent = this.zoom ? "Whole song" : "Zoom to section";
    this.frame(true);
    this.renderLane(true);
  }

  /* ---------------- render: markers, ticks, transport ---------------- */

  renderMarkers() {
    const nav = this.el("rv-markers");
    const lane = laneSections(this.sections);
    nav.hidden = !lane.length;
    nav.replaceChildren(...lane.map((s) => {
      const b = btn("rv-marker", s.name, () => this.seek(s.start), `${s.name}, ${fmtTime(s.start)}`);
      b.title = `${s.name} · ${fmtTime(s.start)}`;
      b.dataset.start = String(s.start);
      b.style.flexGrow = String(Math.max(1, s.end - s.start));
      b.setAttribute("aria-pressed", "false");
      return b;
    }));
    this.lastFrame.sec = -1;
  }

  markActiveSection(si: number) {
    const sec = this.sections[si];
    const nav = this.el("rv-markers");
    for (const b of nav.querySelectorAll<HTMLButtonElement>(".rv-marker")) {
      const on = !!sec && Number(b.dataset.start) === sec.start;
      b.setAttribute("aria-pressed", String(on));
      if (on && nav.scrollWidth > nav.clientWidth + 2) {
        const left = b.offsetLeft - nav.offsetLeft;
        if (left < nav.scrollLeft || left + b.offsetWidth > nav.scrollLeft + nav.clientWidth)
          nav.scrollTo({ left: Math.max(0, left - 24), behavior: "smooth" });
      }
    }
    const i = sectionIndexAt(this.sections, this.now());
    this.el<HTMLButtonElement>("rv-next").disabled = i + 1 >= this.sections.length;
  }

  renderTicks(v: [number, number]) {
    const ticks = this.el("rv-ticks");
    const out: HTMLSpanElement[] = [];
    for (let j = 0; j <= 4; j++) out.push(h("span", "", fmtShort(v[0] + (j * (v[1] - v[0])) / 4)));
    ticks.replaceChildren(...out);
  }

  renderTransport() {
    if (!this.A) return;
    const playing = this.playing;
    const b = this.el("rv-play");
    b.innerHTML = playing ? ICON.pause : ICON.play;
    b.setAttribute("aria-label", playing ? "Pause" : "Play");
    const loop = this.el("rv-loop");
    loop.setAttribute("aria-pressed", String(!!this.loop));
    this.el("rv-loop-label").textContent = this.loop ? `Looping ${this.loop.name || "section"}` : "Loop this section";
  }

  /* ---------------- drafts on the lane ---------------- */

  versionDrafts(): Draft[] {
    return this.drafts.filter((d) => d.versionId === this.version?.id).sort((a, b) => a.t - b.t);
  }

  versionNotes(): Note[] {
    return this.notes.filter((n) => n.versionId === this.version?.id);
  }

  draftNumber(id: string): number {
    return this.versionDrafts().findIndex((d) => d.id === id) + 1;
  }

  renderLane(force: boolean) {
    if (!this.version) return;
    const lane = this.el("rv-lane");
    const v = this.drag ? this.drag.view : this.view();
    const w = lane.clientWidth || 1;
    const drafts = this.versionDrafts();
    const notes = this.versionNotes();
    const key = `${v[0]}|${v[1]}|${w}|${JSON.stringify(drafts.map((d) => [d.id, d.from, d.t]))}|${notes.length}|${this.activeDraft}|${this.composer?.draftId ?? ""}`;
    if (!force && key === this.laneKey) return;
    this.laneKey = key;
    const px = (t: number) => frac(t, v) * w;
    const MIN = 44;
    const items = drafts
      .filter((d) => d.t >= v[0] && d.from <= v[1])
      .map((d) => ({ id: d.id, from: px(d.from), t: Math.max(px(d.t), px(d.from) + MIN) }));
    // While a range is dragged keep its row; everything else is re-stacked on drop.
    const { rows, count } = assignLanes(items, 4);
    const PIN = 30;
    const ROW = 48;
    lane.style.height = `${PIN + count * ROW}px`;
    const kids: HTMLElement[] = [];
    for (const n of notes) {
      if (n.t < v[0] || n.t > v[1]) continue;
      const b = btn("rv-pin", "", () => this.playNote(n), `Sent note at ${fmtTime(n.t)} by ${n.author}: play it`);
      b.innerHTML = ICON.pin;
      b.style.left = `${px(n.t)}px`;
      b.title = `${fmtTime(n.t)} · ${n.author}`;
      kids.push(b);
    }
    for (const it of items) {
      const d = drafts.find((x) => x.id === it.id)!;
      const n = this.draftNumber(d.id);
      const r = h("div", "rv-range");
      r.dataset.id = d.id;
      r.style.left = `${it.from}px`;
      r.style.width = `${it.t - it.from}px`;
      r.style.top = `${PIN + rows[it.id] * ROW + 2}px`;
      r.setAttribute("role", "button");
      r.setAttribute("tabindex", "0");
      r.setAttribute("aria-label", `Draft ${n}, ${fmtTime(d.from)} to ${fmtTime(d.t)}. Drag to move, drag the left edge to change where it starts. Enter to edit.`);
      if (d.id === this.activeDraft || d.id === this.composer?.draftId) r.classList.add("rv-range-active");
      if (!draftReady(d)) r.classList.add("rv-range-incomplete");
      const handle = h("span", "rv-range-start");
      handle.setAttribute("aria-hidden", "true");
      const true_ = h("span", "rv-range-true");
      true_.style.width = `${Math.max(2, px(d.t) - px(d.from))}px`;
      const label = h("span", "rv-range-label", String(n));
      r.append(handle, true_, label);
      kids.push(r);
    }
    lane.replaceChildren(...kids);
  }

  wireLane() {
    const lane = this.el("rv-lane");
    lane.addEventListener("pointerdown", (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>(".rv-range");
      if (!r || (e.button !== 0 && e.pointerType === "mouse")) return;
      const d = this.drafts.find((x) => x.id === r.dataset.id);
      if (!d) return;
      e.preventDefault();
      const rect = lane.getBoundingClientRect();
      const rr = r.getBoundingClientRect();
      const mode = e.clientX - rr.left < 22 ? "start" : "move";
      try {
        r.setPointerCapture(e.pointerId);
      } catch {
        /* older Safari */
      }
      this.drag = { kind: "range", id: e.pointerId, draftId: d.id, mode, view: this.view(), rect, x0: e.clientX, from0: d.from, t0: d.t, moved: false };
      this.activeDraft = d.id;
      r.classList.add("rv-range-active");
    });
    lane.addEventListener("pointermove", (e) => {
      const g = this.drag;
      if (g?.kind !== "range" || g.id !== e.pointerId) return;
      const dx = e.clientX - g.x0;
      if (!g.moved && Math.abs(dx) < 5) return;
      if (!g.moved) {
        g.moved = true;
        this.root.classList.add("rv-dragging-range");
      }
      const d = this.drafts.find((x) => x.id === g.draftId);
      if (!d) return;
      const secPerPx = (g.view[1] - g.view[0]) / g.rect.width;
      const next = g.mode === "move"
        ? moveRange(g.from0, g.t0, dx * secPerPx, this.duration)
        : moveStart(g.from0, g.t0, xToTime(e.clientX - g.rect.left, g.rect.width, g.view, this.duration));
      d.from = next.from;
      d.t = next.t;
      this.positionRange(d, g.view, g.rect.width);
      this.showRangeBubble(d, g.view);
      this.frame(true);
    });
    const end = (e: PointerEvent) => {
      const g = this.drag;
      if (g?.kind !== "range" || g.id !== e.pointerId) return;
      this.drag = null;
      this.root.classList.remove("rv-dragging-range");
      const d = this.drafts.find((x) => x.id === g.draftId);
      if (!d) return;
      if (g.moved && e.type === "pointerup") {
        d.updatedAt = Date.now();
        this.persist();
        if (this.composer?.draftId === d.id) {
          this.composer.from = d.from;
          this.composer.t = d.t;
          this.renderComposerHead();
        }
        this.renderDrafts();
      } else if (g.moved) {
        d.from = g.from0;
        d.t = g.t0;
      } else {
        this.editDraft(d.id);
      }
      this.renderLane(true);
      this.frame(true);
    };
    lane.addEventListener("pointerup", end);
    lane.addEventListener("pointercancel", end);
    lane.addEventListener("keydown", (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>(".rv-range");
      if (!r) return;
      const d = this.drafts.find((x) => x.id === r.dataset.id);
      if (!d) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        this.editDraft(d.id);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        const dt = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 0.5);
        Object.assign(d, moveRange(d.from, d.t, dt, this.duration), { updatedAt: Date.now() });
        this.persist();
        this.renderLane(true);
        this.renderDrafts();
        this.frame(true);
        this.el("rv-lane").querySelector<HTMLElement>(`.rv-range[data-id="${d.id}"]`)?.focus();
      }
    });
  }

  positionRange(d: Draft, v: [number, number], w: number) {
    const r = this.el("rv-lane").querySelector<HTMLElement>(`.rv-range[data-id="${d.id}"]`);
    if (!r) return;
    const px = (t: number) => frac(t, v) * w;
    r.style.left = `${px(d.from)}px`;
    r.style.width = `${Math.max(px(d.t) - px(d.from), 44)}px`;
    const tr = r.querySelector<HTMLElement>(".rv-range-true");
    if (tr) tr.style.width = `${Math.max(2, px(d.t) - px(d.from))}px`;
  }

  showRangeBubble(d: Draft, v: [number, number]) {
    const b = this.el("rv-bubble");
    const a = barBeat(d.from, this.version);
    const z = barBeat(d.t, this.version);
    b.textContent = `${fmtTime(d.from)} – ${fmtTime(d.t)}${this.hasBars ? ` · Bar ${a.bar}${z.bar !== a.bar ? `–${z.bar}` : ""}` : ""}`;
    b.style.left = `${clamp(frac((this.drag as any)?.mode === "start" ? d.from : (d.from + d.t) / 2, v) * 100, 14, 86)}%`;
  }

  /* ---------------- drafts list ---------------- */

  persist() {
    if (!saveDrafts(this.key, this.drafts)) this.sendMsg("This browser won't keep drafts after you close the page. Send them before you leave.", true);
  }

  renderDrafts() {
    const list = this.el("rv-drafts");
    const drafts = this.versionDrafts();
    const ready = drafts.filter(draftReady).length;
    this.el("rv-drafts-count").textContent = drafts.length ? `${plural(drafts.length, "draft")} · on this device` : "";
    this.el("rv-drafts-empty").hidden = drafts.length > 0;
    list.replaceChildren(...drafts.map((d, i) => this.draftCard(d, i + 1)));
    const sendBtn = this.el<HTMLButtonElement>("rv-send");
    sendBtn.hidden = drafts.length === 0;
    sendBtn.disabled = this.sending || ready === 0;
    sendBtn.textContent = this.sending ? "Sending…" : `Send feedback (${ready})`;
    const bar = this.el("rv-send-bar");
    bar.hidden = drafts.length === 0 && !this.sending;
    this.el("rv-send-bar-text").textContent = `${plural(drafts.length, "draft")} not sent yet`;
    const bb = this.el<HTMLButtonElement>("rv-send-bar-btn");
    bb.disabled = this.sending || ready === 0;
    bb.textContent = this.sending ? "Sending…" : "Send feedback";
    document.body.classList.toggle("rv-has-sendbar", !bar.hidden);
  }

  draftCard(d: Draft, n: number): HTMLElement {
    const a = h("article", "rv-card rv-draft");
    if (d.id === this.activeDraft || d.id === this.composer?.draftId) a.classList.add("rv-card-active");
    const top = h("div", "rv-card-top");
    const { bar, beat } = barBeat(d.t, this.version);
    const sec = this.sections[sectionIndexAt(this.sections, d.t)]?.name ?? "";
    const play = btn("rv-chip", "", () => this.listenDraft(d), `Listen to draft ${n}: ${fmtTime(d.from)} to ${fmtTime(d.t)}${d.kind === "voice" ? ", then your voice note" : ""}`);
    play.innerHTML = ICON.small;
    play.append(` ${fmtTime(d.from)} – ${fmtTime(d.t)}`);
    top.append(h("span", "rv-num", String(n)), play, h("span", "rv-sec", sec));
    if (this.hasBars) top.append(h("span", "rv-dim", `Bar ${bar} · ${beat}`));
    const body = h("div", "rv-card-body");
    const icon = h("span", "rv-icon");
    icon.innerHTML = d.kind === "voice" ? ICON.mic : ICON.lines;
    const txt = h("p", "rv-text");
    if (d.kind === "voice") txt.textContent = `Voice note, ${fmtShort(d.voiceSec)}${d.text.trim() ? ` · ${d.text.trim()}` : ""}${draftReady(d) ? "" : " (recording missing, record it again)"}`;
    else txt.textContent = d.text.trim() || "(no words yet)";
    body.append(icon, txt);
    const actions = h("div", "rv-card-actions");
    actions.append(
      btn("rv-btn rv-btn-small", "Edit", () => this.editDraft(d.id), `Edit draft ${n}`),
      this.deleteButton(d, n),
    );
    a.append(top, body, actions);
    return a;
  }

  deleteButton(d: Draft, n: number): HTMLButtonElement {
    let armed = false;
    let timer = 0;
    const b = btn("rv-btn rv-btn-small rv-btn-ghost", "Delete", () => {
      if (!armed) {
        armed = true;
        b.textContent = "Tap again to delete";
        timer = window.setTimeout(() => {
          armed = false;
          b.textContent = "Delete";
        }, 3000);
        return;
      }
      clearTimeout(timer);
      this.deleteDraft(d.id);
    }, `Delete draft ${n}`);
    return b;
  }

  async deleteDraft(id: string) {
    this.drafts = this.drafts.filter((d) => d.id !== id);
    if (this.composer?.draftId === id) this.closeComposer();
    if (this.activeDraft === id) this.activeDraft = null;
    this.persist();
    deleteVoice(this.key, id);
    this.renderDrafts();
    this.renderLane(true);
    this.frame(true);
  }

  async listenDraft(d: Draft) {
    this.activeDraft = d.id;
    this.renderLane(true);
    let after: (() => void) | null = null;
    if (d.kind === "voice" && d.hasVoice) {
      const blob = await getVoice(this.key, d.id);
      if (blob) after = () => this.playVoice(`draft:${d.id}:${d.updatedAt}`, () => blob.arrayBuffer());
    }
    this.playClip(d.from, d.t, after);
  }

  /* ---------------- sent notes ---------------- */

  renderSent() {
    if (!this.version) return;
    const list = this.el("rv-sent");
    const notes = this.versionNotes().sort((a, b) => a.t - b.t);
    const other = this.notes.length - notes.length;
    this.el("rv-sent-count").textContent = notes.length ? `${plural(notes.length, "note")} · in timeline order` : "";
    this.el("rv-sent-empty").hidden = notes.length > 0;
    this.el("rv-sent-other").textContent = other > 0 ? `${plural(other, "more note")} on other versions.` : "";
    list.replaceChildren(...notes.map((n) => this.noteCard(n)));
  }

  noteCard(n: Note): HTMLElement {
    const a = h("article", "rv-card rv-sentnote");
    const top = h("div", "rv-card-top");
    const play = btn("rv-chip", "", () => this.playNote(n), `Play from ${fmtTime(n.from)}${n.kind === "voice" ? ", then the voice note" : ""}`);
    play.innerHTML = ICON.small;
    play.append(` ${fmtTime(n.t)}`);
    top.append(play, h("span", "rv-sec", n.section));
    if (this.hasBars) top.append(h("span", "rv-dim", `Bar ${n.bar} · ${n.beat}`));
    const body = h("div", "rv-card-body");
    const icon = h("span", "rv-icon");
    icon.innerHTML = n.kind === "voice" ? ICON.mic : ICON.lines;
    const col = h("div", "rv-col");
    if (n.kind === "voice") {
      const vb = btn("rv-btn rv-btn-small", `Play voice note · ${fmtShort(n.voiceSec)}`, () => this.playNoteVoice(n), `Play ${n.author}'s voice note`);
      col.append(vb);
      const words = n.transcript || n.text;
      if (words) col.append(h("p", "rv-text", words));
    } else col.append(h("p", "rv-text", n.text));
    if (n.reply) {
      const r = h("p", "rv-reply");
      r.append(h("strong", "", "Scott: "), document.createTextNode(n.reply));
      col.append(r);
    }
    body.append(icon, col);
    const meta = h("div", "rv-meta", `${n.author} · ${STATUS_LABEL[n.status]}`);
    a.append(top, body, meta);
    return a;
  }

  voiceLoader(n: Note): () => Promise<ArrayBuffer> {
    return async () => {
      const local = this.sentBlobs.get(n.voiceId);
      return local ? local.arrayBuffer() : this.api.voiceData(n.voiceId);
    };
  }

  playNote(n: Note) {
    const after = n.kind === "voice" && n.voiceId ? () => this.playNoteVoice(n) : null;
    this.playClip(n.from, n.t, after);
  }

  playNoteVoice(n: Note) {
    return this.playVoice(`voice:${n.voiceId}`, this.voiceLoader(n));
  }

  /* ---------------- composer ---------------- */

  capture() {
    if (this.composer?.recording) return;
    const t = round3(this.now());
    this.pause();
    const from = round3(clipStart(t, this.loop && t >= this.loop.start ? this.loop.start : null));
    this.composer = { draftId: null, t, from, mode: "type", recording: false, rec: null, stored: null };
    this.el<HTMLTextAreaElement>("rv-c-text").value = "";
    this.openComposer();
    if (!this.name) this.askName();
  }

  editDraft(id: string) {
    const d = this.drafts.find((x) => x.id === id);
    if (!d || this.composer?.recording) return;
    this.pause();
    this.activeDraft = id;
    this.composer = {
      draftId: id, t: d.t, from: d.from, mode: d.kind === "voice" ? "talk" : "type", recording: false, rec: null,
      stored: d.kind === "voice" && d.hasVoice ? { sec: d.voiceSec } : null,
    };
    this.el<HTMLTextAreaElement>("rv-c-text").value = d.text;
    this.seek(d.from);
    this.openComposer();
  }

  openComposer() {
    const c = this.el("rv-composer");
    c.hidden = false;
    this.renderComposerHead();
    this.setMode(this.composer!.mode);
    this.el("rv-c-delete").hidden = !this.composer!.draftId;
    this.el("rv-c-save").textContent = this.composer!.draftId ? "Save changes" : "Save draft";
    this.composerMsg("");
    this.renderDrafts();
    this.renderLane(true);
    c.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  renderComposerHead() {
    const c = this.composer;
    if (!c) return;
    const { bar, beat } = barBeat(c.t, this.version);
    const sec = this.sections[sectionIndexAt(this.sections, c.t)]?.name;
    this.el("rv-c-title").textContent = `Note at ${fmtTime(c.t)}`;
    this.el("rv-c-where").textContent = [sec, this.hasBars ? `Bar ${bar} · Beat ${beat}` : ""].filter(Boolean).join(" · ");
    this.el("rv-c-from").textContent = fmtTime(c.from);
    this.el("rv-c-to").textContent = fmtTime(c.t);
  }

  nudgeComposer(which: "from" | "t", dt: number) {
    const c = this.composer;
    if (!c || c.recording) return;
    if (which === "from") c.from = round3(clamp(c.from + dt, 0, c.t));
    else c.t = round3(clamp(c.t + dt, c.from, this.duration));
    if (c.draftId) {
      const d = this.drafts.find((x) => x.id === c.draftId);
      if (d) {
        d.from = c.from;
        d.t = c.t;
        d.updatedAt = Date.now();
        this.persist();
        this.renderDrafts();
      }
    }
    this.renderComposerHead();
    this.renderLane(true);
    this.frame(true);
  }

  setMode(mode: "type" | "talk") {
    const c = this.composer;
    if (!c) return;
    if (c.recording) return;
    c.mode = mode;
    this.el("rv-c-type").setAttribute("aria-pressed", String(mode === "type"));
    this.el("rv-c-talk").setAttribute("aria-pressed", String(mode === "talk"));
    this.el("rv-c-talkpanel").hidden = mode !== "talk";
    this.el("rv-c-textlabel").textContent = mode === "talk" ? "Anything to add in writing? (optional)" : "What would you like changed here?";
    const supported = VoiceRecorder.supported();
    this.el<HTMLButtonElement>("rv-c-rec").disabled = !supported;
    if (mode === "talk" && !supported) this.composerMsg("This browser can't record. Type your note instead.", true);
    else this.composerMsg("");
    this.renderRecStatus();
    this.renderComposerButtons();
  }

  hasRecording(): boolean {
    const c = this.composer;
    return !!c && (!!c.rec || !!c.stored);
  }

  renderComposerButtons() {
    const c = this.composer;
    if (!c) return;
    const text = this.el<HTMLTextAreaElement>("rv-c-text").value.trim();
    const ok = !c.recording && (c.mode === "talk" ? this.hasRecording() : text.length > 0);
    this.el<HTMLButtonElement>("rv-c-save").disabled = !ok;
    this.el<HTMLButtonElement>("rv-c-cancel").disabled = c.recording;
  }

  renderRecStatus() {
    const c = this.composer;
    if (!c) return;
    const rec = this.el("rv-c-rec");
    const lbl = this.el("rv-c-rec-label");
    const st = this.el("rv-c-recstatus");
    rec.setAttribute("aria-pressed", String(c.recording));
    const has = this.hasRecording();
    lbl.textContent = c.recording ? "Stop recording" : has ? "Record again" : "Start talking";
    const sec = c.rec?.sec ?? c.stored?.sec ?? 0;
    const text = c.recording
      ? `Recording ${fmtShort(this.recorder.elapsed)} · music playing from ${fmtTime(c.from)}`
      : has
        ? `Voice note ${fmtShort(sec)} ready`
        : `The music restarts at ${fmtTime(c.from)} so you can talk over it.`;
    if (st.textContent !== text) st.textContent = text;
    this.el("rv-c-listen").hidden = !has || c.recording;
  }

  async startRecording() {
    const c = this.composer;
    if (!c || c.recording) return;
    this.composerMsg("");
    audioSession("play-and-record");
    const err = await this.recorder.open();
    if (err) {
      audioSession("auto");
      this.composerMsg(err === "denied"
        ? "The microphone is blocked. Allow it for this site in your browser settings, or type your note instead."
        : "The microphone couldn't start. Type your note instead, or try again.", true);
      return;
    }
    if (!this.recorder.start(this.safari || this.ios)) {
      this.recorder.close();
      audioSession("auto");
      this.composerMsg("Recording couldn't start. Try again.", true);
      return;
    }
    c.recording = true;
    this.root.classList.add("rv-recording");
    this.seek(c.from);
    this.clipEnd = null;
    this.play();
    const Ctor = dictationCtor(this.ios);
    if (Ctor) {
      const ta = this.el<HTMLTextAreaElement>("rv-c-text");
      const before = ta.value.trim();
      this.dictation = new Dictation(Ctor, (said) => {
        ta.value = [before, said].filter(Boolean).join(" ");
      });
      this.dictation.start();
    }
    this.renderRecStatus();
    this.renderComposerButtons();
  }

  async stopRecording() {
    const c = this.composer;
    if (!c || !c.recording) return;
    this.dictation?.stop();
    this.dictation = null;
    const r = await this.recorder.stop();
    this.recorder.close(); // mic off between takes (also restores normal playback on iPhone)
    audioSession("auto");
    this.pause();
    c.recording = false;
    this.root.classList.remove("rv-recording");
    if (r && r.sec >= 0.4) {
      if (r.blob.size > LIMITS.voiceBytes) this.composerMsg("That recording is too long to send. Keep voice notes under a few minutes.", true);
      else {
        c.rec = { blob: r.blob, sec: Math.min(r.sec, LIMITS.voiceSec) };
        c.stored = null;
      }
    } else this.composerMsg("Nothing was recorded. Try again, a little closer to the mic.", true);
    this.renderRecStatus();
    this.renderComposerButtons();
  }

  async listenComposer() {
    const c = this.composer;
    if (!c) return;
    let blob = c.rec?.blob ?? null;
    if (!blob && c.draftId) blob = await getVoice(this.key, c.draftId);
    if (blob) this.playVoice(`c:${c.draftId ?? "new"}:${blob.size}:${blob.type}`, () => blob!.arrayBuffer());
  }

  async saveComposer() {
    const c = this.composer;
    if (!c || c.recording) return;
    const text = this.el<HTMLTextAreaElement>("rv-c-text").value.trim().slice(0, LIMITS.text);
    const voice = c.mode === "talk" && this.hasRecording();
    if (!voice && !text) return;
    const now = Date.now();
    let d = c.draftId ? this.drafts.find((x) => x.id === c.draftId) : undefined;
    if (!d) {
      d = { id: randomId(20), versionId: this.version.id, t: c.t, from: c.from, kind: "text", text: "", voiceSec: 0, hasVoice: false, voiceType: "", voiceId: "", submissionId: "", noteId: "", createdAt: now, updatedAt: now };
      this.drafts.push(d);
    }
    d.t = c.t;
    d.from = c.from;
    d.text = text;
    d.updatedAt = now;
    if (voice) {
      d.kind = "voice";
      if (c.rec) {
        const kept = await putVoice(this.key, d.id, c.rec.blob);
        d.hasVoice = true;
        d.voiceSec = round3(c.rec.sec);
        d.voiceType = c.rec.blob.type;
        d.voiceId = ""; // a new take must be uploaded again
        if (!kept) this.sendMsg("This browser won't keep voice notes after you close the page. Send them before you leave.", true);
      }
    } else {
      if (d.hasVoice) deleteVoice(this.key, d.id);
      d.kind = "text";
      d.hasVoice = false;
      d.voiceSec = 0;
      d.voiceId = "";
      d.voiceType = "";
    }
    this.persist();
    this.activeDraft = d.id;
    this.closeComposer();
    this.justSent = 0;
    this.el("rv-sent-ok").hidden = true;
  }

  closeComposer() {
    if (this.composer?.recording) {
      this.dictation?.stop();
      this.recorder.stop().then(() => {
        this.recorder.close();
        audioSession("auto");
      });
      this.pause();
      this.root.classList.remove("rv-recording");
    }
    this.composer = null;
    const c = this.el("rv-composer");
    if (c) c.hidden = true;
    this.renderDrafts();
    this.renderLane(true);
    this.frame(true);
  }

  composerMsg(text: string, error = false) {
    const m = this.el("rv-c-msg");
    m.textContent = text;
    m.classList.toggle("rv-error", error);
  }

  /* ---------------- send ---------------- */

  sendMsg(text: string, error = false) {
    const m = this.el("rv-send-msg");
    m.textContent = text;
    m.classList.toggle("rv-error", error);
    m.hidden = !text;
  }

  async send() {
    if (this.sending) return;
    if (this.composer) {
      this.sendMsg("Save or cancel the note you're working on first.", true);
      this.el("rv-composer").scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    if (!this.name) return this.askName(() => this.send());
    const ready = this.versionDrafts().filter(draftReady);
    const plan = planSend(ready, () => randomId(20), LIMITS.notesPerSubmission);
    if (!plan) return this.sendMsg("Add a note first: words, or a voice note.", true);
    // Fix this round's ids on the device before anything leaves it, so a retry (after a timeout,
    // a lost answer or a reload) writes the very same documents instead of a second round.
    if (plan.fresh) {
      for (const { draft, noteId } of plan.notes) {
        draft.submissionId = plan.submissionId;
        draft.noteId = noteId;
      }
      this.persist();
    }
    const batch = plan.notes.map((n) => n.draft);
    this.sending = true;
    this.renderDrafts();
    this.sendMsg("Sending…");
    try {
      // 0. A retried round may already be in Firestore (the answer got lost): then it is sent.
      let landed = false;
      if (!plan.fresh) landed = await this.api.noteExists(plan.notes[0].noteId).catch(() => false);
      if (!landed) {
        // 1. Voice notes to the studio drive (ids kept on the draft, so a retry doesn't upload twice).
        const voices = batch.filter((d) => d.kind === "voice" && !d.voiceId);
        for (let i = 0; i < voices.length; i++) {
          const d = voices[i];
          this.sendMsg(`Uploading voice note ${i + 1} of ${voices.length}…`);
          const blob = await getVoice(this.key, d.id);
          if (!blob) {
            d.hasVoice = false;
            this.persist();
            throw new Error(`missing:${this.draftNumber(d.id)}`);
          }
          d.voiceId = await this.api.uploadVoice(this.version.id, blob);
          this.sentBlobs.set(d.voiceId, blob);
          this.persist();
        }
        // 2. One atomic commit: the submission and all its notes, create-only.
        this.sendMsg("Sending your notes…");
        try {
          await this.api.commit(commitBody(this.key, plan.submissionId, this.name, this.version.id,
            plan.notes.map(({ draft, noteId }) => ({ id: noteId, note: noteFromDraft(draft, this.version, this.name, plan.submissionId) }))));
        } catch (e) {
          // Already written by an earlier attempt: that round is sent.
          if (!(e instanceof ReviewError && e.kind === "exists")) throw e;
        }
      }
      this.sentRound(plan.submissionId, plan.notes);
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      if (m.startsWith("missing:")) this.sendMsg(`The recording for draft ${m.slice(8)} isn't on this device any more. Record it again or delete it, then send.`, true);
      else if (e instanceof ReviewError && e.kind === "offline") this.sendMsg("You're offline. Your drafts are safe on this device: send again when you're back online.", true);
      else if (e instanceof ReviewError && e.kind === "inactive") this.sendMsg("This review has been closed, so new notes can't be sent. Your drafts are still on this device; reply to Scott's email instead.", true);
      else if (e instanceof ReviewError && e.kind === "config") this.sendMsg("Sending isn't set up correctly on this site. Your drafts are safe on this device; reply to Scott's email so he can fix it.", true);
      else this.sendMsg("Sending didn't work just now. Your drafts are safe on this device: try again in a minute.", true);
    } finally {
      this.sending = false;
      this.renderDrafts();
    }
  }

  /** A round reached Firestore: its drafts leave the device and its notes join the sent list. */
  sentRound(submissionId: string, sent: { draft: Draft; noteId: string }[]) {
    const ids = new Set(sent.map((n) => n.draft.id));
    this.drafts = this.drafts.filter((d) => !ids.has(d.id));
    this.persist();
    for (const { draft } of sent) deleteVoice(this.key, draft.id);
    const stamp = `local:${new Date().toISOString()}`;
    const have = new Set(this.notes.map((n) => n.id));
    for (const { draft, noteId } of sent) {
      if (have.has(noteId)) continue;
      const note = noteFromDraft(draft, this.version, this.name, submissionId);
      this.notes.push({ ...note, id: noteId, createdAt: stamp, status: "open", reply: "", transcript: "" });
    }
    this.notes.sort((a, b) => a.t - b.t);
    this.activeDraft = null;
    this.justSent = sent.length;
    const left = this.versionDrafts().filter(draftReady).length;
    const ok = this.el("rv-sent-ok");
    this.el("rv-sent-ok-text").textContent = `${plural(sent.length, "note")} on ${this.version.label}.${left ? ` ${left} more still to send.` : ""} You can keep listening and send more any time.`;
    ok.hidden = false;
    this.sendMsg("");
    this.renderSent();
    this.renderLane(true);
    this.frame(true);
    ok.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => this.refreshNotes(), 1500);
  }

  /* ---------------- title ---------------- */

  renderTitle() {
    const r = this.review;
    this.el("rv-title").textContent = r.title;
    this.el("rv-artist").textContent = `${r.artist ? r.artist + " · " : ""}Mix review`;
    document.title = `${r.title} · Mix review · Tritone Productions`;
  }
}

export function initReview() {
  const root = document.getElementById("rv");
  if (!root || root.dataset.init === "1") return;
  root.dataset.init = "1";
  new ReviewApp(root).start();
}
