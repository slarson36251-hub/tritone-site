/**
 * /upload landing, ported from the Squarespace code block
 * (tritone repo: studio/Automation/hummingbird/upload-page.html).
 *
 * The confirmation mailer links clients to /upload?s=<link>&n=<name>&d=<date>&r=<ref>.
 * Only `s` matters. The page puts `s` behind a button only when it is an https URL whose
 * parsed hostname is one of ALLOWED_HOSTS (or a subdomain); anything else gets the polite
 * fall-back. No upload link or studio hostname is ever written into this page.
 */

export const ALLOWED_HOSTS = ["quickconnect.to", "synology.me", "tritone-productions.com"];
const MAX_URL = 600;
const MAX_FIELD = 120;
const CTRL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g;

export function cleanText(v: unknown, max = MAX_FIELD) {
  if (v === null || v === undefined) return "";
  let s = String(v).replace(CTRL, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}

function decodeParam(v: string) {
  const s = v.replace(/\+/g, " ");
  try { return decodeURIComponent(s); } catch { return s; }
}

export function readParams(query: string) {
  const out: Record<"s" | "n" | "d" | "r", string> = { s: "", n: "", d: "", r: "" };
  const seen: Record<string, boolean> = {};
  let q = query || "";
  if (q.charAt(0) === "?") q = q.slice(1);
  for (const part of q.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? "" : part.slice(eq + 1);
    if (!Object.prototype.hasOwnProperty.call(out, k) || seen[k]) continue; // first occurrence wins
    seen[k] = true;
    out[k as keyof typeof out] = decodeParam(v);
  }
  return out;
}

const hostMatches = (host: string, base: string) =>
  !!host && !!base && (host === base || host.slice(-(base.length + 1)) === "." + base);

/** Returns the URL if it is safe to open, otherwise "". */
export function safeUploadUrl(raw: unknown) {
  const s = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!s || s.length > MAX_URL) return "";
  if (/[\s"'<>`\\]/.test(s)) return "";
  if (new RegExp(CTRL.source).test(s)) return "";
  let u: URL;
  try { u = new URL(s); } catch { return ""; } // no base, on purpose: //evil.com is refused
  if (u.protocol !== "https:" || u.username || u.password) return "";
  let host = String(u.hostname || "").toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return "";
  return ALLOWED_HOSTS.some((b) => hostMatches(host, b)) ? s : "";
}

export function buildModel(query: string) {
  const p = readParams(query);
  const rawUrl = cleanText(p.s, MAX_URL + 40);
  const url = safeUploadUrl(rawUrl);
  return {
    url,
    ok: !!url,
    reason: url ? "ok" : rawUrl ? "refused" : "missing",
    name: cleanText(p.n),
    date: cleanText(p.d),
    ref: cleanText(p.r),
  };
}

/** Fills the server-rendered panels with textContent only; never builds markup from the query. */
export function initUpload() {
  const root = document.getElementById("tri-upload");
  if (!root) return;
  const m = buildModel(location.search);
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel);

  const panel = q("[data-panel]")!;
  const fallback = q("[data-fallback]")!;
  panel.hidden = !m.ok;
  fallback.hidden = m.ok;

  const greet = m.name ? "Hi " + m.name + "," : "";
  root.querySelectorAll<HTMLElement>("[data-greet]").forEach((el) => {
    el.textContent = m.ok
      ? (m.name ? greet + " there is a folder waiting with your name on it." : "There is a folder on the studio drive waiting for this session.")
      : greet;
    el.hidden = !el.textContent;
  });

  root.querySelectorAll<HTMLElement>("[data-facts]").forEach((ul) => {
    ul.replaceChildren();
    const rows: [string, string][] = [];
    if (m.date) rows.push(["Session", m.date]);
    if (m.ref) rows.push(["Booking", m.ref]);
    for (const [k, v] of rows) {
      const li = document.createElement("li");
      li.className = "rule flex flex-wrap items-baseline gap-x-4 border-t py-3 last:border-b";
      const ks = document.createElement("span");
      ks.className = "eyebrow w-24 text-stone";
      ks.textContent = k;
      const vs = document.createElement("span");
      vs.className = "font-semibold";
      vs.textContent = v;
      li.append(ks, vs);
      ul.appendChild(li);
    }
    ul.hidden = !rows.length;
  });

  if (m.ok) {
    root.querySelectorAll<HTMLAnchorElement>("[data-link]").forEach((a) => {
      a.href = m.url;
      if (a.hasAttribute("data-link-text")) a.textContent = m.url;
    });
  } else {
    q("[data-missing]")!.hidden = m.reason !== "missing";
    q("[data-refused]")!.hidden = m.reason !== "refused";
  }
}
