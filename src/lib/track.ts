// First-party, cookieless visitor tracking for tritone-productions.com (contract: ./analytics-schema.ts).
//
// A visit is one full page load. With Astro's ClientRouter the JavaScript state survives page
// changes, so the visit id and where the visit came from live in memory only: no cookies, no
// localStorage / sessionStorage, nothing that identifies a person. Each page view ("pv") and each
// interest event ("ev") becomes one Firestore document in "hits", written with the public web API
// key through the REST `:commit` endpoint so the server stamps `t` with its own clock
// (firestore.rules requires t == request.time and the exact field list).
//
// The top half is pure and unit-tested (tests/track.test.mjs). The client below never throws.
import {
  FIRESTORE_DOCS,
  HITS_COLLECTION,
  SELF_FLAG,
  SOURCES,
  type EventName,
  type Source,
} from "./analytics-schema.ts";

/* ------------------------------------------------------------------ pure ------------------------------------------------------------------ */

export const SITE_HOSTS = ["tritone-productions.com", "www.tritone-productions.com"];

export const EVENTS: EventName[] = [
  "book_submit", "book_earlier", "show_click", "ticket_click", "calendar_add",
  "poster_click", "play", "free_track", "contact_click", "outbound",
];

/** Field length limits, mirrored in firestore.rules. */
export const LIMITS = {
  sid: 16, path: 200, ref: 100, us: 80, um: 80, uc: 80, ux: 80, land: 200, tz: 40, lang: 12, ev: 20, lbl: 120,
} as const;

export interface Attribution {
  src: Source;
  ref: string;
  us: string;
  um: string;
  uc: string;
  ux: string;
}

const AI_HOSTS = [
  "chatgpt.com", "chat.openai.com", "openai.com", "perplexity.ai", "claude.ai", "gemini.google.com",
  "bard.google.com", "aistudio.google.com", "notebooklm.google.com", "copilot.microsoft.com",
  "copilot.cloud.microsoft", "edgeservices.bing.com", "you.com", "phind.com", "poe.com", "meta.ai",
  "grok.com", "x.ai", "chat.deepseek.com", "deepseek.com", "chat.mistral.ai", "mistral.ai", "pi.ai",
  "character.ai", "duck.ai", "chat.qwen.ai", "kimi.com", "kimi.moonshot.cn", "huggingface.co",
  "hf.co", "manus.im", "felo.ai", "andisearch.com", "iask.ai", "komo.ai", "liner.com",
];
// utm_source values AI tools put on links (ChatGPT adds utm_source=chatgpt.com by itself).
const AI_UTM = /(chatgpt|openai|perplexity|claude|anthropic|gemini|bard|copilot|deepseek|mistral|grok|meta\.ai|phind|poe\b|you\.com|kagi assistant|\bai\b)/i;

const SEARCH_HOSTS = [
  "bing.com", "duckduckgo.com", "search.yahoo.com", "yahoo.com", "yahoo.co.jp", "ecosia.org",
  "search.brave.com", "startpage.com", "kagi.com", "baidu.com", "yandex.ru", "yandex.com", "ya.ru",
  "search.aol.com", "aol.com", "qwant.com", "seznam.cz", "naver.com", "sogou.com", "mojeek.com",
  "news.google.com", "search.naver.com", "ask.com", "dogpile.com", "presearch.com",
];
const SOCIAL_HOSTS = [
  "facebook.com", "fb.com", "fb.me", "messenger.com", "instagram.com", "t.co", "x.com", "twitter.com",
  "linkedin.com", "lnkd.in", "youtube.com", "youtu.be", "reddit.com", "redd.it", "tiktok.com",
  "threads.net", "threads.com", "bsky.app", "pinterest.com", "pin.it", "nextdoor.com",
  "mastodon.social", "mstdn.social", "fosstodon.org", "tumblr.com", "wa.me", "whatsapp.com",
  "discord.com", "snapchat.com", "quora.com", "vk.com", "weibo.com", "telegram.org", "t.me",
];
const EMAIL_HOSTS = [
  "mail.google.com", "inbox.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
  "mail.yahoo.com", "mail.aol.com", "mail.proton.me", "mail.protonmail.com", "app.fastmail.com",
  "mail.zoho.com", "webmail.",
];

const matches = (host: string, domain: string) =>
  domain.endsWith(".") ? host.startsWith(domain) : host === domain || host.endsWith("." + domain);
const isAny = (host: string, list: string[]) => list.some((d) => matches(host, d));

const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/** The referrer's hostname, lower case, without "www."; "" when missing or unparseable. */
export function referrerHost(referrerUrl: string): string {
  if (!referrerUrl) return "";
  try {
    const u = new URL(referrerUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "android-app:") return "";
    return u.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** Which bucket a referrer host belongs to (own host handled by the caller). */
export function hostSource(host: string): Source {
  if (!host) return "direct";
  if (isAny(host, AI_HOSTS)) return "ai";
  if (isAny(host, EMAIL_HOSTS)) return "email";
  // google.com, google.co.uk, google.com.au, ... but not docs.google.com, mail.google.com, etc.
  if (/^(www\.)?google(\.[a-z]{2,3}){1,2}$/.test(host)) return "search";
  if (/^(m\.|l\.|lm\.|web\.|mbasic\.)?facebook\./.test(host)) return "social";
  if (/^(www\.)?(pinterest|yandex|bing)\.[a-z.]+$/.test(host)) return /pinterest/.test(host) ? "social" : "search";
  if (/^([a-z0-9-]+\.)?mastodon\.[a-z.]+$/.test(host)) return "social";
  if (isAny(host, SEARCH_HOSTS)) return "search";
  if (isAny(host, SOCIAL_HOSTS)) return "social";
  // Android apps send android-app://com.google.android.gm etc.
  if (/^com\.google\.android\.gm/.test(host)) return "email";
  if (/^com\.google\.android\.googlequicksearchbox/.test(host)) return "search";
  if (/^com\.(facebook|instagram|twitter|linkedin|reddit|zhiliaoapp)/.test(host)) return "social";
  if (/^com\.openai\./.test(host)) return "ai";
  return "referral";
}

/**
 * Where a visit came from. UTM tags win (they are deliberate), then the referrer's host.
 * Only the referrer HOSTNAME is kept; nothing from its path or query.
 */
export function classifySource(referrerUrl: string, locationSearch: string, ownHost: string): Attribution {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(locationSearch || "");
  } catch {
    params = new URLSearchParams();
  }
  const us = clip(params.get("utm_source"), LIMITS.us).toLowerCase();
  const um = clip(params.get("utm_medium"), LIMITS.um).toLowerCase();
  const uc = clip(params.get("utm_campaign"), LIMITS.uc);
  const ux = clip(params.get("utm_content"), LIMITS.ux);

  const own = String(ownHost || "").toLowerCase().replace(/^www\./, "");
  let ref = referrerHost(referrerUrl);
  const internal = ref !== "" && (ref === own || SITE_HOSTS.includes(ref) || SITE_HOSTS.includes("www." + ref));
  if (internal) ref = "";
  ref = ref.slice(0, LIMITS.ref);

  if (us || um || uc) {
    let src: Source = "campaign";
    if (/^(e-?mail|newsletter|mail)/.test(um) || /^(newsletter|e-?mail)$/.test(us)) src = "email";
    else if (AI_UTM.test(us) || (us && hostSource(us.replace(/^www\./, "")) === "ai")) src = "ai";
    return { src, ref, us, um, uc, ux };
  }
  if (!ref) {
    // Click ids without a referrer (apps strip it): still tell us the channel.
    if (params.has("gclid") || params.has("msclkid") || params.has("gbraid") || params.has("wbraid")) return { src: "search", ref, us, um, uc, ux };
    if (params.has("fbclid") || params.has("igshid") || params.has("ttclid") || params.has("twclid") || params.has("li_fat_id"))
      return { src: "social", ref, us, um, uc, ux };
    return { src: "direct", ref, us, um, uc, ux };
  }
  return { src: hostSource(ref), ref, us, um, uc, ux };
}

/** Path without query or hash, trimmed to the rules' limit. */
export function cleanPath(pathname: string): string {
  const p = String(pathname || "/").split(/[?#]/)[0] || "/";
  return p.slice(0, LIMITS.path);
}

export function deviceOf(width: number): "m" | "t" | "d" {
  return width < 640 ? "m" : width < 1024 ? "t" : "d";
}

/** Likely a bot, crawler, preview fetcher or automation tool. */
export function isLikelyBot(ua: string, webdriver = false): boolean {
  if (webdriver) return true;
  return /bot\b|bot\/|crawl|spider|slurp|mediapartners|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|preview|facebookexternalhit|embedly|quora link|whatsapp|telegram|discord|phantom|puppeteer|playwright|selenium|cypress|python-requests|curl\/|wget/i.test(
    ua || "",
  );
}

/** Should this host send hits? Only the public site (plus localhost in `astro dev` with the debug flag). */
export function hostTracked(hostname: string, devDebug = false): boolean {
  const h = String(hostname || "").toLowerCase();
  if (SITE_HOSTS.includes(h)) return true;
  return devDebug && /^(localhost|127\.0\.0\.1)$/.test(h);
}

export interface HitInput extends Attribution {
  k: "pv" | "ev";
  sid: string;
  path: string;
  first: boolean;
  land: string;
  dev: "m" | "t" | "d";
  tz: string;
  lang: string;
  ev: string;
  lbl: string;
}

/** Firestore typed fields for a hit, everything except `t` (the server sets it). */
export function hitFields(h: HitInput) {
  const s = (v: unknown, max: number) => ({ stringValue: clip(v, max) });
  return {
    k: { stringValue: h.k === "ev" ? "ev" : "pv" },
    sid: s(h.sid, LIMITS.sid),
    path: s(cleanPath(h.path), LIMITS.path),
    first: { booleanValue: Boolean(h.first) },
    src: { stringValue: SOURCES.includes(h.src) ? h.src : "direct" },
    ref: s(h.ref, LIMITS.ref),
    us: s(h.us, LIMITS.us),
    um: s(h.um, LIMITS.um),
    uc: s(h.uc, LIMITS.uc),
    ux: s(h.ux, LIMITS.ux),
    land: s(cleanPath(h.land), LIMITS.land),
    dev: { stringValue: ["m", "t", "d"].includes(h.dev) ? h.dev : "d" },
    tz: s(h.tz, LIMITS.tz),
    lang: s(h.lang, LIMITS.lang),
    ev: { stringValue: h.k === "ev" ? clip(h.ev, LIMITS.ev) : "" },
    lbl: { stringValue: h.k === "ev" ? clip(h.lbl, LIMITS.lbl) : "" },
  };
}

export const COMMIT_URL = `${FIRESTORE_DOCS}:commit`;
const DOC_PREFIX = FIRESTORE_DOCS.replace(/^https:\/\/firestore\.googleapis\.com\/v1\//, "");

/**
 * The REST body for one hit: a create-only write (currentDocument.exists=false) whose `t`
 * is set to the server's REQUEST_TIME, so firestore.rules can insist on t == request.time.
 */
export function commitBody(h: HitInput, docId: string) {
  return {
    writes: [
      {
        update: { name: `${DOC_PREFIX}/${HITS_COLLECTION}/${docId}`, fields: hitFields(h) },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: "t", setToServerValue: "REQUEST_TIME" }],
      },
    ],
  };
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** Random [A-Za-z0-9] id (Firestore auto-id style). */
export function randomId(len = 20): string {
  const out: string[] = [];
  const bytes = new Uint8Array(len);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (const b of bytes) out.push(ALNUM[b % ALNUM.length]);
  return out.join("");
}

/** What a click means, from the element clicked and the page it is on. Pure (works on any Element-like). */
export function classifyLink(href: string, pagePath: string, ownHost: string): { ev: EventName; lbl: string }[] {
  let u: URL;
  try {
    u = new URL(href, `https://${ownHost || SITE_HOSTS[0]}${pagePath || "/"}`);
  } catch {
    return [];
  }
  if (u.protocol === "mailto:") {
    const out: { ev: EventName; lbl: string }[] = [{ ev: "contact_click", lbl: "email" }];
    if (/^\/book-the-hut\b/.test(pagePath) || /earlier/i.test(decodeURIComponent(u.search))) out.unshift({ ev: "book_earlier", lbl: "email" });
    return out;
  }
  if (u.protocol === "tel:" || u.protocol === "sms:") return [{ ev: "contact_click", lbl: "phone" }];
  if (u.protocol !== "http:" && u.protocol !== "https:") return [];
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const own = String(ownHost || "").toLowerCase().replace(/^www\./, "");
  const internal = host === own || SITE_HOSTS.includes(u.hostname.toLowerCase());
  if (internal) {
    const ics = u.pathname.match(/^\/shows\/([^/]+)\.ics$/);
    if (ics) return [{ ev: "calendar_add", lbl: ics[1] }];
    const show = u.pathname.match(/^\/shows\/([^/.]+)$/);
    if (show && cleanPath(pagePath) !== u.pathname) return [{ ev: "show_click", lbl: show[1] }];
    if (u.pathname === "/gallery" && u.hash.length > 1) return [{ ev: "poster_click", lbl: decodeURIComponent(u.hash.slice(1)) }];
    if (/\.ics$/.test(u.pathname)) return [{ ev: "calendar_add", lbl: u.pathname.split("/").pop()!.replace(/\.ics$/, "") }];
    return [];
  }
  if (host === "calendar.google.com" || (host === "google.com" && u.pathname.startsWith("/calendar"))) return [{ ev: "calendar_add", lbl: "google" }];
  return [{ ev: "outbound", lbl: host.slice(0, LIMITS.lbl) }];
}

/* ----------------------------------------------------------------- client ----------------------------------------------------------------- */

const MAX_HITS = 300; // per visit: a runaway loop can't flood the collection

type Visit = { sid: string; attr: Attribution; land: string };
let visit: Visit | null = null;
let on: boolean | null = null;
let sent = 0;
let landingSent = false;

function env(): { key: string; dev: boolean } {
  // Vite replaces these at build time; under plain Node (tests) import.meta.env is undefined.
  try {
    return { key: String(import.meta.env.PUBLIC_FEEDBACK_API_KEY ?? "").trim(), dev: Boolean(import.meta.env.DEV) };
  } catch {
    return { key: "", dev: false };
  }
}

function storageFlag(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function enabled(): boolean {
  if (on !== null) return on;
  on = false;
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return false;
    const { key, dev } = env();
    const devDebug = dev && (storageFlag("tritone:track-debug") === "1" || /[?&]track=debug\b/.test(location.search));
    if (!key || !hostTracked(location.hostname, devDebug)) return false;
    if (isLikelyBot(navigator.userAgent, Boolean(navigator.webdriver))) return false;
    if (storageFlag(SELF_FLAG) === "1") return false;
    if ((document as Document & { prerendering?: boolean }).prerendering) return false;
    on = true;
  } catch {
    on = false;
  }
  return on;
}

function ensureVisit(): Visit {
  if (visit) return visit;
  let attr: Attribution;
  try {
    attr = classifySource(document.referrer, location.search, location.hostname);
  } catch {
    attr = { src: "direct", ref: "", us: "", um: "", uc: "", ux: "" };
  }
  visit = { sid: randomId(12), attr, land: cleanPath(location.pathname) };
  return visit;
}

function send(k: "pv" | "ev", ev: string, lbl: string, first = false) {
  try {
    if (!enabled() || sent >= MAX_HITS) return;
    const path = cleanPath(location.pathname);
    if (/^\/admin\b/.test(path)) return;
    const v = ensureVisit();
    let tz = "";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {}
    const hit: HitInput = {
      k, ev, lbl, first, path, ...v.attr, sid: v.sid, land: v.land,
      dev: deviceOf(window.innerWidth || document.documentElement.clientWidth || 1024),
      tz, lang: navigator.language || "",
    };
    sent++;
    const { key, dev } = env();
    const body = JSON.stringify(commitBody(hit, randomId()));
    if (dev) console.debug("[track]", k, ev, lbl, hit);
    fetch(`${COMMIT_URL}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      keepalive: true,
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => {});
  } catch {
    /* never break the page */
  }
}

/** Record an interest event (see EventName). Never pass names, emails, phone numbers or free text. */
export function track(ev: EventName, lbl = "") {
  if (!EVENTS.includes(ev)) return;
  send("ev", ev, lbl);
}

function pageView() {
  const first = !landingSent;
  landingSent = true;
  send("pv", "", "", first);
}

const played = new WeakMap<HTMLMediaElement, Set<string>>();

function onClick(e: MouseEvent) {
  try {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== "function") return;
    const plain = !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);

    // 1. Explicit hooks: data-track="<event>" data-track-lbl="<detail>".
    const tagged = t.closest<HTMLElement>("[data-track]");
    if (tagged && EVENTS.includes(tagged.dataset.track as EventName)) {
      track(tagged.dataset.track as EventName, tagged.dataset.trackLbl ?? "");
      return;
    }

    // 2. Players and viewers (these handlers replace the element, so we run in the capture phase first).
    const dock = t.closest<HTMLElement>("#dock-toggle");
    if (dock) {
      if (!document.getElementById("dock")?.classList.contains("open"))
        track("play", `spotify: ${(document.getElementById("dock-title")?.textContent ?? "dock").split(" · ")[0].trim()}`);
      return;
    }
    const sp = t.closest<HTMLElement>("[data-play]");
    if (sp) return track("play", `spotify: ${sp.dataset.playTitle ?? ""}`.replace(/ · Spotify$/, ""));
    const sc = t.closest<HTMLElement>("[data-sc-src]");
    if (sc) return track("play", `soundcloud: ${sc.dataset.scTitle ?? ""}`);
    const bc = t.closest<HTMLElement>("a.bc-lite[data-bc-src]");
    if (bc && plain) return track("play", `bandcamp: ${(bc.dataset.bcTitle ?? "").replace(/ on Bandcamp$/, "")}`);
    const yt = t.closest<HTMLElement>("a.yt[data-yt]");
    if (yt && plain) return track("play", `youtube: ${yt.dataset.ytTitle ?? yt.dataset.yt ?? ""}`);
    const poster = t.closest<HTMLElement>(".g-open");
    if (poster) return track("poster_click", poster.closest("li")?.id ?? poster.dataset.index ?? "");

    // 3. Links by URL.
    const a = t.closest<HTMLAnchorElement>("a[href]");
    if (!a) return;
    for (const r of classifyLink(a.getAttribute("href") ?? "", location.pathname, location.hostname)) track(r.ev, r.lbl);
  } catch {
    /* ignore */
  }
}

function onPlay(e: Event) {
  try {
    const a = e.target as HTMLMediaElement;
    if (!(a instanceof HTMLMediaElement)) return;
    const src = a.getAttribute("src") ?? a.currentSrc ?? "";
    const seen = played.get(a) ?? new Set<string>();
    if (seen.has(src)) return; // resuming after a pause is not a new listen
    seen.add(src);
    played.set(a, seen);
    const list = a.closest<HTMLElement>("[data-tracklist]");
    const row = list && [...list.querySelectorAll<HTMLElement>(".tl-row")].find((r) => r.dataset.src === src);
    const what = row?.dataset.title ?? decodeURIComponent(src.split("/").pop() ?? "").replace(/\.\w+$/, "");
    track("play", `${list?.dataset.artist ? list.dataset.artist + ": " : "audio: "}${what}`);
  } catch {
    /* ignore */
  }
}

/** Start tracking: a page view now and after every ClientRouter navigation, plus the interest listeners. */
export function initTracker() {
  try {
    const w = window as Window & { __tritoneTrack?: boolean };
    if (w.__tritoneTrack) return;
    w.__tritoneTrack = true;
    if (!enabled()) return;
    ensureVisit();
    let swapped = false;
    document.addEventListener("astro:after-swap", () => (swapped = true));
    document.addEventListener("astro:page-load", () => {
      if (!landingSent) pageView();
      else if (swapped) {
        swapped = false;
        pageView();
      }
    });
    if (!landingSent) pageView();
    document.addEventListener("click", onClick, true);
    document.addEventListener("play", onPlay, true);
  } catch {
    /* ignore */
  }
}
