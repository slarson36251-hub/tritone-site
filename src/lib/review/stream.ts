// The NAS stream server (docs/mix-review-contract.md): sign a mix or voice note for playback, and
// upload a voice note. Base URL from PUBLIC_REVIEW_STREAM_URL. URL/body builders are pure (tests).
import { ReviewError } from "./firestore.ts";
import { FETCH_INIT } from "./schema.ts";

/** "https://stream.example.com/" -> "https://stream.example.com"; anything that isn't an http(s) origin -> "". */
export function streamBase(raw: string | undefined | null): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

export type MediaKind = "aac" | "wav";

export const signUrl = (base: string) => `${base}/v1/sign`;
export const signMixBody = (review: string, version: string, kind: MediaKind) => ({ review, version, kind });
export const signVoiceBody = (review: string, voiceId: string) => ({ review, voiceId, kind: "voice" as const });
export const voiceUploadUrl = (base: string, review: string, version: string) =>
  `${base}/v1/voice?review=${encodeURIComponent(review)}&version=${encodeURIComponent(version)}`;

/** The upload Content-Type the server accepts for a recorder mime type ("audio/webm;codecs=opus" -> "audio/webm"). */
export function uploadType(mime: string): "audio/webm" | "audio/mp4" | "audio/ogg" | "" {
  const m = String(mime || "").toLowerCase().split(";")[0].trim();
  if (m === "audio/webm" || m === "video/webm") return "audio/webm";
  if (m === "audio/mp4" || m === "audio/aac" || m === "audio/x-m4a" || m === "video/mp4") return "audio/mp4";
  if (m === "audio/ogg") return "audio/ogg";
  return "";
}

/** A signed URL must live on the stream server itself (never follow a URL to somewhere else). */
export function trustedSignedUrl(base: string, url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url, base);
    const b = new URL(base);
    return u.origin === b.origin && u.pathname.startsWith(`${b.pathname.replace(/\/$/, "")}/v1/m/`) ? u.href : "";
  } catch {
    return "";
  }
}

async function post(url: string, body: BodyInit, type: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body, headers: { "Content-Type": type }, ...FETCH_INIT });
  } catch {
    throw new ReviewError("offline", "stream network");
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.status === 403 || res.status === 404 || res.status === 410) throw new ReviewError("inactive", `stream ${res.status}`, res.status);
  if (!res.ok) throw new ReviewError("server", `stream ${res.status}`, res.status);
  return json;
}

export async function signMix(base: string, review: string, version: string, kind: MediaKind): Promise<string> {
  const j = await post(signUrl(base), JSON.stringify(signMixBody(review, version, kind)), "application/json");
  const url = trustedSignedUrl(base, j?.url);
  if (!url) throw new ReviewError("server", "bad signed url");
  return url;
}

export async function signVoice(base: string, review: string, voiceId: string): Promise<string> {
  const j = await post(signUrl(base), JSON.stringify(signVoiceBody(review, voiceId)), "application/json");
  const url = trustedSignedUrl(base, j?.url);
  if (!url) throw new ReviewError("server", "bad signed url");
  return url;
}

/** Download a voice note from its signed URL (played with Web Audio). */
export async function fetchSigned(url: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url, { ...FETCH_INIT });
  } catch {
    throw new ReviewError("offline", "stream network");
  }
  if (!res.ok) throw new ReviewError(res.status === 403 || res.status === 404 || res.status === 410 ? "inactive" : "server", `stream ${res.status}`, res.status);
  return res.arrayBuffer();
}

export async function uploadVoice(base: string, review: string, version: string, blob: Blob): Promise<string> {
  const type = uploadType(blob.type) || "audio/webm";
  const j = await post(voiceUploadUrl(base, review, version), blob, type);
  const id = typeof j?.voiceId === "string" ? j.voiceId : "";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new ReviewError("server", "bad voice id");
  return id;
}
