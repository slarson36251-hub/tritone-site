// Web Audio for everything that isn't the streamed mix: voice notes (the client's own recordings and
// sent ones) and the demo tune. Decoding in memory means no blob: URLs (the site CSP allows media
// from 'self' and the stream server only), and once the AudioContext has been resumed inside a tap,
// iOS lets it play later without one (a voice note right after its clip, for example).

type Ctx = AudioContext;

function newContext(): Ctx | null {
  const C = (window as any).AudioContext || (window as any).webkitAudioContext;
  try {
    return C ? new C() : null;
  } catch {
    return null;
  }
}

/** Safari 17+: play through the ringer switch like media does ("playback"), or allow the mic. */
export function audioSession(type: "playback" | "play-and-record" | "auto") {
  try {
    const s = (navigator as any).audioSession;
    if (s && s.type !== type) s.type = type;
  } catch {
    /* not supported */
  }
}

export class Sound {
  ctx: Ctx | null = null;
  private src: AudioBufferSourceNode | null = null;
  private onEnd: (() => void) | null = null;

  /** Call from a tap: creates / resumes the context and plays one silent sample (the iOS unlock). */
  unlock() {
    if (!this.ctx) this.ctx = newContext();
    const c = this.ctx;
    if (!c) return;
    try {
      c.resume();
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
    } catch {
      /* ignore */
    }
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.ctx) this.ctx = newContext();
    const c = this.ctx;
    if (!c) throw new Error("no web audio");
    // The callback form also works on older Safari, where decodeAudioData returns no promise.
    return new Promise((resolve, reject) => {
      const p = c.decodeAudioData(data.slice(0), resolve, reject) as unknown as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });
  }

  get playing() {
    return !!this.src;
  }

  play(buf: AudioBuffer, onEnd?: () => void) {
    this.stop();
    const c = this.ctx;
    if (!c) return;
    audioSession("playback");
    c.resume();
    const s = c.createBufferSource();
    s.buffer = buf;
    s.connect(c.destination);
    s.onended = () => {
      if (this.src !== s) return;
      this.src = null;
      const f = this.onEnd;
      this.onEnd = null;
      f?.();
    };
    this.src = s;
    this.onEnd = onEnd ?? null;
    s.start(0);
  }

  stop() {
    const s = this.src;
    this.src = null;
    this.onEnd = null;
    try {
      s?.stop();
    } catch {
      /* already stopped */
    }
  }
}

/**
 * A decoded track that behaves like the subset of HTMLAudioElement the player uses
 * (currentTime, paused, readyState, muted, play/pause, media events). Used for the demo tune.
 */
export class BufferPlayer extends EventTarget {
  private sound: Sound;
  private buf: AudioBuffer | null = null;
  private node: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private offset = 0;
  private startedAt = 0;
  paused = true;
  readyState = 0;
  error: { code: number } | null = null;

  constructor(sound: Sound) {
    super();
    this.sound = sound;
  }

  async load(data: ArrayBuffer) {
    try {
      this.buf = await this.sound.decode(data);
      this.readyState = 4;
      this.dispatchEvent(new Event("loadedmetadata"));
    } catch {
      this.error = { code: 4 };
      this.dispatchEvent(new Event("error"));
    }
  }

  get duration() {
    return this.buf?.duration ?? NaN;
  }

  get currentTime(): number {
    const c = this.sound.ctx;
    if (this.paused || !c) return this.offset;
    return Math.min(this.duration, c.currentTime - this.startedAt);
  }

  set currentTime(v: number) {
    this.offset = Math.max(0, Math.min(v, this.duration || 0));
    if (!this.paused) this.startNode();
  }

  get muted() {
    return this.gain ? this.gain.gain.value === 0 : false;
  }

  set muted(m: boolean) {
    if (this.gain) this.gain.gain.value = m ? 0 : 1;
  }

  private startNode() {
    const c = this.sound.ctx;
    if (!c || !this.buf) return;
    this.stopNode();
    if (!this.gain) {
      this.gain = c.createGain();
      this.gain.connect(c.destination);
    }
    const n = c.createBufferSource();
    n.buffer = this.buf;
    n.connect(this.gain);
    n.onended = () => {
      if (this.node !== n) return;
      this.node = null;
      this.offset = this.duration;
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
      this.dispatchEvent(new Event("ended"));
    };
    this.node = n;
    this.startedAt = c.currentTime - this.offset;
    n.start(0, this.offset);
  }

  private stopNode() {
    const n = this.node;
    this.node = null;
    try {
      n?.stop();
    } catch {
      /* ignore */
    }
  }

  async play(): Promise<void> {
    if (!this.buf) throw new DOMException("not loaded", "NotSupportedError");
    if (!this.paused) return;
    this.sound.unlock();
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    this.paused = false;
    this.startNode();
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
  }

  pause() {
    if (this.paused) return;
    this.offset = this.currentTime;
    this.paused = true;
    this.stopNode();
    this.dispatchEvent(new Event("pause"));
  }
}
