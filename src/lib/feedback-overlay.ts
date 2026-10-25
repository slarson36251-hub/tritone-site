// Scott's "click and talk" feedback overlay for the beta site. Loaded only by
// src/components/Feedback.astro, after its host + ?feedback=on gate (feedback-gate.ts) passes,
// so normal visitors never download any of this.
//
// Flow: Feedback button → pick mode (hover/tap highlights, click selects without navigating)
// or "Whole page" → panel with speech-to-text into an editable textarea → Send posts one
// document to Firestore (collection "feedback", shape enforced by firestore.rules).
import css from "./feedback-overlay.css?inline";
import { FEEDBACK_ENDPOINT, feedbackDoc } from "./feedback-gate";

const API_KEY = (import.meta.env.PUBLIC_FEEDBACK_API_KEY as string | undefined)?.trim() || "";
const COUNT_KEY = "tritone:feedback-sent";

type Mode = "idle" | "pick" | "panel";
let mode: Mode = "idle";
let target: Element | null = null; // null with mode "panel" = whole-page note
let hovered: Element | null = null;
let sent = readCount();

let root: HTMLDivElement;
let launch: HTMLButtonElement;
let bar: HTMLDivElement;
let box: HTMLDivElement;
let panel: HTMLDivElement;
let ta: HTMLTextAreaElement;
let micBtn: HTMLButtonElement;
let sendBtn: HTMLButtonElement;
let statusEl: HTMLParagraphElement;
let targetEl: HTMLParagraphElement;
let wired = false;

// ---------- speech ----------
type SR = {
  continuous: boolean; interimResults: boolean; lang: string;
  start(): void; stop(): void; abort(): void;
  addEventListener(t: string, f: (e: any) => void): void;
};
const SpeechRec: (new () => SR) | undefined =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
let rec: SR | null = null;
let listening = false;
let base = ""; // textarea text before the current run of speech
let offset = 0; // results already folded into `base`
let seen = 0;

function readCount(): number {
  try { return Number(sessionStorage.getItem(COUNT_KEY)) || 0; } catch { return 0; }
}
function saveCount() {
  try { sessionStorage.setItem(COUNT_KEY, String(sent)); } catch { /* per page only */ }
}

const MIC = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, any> = {}, html = "") {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("aria-") || k.startsWith("data-") || k === "role") n.setAttribute(k, v);
    else (n as any)[k] = v;
  }
  if (html) n.innerHTML = html;
  return n;
}

function build() {
  root = el("div", { id: "fb-root", "data-feedback-overlay": "" });
  const style = el("style");
  style.textContent = css;
  launch = el("button", { id: "fb-launch", type: "button", class: "fb-btn", "aria-pressed": "false", title: "Leave feedback on this page" });
  bar = el("div", { id: "fb-bar", role: "status", hidden: true });
  bar.append(el("p", { textContent: "Tap anything to comment on it" }));
  const wholeBtn = el("button", { type: "button", class: "fb-btn fb-primary", textContent: "Whole page" });
  const barCancel = el("button", { type: "button", class: "fb-btn", textContent: "Cancel" });
  bar.append(wholeBtn, barCancel);
  box = el("div", { id: "fb-box", hidden: true });

  panel = el("div", { id: "fb-panel", role: "dialog", "aria-label": "Feedback note", hidden: true });
  const head = el("div", { class: "fb-head" });
  head.append(el("p", { class: "fb-label", textContent: "Feedback on" }));
  targetEl = el("p", { class: "fb-target" });
  head.append(targetEl);
  ta = el("textarea", { id: "fb-note", rows: 4, maxLength: 7900, placeholder: SpeechRec ? "Tap Talk and speak, or type here" : "Type your note here", "aria-label": "Your note" });
  micBtn = el("button", { type: "button", class: "fb-btn", id: "fb-mic" });
  const cancelBtn = el("button", { type: "button", class: "fb-btn", id: "fb-cancel", textContent: "Cancel" });
  sendBtn = el("button", { type: "button", class: "fb-btn fb-primary", id: "fb-send", textContent: "Send to Claude" });
  const row = el("div", { class: "fb-row" });
  if (SpeechRec) row.append(micBtn);
  row.append(el("span", { class: "fb-spacer" }), cancelBtn, sendBtn);
  statusEl = el("p", { class: "fb-status", role: "status", "aria-live": "polite" });
  panel.append(head, ta, row);
  if (!SpeechRec) panel.append(el("p", { class: "fb-note", textContent: "Voice isn't available in this browser, so type your note instead." }));
  panel.append(statusEl);

  root.append(style, launch, bar, box, panel);
  setMic(false);
  renderLaunch();

  launch.addEventListener("click", () => (mode === "idle" ? startPick() : cancel()));
  wholeBtn.addEventListener("click", () => openPanel(null));
  barCancel.addEventListener("click", cancel);
  cancelBtn.addEventListener("click", cancel);
  sendBtn.addEventListener("click", send);
  micBtn.addEventListener("click", () => (listening ? stopListening() : startListening()));
  ta.addEventListener("input", () => {
    if (listening) { base = ta.value; offset = seen; } // typed while talking: keep the edit
    if (statusEl.classList.contains("fb-error")) setStatus("");
  });
}

function renderLaunch() {
  launch.setAttribute("aria-pressed", String(mode !== "idle"));
  launch.innerHTML = mode === "idle" ? "Feedback" : "Close";
  if (sent) launch.append(el("span", { class: "fb-count", "aria-label": `${sent} sent this session`, textContent: String(sent) }));
}

// ---------- picking ----------
const inOverlay = (n: EventTarget | null) => n instanceof Node && root.contains(n);
function pickable(n: EventTarget | null): Element | null {
  if (!(n instanceof Element) || inOverlay(n)) return null;
  const e = n instanceof SVGElement ? (n.closest("svg") ?? n) : n;
  return e === document.documentElement || e === document.body ? null : e;
}

function showBox(e: Element | null) {
  if (!e) { box.hidden = true; return; }
  const r = e.getBoundingClientRect();
  Object.assign(box.style, { top: `${r.top - 3}px`, left: `${r.left - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
  box.hidden = false;
}

function startPick() {
  mode = "pick";
  root.classList.add("fb-picking");
  document.documentElement.classList.add("fb-pick-mode");
  bar.hidden = false;
  renderLaunch();
}

function onOver(e: Event) {
  if (mode !== "pick") return;
  hovered = pickable(e.target);
  showBox(hovered);
}

// Capture phase on window, ahead of the router, links and the dock: in pick mode a click selects
// instead of acting; with the panel open, clicks on the page are ignored so a note is never lost.
function onClick(e: MouseEvent) {
  if (mode === "idle" || inOverlay(e.target)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (mode !== "pick") return;
  const t = pickable(e.target);
  if (t) openPanel(t);
}
function swallow(e: Event) {
  if (mode !== "idle" && !inOverlay(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
}

// ---------- panel ----------
function describe(t: Element | null): string {
  if (!t) return `Whole page · ${document.title}`;
  const s = snippetOf(t);
  return s ? `${t.localName}: “${s.slice(0, 120)}${s.length > 120 ? "…" : ""}”` : `<${t.localName}>`;
}

function openPanel(t: Element | null) {
  target = t;
  mode = "panel";
  bar.hidden = true;
  root.classList.remove("fb-picking");
  document.documentElement.classList.remove("fb-pick-mode");
  if (t) t.scrollIntoView({ block: "center", inline: "nearest" });
  showBox(t);
  targetEl.textContent = describe(t);
  setStatus(API_KEY ? "" : "Feedback not configured yet.", !API_KEY);
  sendBtn.disabled = !API_KEY;
  panel.hidden = false;
  place();
  renderLaunch();
  ta.focus({ preventScroll: true });
}

function place() {
  if (mode !== "panel") return;
  const vw = window.visualViewport?.width ?? innerWidth;
  const vh = window.visualViewport?.height ?? innerHeight;
  const w = Math.min(400, vw - 32);
  panel.style.width = `${w}px`;
  const h = panel.offsetHeight;
  let top: number;
  let left: number;
  if (!target) {
    left = (vw - w) / 2;
    top = Math.max(16, (vh - h) / 2);
  } else {
    const r = target.getBoundingClientRect();
    left = Math.min(Math.max(16, r.left), vw - w - 16);
    if (r.bottom + 12 + h <= vh - 16) top = r.bottom + 12;
    else if (r.top - 12 - h >= 16) top = r.top - 12 - h;
    else top = Math.max(16, vh - h - 16);
  }
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function reflow() {
  if (mode === "panel") { showBox(target); place(); }
  else if (mode === "pick") showBox(hovered);
}

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("fb-error", error);
}

function cancel() {
  stopListening(true);
  mode = "idle";
  target = hovered = null;
  ta.value = "";
  setStatus("");
  bar.hidden = panel.hidden = box.hidden = true;
  root.classList.remove("fb-picking");
  document.documentElement.classList.remove("fb-pick-mode");
  renderLaunch();
}

// ---------- speech ----------
function setMic(on: boolean) {
  listening = on;
  micBtn.classList.toggle("fb-rec", on);
  micBtn.innerHTML = on ? `<span class="fb-dot" aria-hidden="true"></span>Stop` : `${MIC}Talk`;
  micBtn.setAttribute("aria-label", on ? "Stop listening" : "Start talking");
}

function startListening() {
  if (!SpeechRec || listening) return;
  const r = new SpeechRec();
  r.continuous = true;
  r.interimResults = true;
  r.lang = "en-US";
  base = ta.value;
  offset = seen = 0;
  r.addEventListener("result", (e: any) => {
    if (rec !== r) return;
    let text = "";
    for (let i = offset; i < e.results.length; i++) text += e.results[i][0].transcript;
    seen = e.results.length;
    text = text.trim();
    ta.value = base && text ? `${base.replace(/\s+$/, "")} ${text}` : base || text;
    ta.scrollTop = ta.scrollHeight;
  });
  r.addEventListener("error", (e: any) => {
    if (rec !== r) return;
    const why = e.error === "not-allowed" || e.error === "service-not-allowed"
      ? "Microphone is blocked here, so type your note instead."
      : e.error === "no-speech" ? "Didn't catch that. Tap Talk and try again."
      : e.error === "aborted" ? "" : `Voice stopped (${e.error}). You can keep typing.`;
    if (why) setStatus(why, e.error !== "no-speech");
  });
  r.addEventListener("end", () => { if (rec === r) { rec = null; setMic(false); } });
  rec = r;
  try {
    r.start();
    setMic(true);
    setStatus("Listening… talk it through, then tap Stop.");
  } catch (err) {
    rec = null;
    setStatus(`Couldn't start the microphone: ${(err as Error).message}`, true);
  }
}

function stopListening(abort = false) {
  const r = rec;
  rec = null;
  if (r) { try { abort ? r.abort() : r.stop(); } catch { /* already stopped */ } }
  if (listening) { setMic(false); if (!abort && statusEl.textContent?.startsWith("Listening")) setStatus(""); }
}

// ---------- sending ----------
/** A stable CSS path: nearest unique id, then tag:nth-of-type steps; at most ~600 chars. */
export function cssPath(e: Element): string {
  const parts: string[] = [];
  let n: Element | null = e;
  while (n && n !== document.documentElement) {
    if (n.id && /^[A-Za-z][\w-]*$/.test(n.id) && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) {
      parts.unshift(`#${n.id}`);
      break;
    }
    const tag = n.localName;
    const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.localName === tag) : [n];
    parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(n) + 1})` : tag);
    n = n.parentElement;
  }
  let sel = parts.join(" > ");
  while (sel.length > 590 && parts.length > 1) { parts.shift(); sel = parts.join(" > "); }
  return sel.slice(0, 599);
}

function snippetOf(t: Element): string {
  const img = t instanceof HTMLImageElement ? t : null;
  const raw = img ? img.alt : (t.textContent ?? "").replace(/\s+/g, " ").trim() || t.getAttribute("aria-label") || t.getAttribute("title") || "";
  return raw.trim().slice(0, 300);
}

async function send() {
  const note = ta.value.trim();
  if (!API_KEY) return setStatus("Feedback not configured yet.", true);
  if (!note) return setStatus("Say or type a note first.", true);
  stopListening();
  const body = feedbackDoc({
    page: location.pathname + location.hash,
    selector: target ? cssPath(target) : "(whole page)",
    snippet: target ? snippetOf(target) : document.title,
    note,
    viewport: `${innerWidth}x${innerHeight}`,
    createdAt: new Date().toISOString(),
    ua: navigator.userAgent.slice(0, 290),
  });
  sendBtn.disabled = true;
  setStatus("Sending…");
  try {
    const res = await fetch(`${FEEDBACK_ENDPOINT}?key=${encodeURIComponent(API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j?.error?.message) msg += ` ${j.error.message}`; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    sent++;
    saveCount();
    setStatus(`Sent to Claude ✓  ${sent} ${sent === 1 ? "note" : "notes"} this session. Say "read my feedback" in chat when you are done.`);
    renderLaunch();
    ta.value = "";
    setTimeout(() => { if (mode === "panel" && !ta.value) cancel(); }, 1400);
  } catch (err) {
    sendBtn.disabled = false;
    setStatus(`Not sent: ${((err as Error).message || "network error").replace(/\.+$/, "")}. Your note is still here; try Send again.`, true);
  }
}

// ---------- lifecycle ----------
function wire() {
  if (wired) return;
  wired = true;
  window.addEventListener("pointerover", onOver, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("auxclick", swallow, true);
  window.addEventListener("submit", swallow, true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mode !== "idle") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); launch.focus(); }
  }, true);
  window.addEventListener("scroll", reflow, { passive: true, capture: true });
  window.addEventListener("resize", reflow);
  window.visualViewport?.addEventListener("resize", reflow);
  // Keep the button above the player dock, open or closed.
  const dock = () => document.querySelector("#dock > div");
  const lift = () => {
    const d = dock();
    if (!d || !root) return;
    const gap = innerHeight - d.getBoundingClientRect().top;
    root.style.setProperty("--fb-bottom", `${Math.max(12, Math.round(gap + 12))}px`);
  };
  const d = dock();
  if (d && "ResizeObserver" in window) new ResizeObserver(lift).observe(d);
  window.addEventListener("resize", lift);
  // The site's page swap replaces <body>'s children: drop any open note state first.
  document.addEventListener("astro:before-swap", () => { if (mode !== "idle") cancel(); });
  document.addEventListener("astro:page-load", lift);
  lift();
}

/** Called on every astro:page-load while feedback is on. Safe to call repeatedly. */
export function init() {
  if (!root) build();
  if (!root.isConnected) document.body.append(root);
  renderLaunch();
  wire();
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}
