// Voice capture for "Talk over the music": MediaRecorder on one microphone stream that is kept
// open for the visit once the client has allowed it (so later recordings start instantly, inside
// the tap, which iOS needs to start the music in the same gesture). Safari records audio/mp4,
// Chrome / Firefox audio/webm (opus).

/** Preferred container: mp4 first on Safari (its webm support is partial), webm elsewhere. */
export function pickMime(isSupported: (t: string) => boolean, safari: boolean): string {
  const mp4 = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"];
  const webm = ["audio/webm;codecs=opus", "audio/webm"];
  const order = safari ? [...mp4, ...webm, "audio/ogg;codecs=opus"] : [...webm, "audio/ogg;codecs=opus", ...mp4];
  for (const t of order) {
    try {
      if (isSupported(t)) return t;
    } catch {
      /* next */
    }
  }
  return "";
}

/** iPhone / iPad (iPadOS reports itself as a Mac with touch). */
export function isIOS(ua: string, maxTouchPoints: number): boolean {
  return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

export function isSafari(ua: string): boolean {
  return /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android)/.test(ua);
}

export type MicError = "denied" | "unsupported" | "failed";

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private started = 0;
  private done: ((b: { blob: Blob; sec: number } | null) => void) | null = null;
  mime = "";

  static supported(): boolean {
    return typeof window !== "undefined" && typeof (window as any).MediaRecorder === "function" && !!navigator.mediaDevices?.getUserMedia;
  }

  get hasStream(): boolean {
    return !!this.stream && this.stream.getAudioTracks().some((t) => t.readyState === "live");
  }

  get recording(): boolean {
    return this.rec?.state === "recording";
  }

  get elapsed(): number {
    return this.recording ? (performance.now() - this.started) / 1000 : 0;
  }

  /** Ask for the microphone (shows the permission prompt the first time). */
  async open(): Promise<MicError | null> {
    if (!VoiceRecorder.supported()) return "unsupported";
    if (this.hasStream) return null;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      return null;
    } catch (e: any) {
      const n = String(e?.name ?? "");
      return n === "NotAllowedError" || n === "SecurityError" ? "denied" : "failed";
    }
  }

  start(safari: boolean): boolean {
    if (!this.stream || this.recording) return false;
    const MR = (window as any).MediaRecorder as typeof MediaRecorder;
    this.mime = pickMime((t) => MR.isTypeSupported(t), safari);
    try {
      this.rec = new MR(this.stream, { ...(this.mime ? { mimeType: this.mime } : {}), audioBitsPerSecond: 64000 });
    } catch {
      this.rec = new MR(this.stream);
    }
    this.chunks = [];
    this.rec.addEventListener("dataavailable", (e: BlobEvent) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    });
    this.rec.addEventListener("stop", () => {
      const sec = (performance.now() - this.started) / 1000;
      const type = this.rec?.mimeType || this.mime || "audio/webm";
      const blob = this.chunks.length ? new Blob(this.chunks, { type: type.split(";")[0] }) : null;
      const cb = this.done;
      this.done = null;
      cb?.(blob && blob.size > 0 ? { blob, sec } : null);
    });
    this.started = performance.now();
    this.rec.start(1000);
    return true;
  }

  stop(): Promise<{ blob: Blob; sec: number } | null> {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === "inactive") return resolve(null);
      this.done = resolve;
      try {
        this.rec.stop();
      } catch {
        this.done = null;
        resolve(null);
      }
    });
  }

  /** Let the microphone go (page hidden, review sent): the OS mic indicator turns off. */
  close() {
    if (this.recording) this.rec?.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/* ------------------------------------------------------------- dictation ------------------------------------------------------------- */

type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

/**
 * Live dictation alongside a recording. Skipped on iOS: Safari's recogniser grabs the audio
 * session and fights MediaRecorder (and the music) there, so iPhone notes are voice-only.
 */
export function dictationCtor(ios: boolean): (new () => SR) | null {
  if (ios || typeof window === "undefined") return null;
  return ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null) as (new () => SR) | null;
}

export class Dictation {
  private r: SR | null = null;
  private text = "";
  private Ctor: new () => SR;
  private onText: (t: string) => void;
  constructor(Ctor: new () => SR, onText: (t: string) => void) {
    this.Ctor = Ctor;
    this.onText = onText;
  }

  start() {
    this.stop();
    this.text = "";
    try {
      const r = new this.Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.lang = navigator.language || "en-US";
      r.onresult = (e: any) => {
        let s = "";
        for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
        this.text = s.trim();
        this.onText(this.text);
      };
      r.onerror = () => {};
      r.onend = () => {
        if (this.r === r) this.r = null;
      };
      r.start();
      this.r = r;
    } catch {
      this.r = null;
    }
  }

  stop() {
    try {
      this.r?.stop();
    } catch {
      /* already stopped */
    }
    this.r = null;
  }
}
