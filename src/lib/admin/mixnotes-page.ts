// Client controller for /admin/mix-notes: Scott's mix-review queue (song -> client -> submission)
// and follow-along mode (a tablet / second screen while he works in Logic). Sign-in is the same
// email link as /admin (./auth.ts; the refresh token is shared, so signing in on either page works
// for both). Data: ./mixnotes-api.ts; pure helpers: ./mixnotes.ts. /admin/mix-notes?demo=1 previews
// everything with sample data (no audio).
import { createAuth, type Auth } from "./auth.ts";
import { FirestoreError } from "./firestore.ts";
import { encodeQr, qrSvg } from "./qr.ts";
import { esc } from "./charts.ts";
import { commitWrites, loadQueue, signUrl, StreamError, type ReviewData } from "./mixnotes-api.ts";
import { demoQueue } from "./mixnotes-demo.ts";
import {
  DB_ROOT, barBeat, barBeatLabel, clipFor, crossedNote, fileSlug, fmtTime, groupQueue, noteAt, noteReplyWrite,
  noteStatusWrite, notesCsv, notesPlainText, noteWords, reviewStatusWrite, shareLink, streamBase, submissionStatusWrite,
  versionLabel, waveformPath, type Note, type NoteFilter, type NoteStatus, type SongGroup, type SubmissionStatus, type Version,
} from "./mixnotes.ts";

const API_KEY = (import.meta.env.PUBLIC_FEEDBACK_API_KEY as string | undefined)?.trim() || "";
const STREAM = streamBase(import.meta.env.PUBLIC_REVIEW_STREAM_URL as string | undefined);
const FILTER_KEY = "tritone:mixnotes-filter";
const PREFS_KEY = "tritone:mixnotes-follow";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};
const when = (iso: string) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------ state
let wired = false;
let demo = false;
let auth: Auth;
let data: ReviewData[] = [];
let filter: NoteFilter = "open";
const shownQr = new Set<string>();
let busy = false;

// ------------------------------------------------------------------ transport (song) + voice
// One song player for the whole page. In demo mode a clock stands in for the audio element.
interface Transport { src: string; time(): number; paused(): boolean; play(): Promise<void>; pause(): void; seek(t: number): void; duration(): number }

function audioTransport(el: HTMLAudioElement): Transport {
  return {
    get src() { return el.currentSrc || el.src; },
    set src(v: string) { if (v !== el.src) { el.src = v; el.load(); } },
    time: () => el.currentTime,
    paused: () => el.paused,
    play: () => el.play(),
    pause: () => el.pause(),
    seek: (t) => { el.currentTime = Math.max(0, t); },
    duration: () => (Number.isFinite(el.duration) ? el.duration : 0),
  } as Transport;
}
function clockTransport(): Transport {
  let at = 0, startedAt = 0, playing = false, dur = 0;
  return {
    get src() { return "demo"; },
    set src(_v: string) { at = 0; playing = false; },
    time: () => (playing ? Math.min(dur || Infinity, at + (performance.now() - startedAt) / 1000) : at),
    paused: () => !playing,
    play: async () => { if (!playing) { startedAt = performance.now(); playing = true; } },
    pause() { if (playing) { at = this.time(); playing = false; } },
    seek(t) { at = Math.max(0, t); startedAt = performance.now(); },
    duration: () => dur,
    set dur(v: number) { dur = v; },
  } as Transport & { dur: number };
}

let song: Transport;
let songKey = ""; // review|version currently loaded
let raf = 0;
let lastT = 0;
let clipEnd: number | null = null; // queue playback stops here
let afterClip: (() => void) | null = null;
let voiceEl: HTMLAudioElement;
let voiceTimer = 0;
let voiceDone: (() => void) | null = null;

async function loadSong(key: string, v: Version): Promise<void> {
  const k = `${key}|${v.id}`;
  if (songKey === k) return;
  song.pause();
  if (demo) { (song as any).src = "demo"; (song as any).dur = v.durationSec; songKey = k; return; }
  const url = await signUrl(STREAM, key, { version: v.id, kind: "aac" });
  (song as any).src = url;
  songKey = k;
}

function stopVoice() {
  clearTimeout(voiceTimer);
  if (voiceEl) { voiceEl.pause(); voiceEl.removeAttribute("src"); }
  const d = voiceDone; voiceDone = null; d?.();
  setVoiceUi(false);
}

/** Play a client's voice note; resolves when it ends (or is stopped). */
async function playVoice(key: string, n: Note): Promise<void> {
  stopVoice();
  setVoiceUi(true);
  return new Promise<void>(async (resolve) => {
    voiceDone = () => resolve();
    const finish = () => { if (voiceDone) { voiceDone = null; setVoiceUi(false); resolve(); } };
    if (demo) { voiceTimer = window.setTimeout(finish, Math.min(4, n.voiceSec || 3) * 1000); return; }
    try {
      voiceEl.src = await signUrl(STREAM, key, { voiceId: n.voiceId });
      voiceEl.onended = finish;
      voiceEl.onerror = () => { say("Couldn't play that voice note.", "error"); finish(); };
      await voiceEl.play();
    } catch (e: any) {
      say(e?.message ?? "Couldn't play that voice note.", "error");
      finish();
    }
  });
}
let voiceUiHook: (on: boolean) => void = () => {};
function setVoiceUi(on: boolean) { voiceUiHook(on); }

function tick() {
  raf = 0;
  const t = song.time();
  if (clipEnd !== null && t >= clipEnd) {
    song.pause();
    clipEnd = null;
    const next = afterClip; afterClip = null;
    next?.();
  }
  if (follow) followTick(lastT, t);
  lastT = t;
  updateNowPlaying(t);
  if (!song.paused() || voiceDone) raf = requestAnimationFrame(tick);
}
function startTick() { if (!raf) raf = requestAnimationFrame(tick); }

async function playSong(from: number) {
  song.seek(from);
  lastT = from;
  try { await song.play(); } catch (e: any) { if (e?.name !== "AbortError") say("The browser blocked playback. Tap play again.", "error"); }
  startTick();
}

// ------------------------------------------------------------------ queue: clicking a note plays from..t, then the voice note
let nowPlaying: { key: string; note: Note } | null = null;

async function playNote(key: string, n: Note) {
  const entry = data.find((d) => d.review.key === key);
  const v = entry?.versions.find((x) => x.id === n.versionId);
  if (!entry || !v) return say("That note's version isn't loaded.", "error");
  if (follow) closeFollow();
  stopVoice();
  try {
    say(`Loading ${entry.review.title}…`, "busy");
    await loadSong(key, v);
  } catch (e: any) {
    return say(e instanceof StreamError ? e.message : "Couldn't load the song.", "error");
  }
  const c = clipFor(n);
  nowPlaying = { key, note: n };
  clipEnd = c.end;
  afterClip = () => {
    if (n.kind === "voice" && n.voiceId) playVoice(key, n).then(() => { if (nowPlaying?.note === n) endNowPlaying(); });
    else endNowPlaying();
  };
  say(demo ? "Demo: no audio, the clip runs silently." : "");
  showNowPlaying(entry.review.title, n);
  await playSong(c.start);
}

function showNowPlaying(title: string, n: Note) {
  const bar = $("mn-np");
  bar.hidden = false;
  $("mn-np-what").innerHTML = `<b>${esc(title)}</b> · ${esc(n.author)} · ${fmtTime(clipFor(n).start)}–${fmtTime(n.t)}${n.kind === "voice" ? " · then voice note" : ""}`;
  for (const li of document.querySelectorAll(".mn-note.is-playing")) li.classList.remove("is-playing");
  document.querySelector(`.mn-note[data-note="${CSS.escape(n.id)}"]`)?.classList.add("is-playing");
}
function updateNowPlaying(t: number) {
  if (!nowPlaying || follow) return;
  $("mn-np-time").textContent = voiceDone ? "voice note" : fmtTime(t);
}
function endNowPlaying() {
  nowPlaying = null;
  $("mn-np").hidden = true;
  for (const li of document.querySelectorAll(".mn-note.is-playing")) li.classList.remove("is-playing");
}
function stopAll() {
  clipEnd = null; afterClip = null;
  song.pause();
  stopVoice();
  endNowPlaying();
}

// ------------------------------------------------------------------ status line
function say(text: string, kind: "" | "busy" | "error" = "") {
  for (const id of ["mn-status", "mf-status"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.className = (id === "mn-status" ? "adm-status" : "mf-status") + (kind === "error" ? " is-error" : "");
    el.innerHTML = (kind === "busy" ? `<span class="adm-spin" aria-hidden="true"></span>` : "") + esc(text);
  }
}

// ------------------------------------------------------------------ writes (optimistic, rolled back on failure)
async function write(writes: unknown[], apply: () => void, undo: () => void, done = "Saved.") {
  apply();
  render();
  if (follow) renderFollow();
  if (demo) { say(`${done} (demo: nothing is saved)`); return true; }
  try {
    const token = await auth.getIdToken();
    await commitWrites(token, writes);
    say(done);
    return true;
  } catch (e: any) {
    undo();
    render();
    if (follow) renderFollow();
    if (e instanceof FirestoreError && e.status === 401) { auth.signOut(); showAuth(e.message, true); return false; }
    say(e?.message ?? "Couldn't save that.", "error");
    return false;
  }
}

function findNote(key: string, id: string) { return data.find((d) => d.review.key === key)?.notes.find((n) => n.id === id); }

function setNoteStatus(key: string, id: string, status: NoteStatus) {
  const n = findNote(key, id);
  if (!n || n.status === status) return Promise.resolve(true);
  const prev = n.status;
  const label = { open: "Reopened", doing: "Marked doing", done: "Marked done" }[status];
  return write([noteStatusWrite(DB_ROOT, key, id, status)], () => { n.status = status; }, () => { n.status = prev; }, `${label}.`);
}
function setReply(key: string, id: string, reply: string) {
  const n = findNote(key, id);
  if (!n) return Promise.resolve(false);
  const prev = n.reply;
  return write([noteReplyWrite(DB_ROOT, key, id, reply)], () => { n.reply = reply; }, () => { n.reply = prev; }, "Reply saved.");
}
function setSubmissionStatus(key: string, id: string, status: SubmissionStatus) {
  const s = data.find((d) => d.review.key === key)?.submissions.find((x) => x.id === id);
  if (!s || s.status === status) return Promise.resolve(true);
  const prev = s.status;
  return write([submissionStatusWrite(DB_ROOT, key, id, status)], () => { s.status = status; }, () => { s.status = prev; }, `Submission: ${status}.`);
}
function setReviewStatus(key: string, status: "open" | "closed") {
  const r = data.find((d) => d.review.key === key)?.review;
  if (!r) return;
  const prev = r.status;
  write([reviewStatusWrite(DB_ROOT, key, status)], () => { r.status = status; }, () => { r.status = prev; },
    status === "closed" ? `${r.title}: closed. The link no longer works for clients.` : `${r.title}: reopened. The link works again.`);
}

// ------------------------------------------------------------------ rendering: the queue
const STATUS_LABEL: Record<NoteStatus, string> = { open: "Open", doing: "Doing", done: "Done" };

function noteHtml(key: string, n: Note): string {
  const voice = n.kind === "voice";
  const words = noteWords(n);
  const actions = [
    n.status !== "doing" && n.status !== "done" ? `<button type="button" class="adm-btn adm-btn-ghost mn-sm" data-act="note-status" data-status="doing">Doing</button>` : "",
    n.status !== "done" ? `<button type="button" class="adm-btn mn-sm" data-act="note-status" data-status="done">Done</button>` : "",
    n.status !== "open" ? `<button type="button" class="adm-btn adm-btn-ghost mn-sm" data-act="note-status" data-status="open">Reopen</button>` : "",
    `<button type="button" class="adm-btn adm-btn-ghost mn-sm" data-act="reply">${n.reply ? "Edit reply" : "Reply"}</button>`,
  ].join("");
  return `<li class="mn-note" data-note="${esc(n.id)}" data-key="${esc(key)}" data-status="${n.status}">
    <button type="button" class="mn-play" data-act="play-note" aria-label="Play ${fmtTime(clipFor(n).start)} to ${fmtTime(n.t)}${voice ? ", then the voice note" : ""}">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
    </button>
    <div class="mn-note-body">
      <p class="mn-where"><b class="mn-t">${fmtTime(n.t)}</b>${n.section ? `<span>${esc(n.section)}</span>` : ""}<span>${barBeatLabel(n)}</span>
        <span class="mn-kind${voice ? " is-voice" : ""}">${voice ? `Voice ${fmtTime(n.voiceSec).replace(/\.\d$/, "")}` : "Typed"}</span>
        <span class="mn-st mn-st-${n.status}">${STATUS_LABEL[n.status]}</span></p>
      <p class="mn-text${voice && !n.transcript && !n.text ? " is-muted" : ""}">${esc(words)}</p>
      ${voice && n.transcript && n.text ? `<p class="mn-text is-muted">Typed: ${esc(n.text)}</p>` : ""}
      ${n.reply ? `<p class="mn-reply"><b>Your reply:</b> ${esc(n.reply)}</p>` : ""}
      <div class="mn-note-actions">${actions}</div>
      <form class="mn-reply-form" hidden>
        <label class="tf-label" for="r-${esc(key)}-${esc(n.id)}">Reply to ${esc(n.author)}</label>
        <textarea class="adm-input mn-textarea" id="r-${esc(key)}-${esc(n.id)}" maxlength="4000" rows="3">${esc(n.reply)}</textarea>
        <div class="mn-note-actions"><button type="submit" class="adm-btn adm-btn-primary mn-sm">Save reply</button><button type="button" class="adm-btn adm-btn-ghost mn-sm" data-act="reply-cancel">Cancel</button></div>
      </form>
    </div>
  </li>`;
}

function songHtml(g: SongGroup): string {
  const r = g.review;
  const link = shareLink(r.key);
  const latest = g.versions.find((v) => v.id === r.latestVersion) ?? g.versions.at(-1);
  const closed = r.status === "closed";
  const versionOpts = g.versions.slice().reverse().map((v) => `<option value="${esc(v.id)}"${v.id === latest?.id ? " selected" : ""}>${esc(v.label)}</option>`).join("");
  const clients = g.clients.map((c) => `
    <section class="mn-client">
      <h3 class="mn-client-h"><span>${esc(c.author)}</span><span class="mn-client-n">${c.open ? `${plural(c.open, "open note")}` : "all done"}</span></h3>
      ${c.submissions.map((sg) => {
        const s = sg.submission;
        const seg = s.id ? `<div class="mn-subseg" role="group" aria-label="Submission status">${(["new", "listening", "done"] as const).map((st) => `<button type="button" data-act="sub-status" data-status="${st}" aria-pressed="${s.status === st}">${st[0].toUpperCase() + st.slice(1)}</button>`).join("")}</div>` : "";
        return `<div class="mn-sub" data-sub="${esc(s.id)}" data-key="${esc(r.key)}" data-version="${esc(s.versionId)}" data-author="${esc(s.author)}">
          <div class="mn-sub-head">
            <p class="mn-sub-meta"><b>${s.id ? "Sent " + esc(when(s.createdAt)) : "Notes"}</b> · ${esc(versionLabel(s.versionId, g.versions))} · ${plural(sg.total, "note")}${sg.open ? ` · ${sg.open} open` : ""}</p>
            <div class="mn-sub-actions">${seg}<button type="button" class="adm-btn mn-sm" data-act="follow-sub"${sg.total ? "" : " disabled"}>Follow along</button></div>
          </div>
          ${sg.notes.length ? `<ol class="mn-notes">${sg.notes.map((n) => noteHtml(r.key, n)).join("")}</ol>` : `<p class="adm-empty">No ${filter === "all" ? "" : filter + " "}notes in this one.</p>`}
        </div>`;
      }).join("")}
    </section>`).join("");
  return `<article class="adm-card mn-song${closed ? " is-closed" : ""}" data-key="${esc(r.key)}">
    <header class="mn-song-head">
      <div class="mn-song-id">
        <h2 class="disp mn-song-title">${esc(r.title)}</h2>
        <p class="adm-sub">${[r.artist, latest ? `latest ${latest.label}` : "", r.clients.length ? `for ${r.clients.join(", ")}` : ""].filter(Boolean).map(esc).join(" · ")}</p>
      </div>
      <div class="mn-badges">
        <span class="mn-badge${closed ? "" : " is-on"}">${closed ? "Closed" : "Open"}</span>
        <span class="mn-badge-n"><b>${g.openNotes}</b> open ${g.openNotes === 1 ? "note" : "notes"}</span>
        ${g.newSubs ? `<span class="mn-badge is-new">${g.newSubs} new</span>` : ""}
      </div>
    </header>
    <div class="mn-share">
      <code class="adm-url mn-url">${esc(link)}</code>
      <div class="mn-actions">
        <button type="button" class="adm-btn adm-btn-primary mn-sm" data-act="copy-link">Copy link</button>
        <button type="button" class="adm-btn adm-btn-ghost mn-sm" data-act="qr" aria-expanded="${shownQr.has(r.key)}">QR code</button>
        <a class="adm-btn adm-btn-ghost mn-sm" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open as client</a>
        <button type="button" class="adm-btn adm-btn-ghost mn-sm" data-act="review-status" data-status="${closed ? "open" : "closed"}">${closed ? "Reopen review" : "Close review"}</button>
      </div>
      ${shownQr.has(r.key) ? `<figure class="adm-qr mn-qr"><div class="mn-qr-svg">${qrSvg(encodeQr(link), { px: 220, title: "QR code for the review link" })}</div><figcaption><span>Scan to open the review. Works until you close it.</span><span class="mn-actions"><button type="button" class="adm-btn adm-btn-ghost mn-sm" data-act="qr-png">Download PNG</button><button type="button" class="adm-btn adm-btn-ghost mn-sm" data-act="qr-svg">SVG</button></span></figcaption></figure>` : ""}
      ${closed ? `<p class="adm-sub mn-closed-note">Closed: the link and the stream refuse clients. Reopen to let them (or you) listen again.</p>` : ""}
    </div>
    <div class="mn-tools">
      ${g.versions.length ? `<label class="mn-ver"><span class="mn-sr">Version</span><select class="adm-input mn-sm-input" data-role="version">${versionOpts}</select></label>
      <button type="button" class="adm-btn mn-sm" data-act="follow-version">Follow along: open notes</button>` : ""}
      <button type="button" class="adm-btn adm-btn-ghost mn-sm" data-act="copy-notes">Copy notes</button>
      <button type="button" class="adm-btn adm-btn-ghost mn-sm" data-act="csv">Download CSV</button>
    </div>
    <div class="mn-clients">${clients || `<p class="adm-empty">${g.total ? `No ${filter} notes.` : "No notes yet."}</p>`}</div>
  </article>`;
}

function render() {
  const list = $("mn-list");
  if (!list) return;
  const groups = groupQueue(data, filter);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#mn-filter button")) b.setAttribute("aria-pressed", String(b.dataset.filter === filter));
  const open = data.reduce((a, d) => a + d.notes.filter((n) => n.status !== "done").length, 0);
  $("mn-summary").textContent = data.length ? `${plural(data.length, "song")} · ${plural(open, "open note")}` : "";
  list.innerHTML = groups.length ? groups.map(songHtml).join("") : `<div class="adm-card"><p class="adm-empty">No reviews yet. The publisher on the Mac Studio creates one when you share a bounce.</p></div>`;
  if (nowPlaying) document.querySelector(`.mn-note[data-note="${CSS.escape(nowPlaying.note.id)}"]`)?.classList.add("is-playing");
}

// ------------------------------------------------------------------ copy / download
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function qrPng(text: string, name: string) {
  const qr = encodeQr(text);
  const scale = 24, q = 4, dim = (qr.size + q * 2) * scale;
  const c = document.createElement("canvas");
  c.width = c.height = dim;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, dim, dim);
  g.fillStyle = "#000";
  qr.modules.forEach((row, y) => row.forEach((on, x) => { if (on) g.fillRect((x + q) * scale, (y + q) * scale, scale, scale); }));
  c.toBlob((b) => b && download(name, b), "image/png");
}
const flash = (btn: HTMLElement, text: string) => {
  const was = btn.textContent;
  btn.textContent = text;
  btn.classList.add("is-done");
  setTimeout(() => { btn.textContent = was; btn.classList.remove("is-done"); }, 1600);
};
const filteredNotes = (d: ReviewData) => d.notes.filter((n) => filter === "all" || n.status === filter);

// ------------------------------------------------------------------ queue events
function wireQueue() {
  $("mn-filter").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-filter]");
    if (!b) return;
    filter = b.dataset.filter as NoteFilter;
    ls.set(FILTER_KEY, filter);
    render();
  });
  $("mn-refresh").addEventListener("click", () => load());
  $("mn-np-stop").addEventListener("click", stopAll);

  const list = $("mn-list");
  list.addEventListener("submit", (e) => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>(".mn-reply-form");
    if (!form) return;
    e.preventDefault();
    const li = form.closest<HTMLElement>(".mn-note")!;
    const text = form.querySelector("textarea")!.value.trim();
    setReply(li.dataset.key!, li.dataset.note!, text);
  });
  list.addEventListener("change", (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>("select[data-role=version]");
    if (sel) sel.dataset.touched = "1";
  });
  list.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const songEl = btn.closest<HTMLElement>(".mn-song");
    const key = songEl?.dataset.key ?? "";
    const entry = data.find((d) => d.review.key === key);
    if (!entry) return;
    const li = btn.closest<HTMLElement>(".mn-note");
    const note = li ? entry.notes.find((n) => n.id === li.dataset.note) : undefined;
    const subEl = btn.closest<HTMLElement>(".mn-sub");
    const link = shareLink(key);
    switch (act) {
      case "copy-link": if (await copyText(link)) flash(btn, "Copied"); else say("Couldn't copy. Select the link and copy it by hand.", "error"); break;
      case "qr": if (shownQr.has(key)) shownQr.delete(key); else shownQr.add(key); render(); break;
      case "qr-png": qrPng(link, `review-qr-${fileSlug(entry.review.title)}.png`); break;
      case "qr-svg": download(`review-qr-${fileSlug(entry.review.title)}.svg`, new Blob([qrSvg(encodeQr(link), { px: 1024 })], { type: "image/svg+xml" })); break;
      case "review-status": {
        const st = btn.dataset.status as "open" | "closed";
        if (st === "closed" && !confirm(`Close “${entry.review.title}”? The share link stops working for clients until you reopen it.`)) break;
        setReviewStatus(key, st);
        break;
      }
      case "copy-notes": if (await copyText(notesPlainText(entry.review, entry.versions, filteredNotes(entry)))) flash(btn, "Copied"); else say("Couldn't copy the notes.", "error"); break;
      case "csv": download(`mix-notes-${fileSlug(entry.review.title)}-${filter}${demo ? "-DEMO" : ""}.csv`, new Blob([notesCsv(filteredNotes(entry), entry.versions)], { type: "text/csv;charset=utf-8" })); break;
      case "play-note": if (note) playNote(key, note); break;
      case "note-status": if (note) setNoteStatus(key, note.id, btn.dataset.status as NoteStatus); break;
      case "reply": {
        const form = li?.querySelector<HTMLFormElement>(".mn-reply-form");
        if (form) { form.hidden = false; form.querySelector("textarea")?.focus(); }
        break;
      }
      case "reply-cancel": { const form = li?.querySelector<HTMLFormElement>(".mn-reply-form"); if (form) form.hidden = true; break; }
      case "sub-status": if (subEl?.dataset.sub) setSubmissionStatus(key, subEl.dataset.sub, btn.dataset.status as SubmissionStatus); break;
      case "follow-sub": {
        if (!subEl) break;
        const sid = subEl.dataset.sub ?? "";
        const notes = entry.notes.filter((n) => (sid ? n.submissionId === sid : !entry.submissions.some((s) => s.id === n.submissionId) && n.author === subEl.dataset.author && n.versionId === subEl.dataset.version));
        const vid = subEl.dataset.version ?? "";
        const s = entry.submissions.find((x) => x.id === sid);
        openFollow(entry, vid, notes, `${subEl.dataset.author} · sent ${when(s?.createdAt ?? "")}`, sid);
        if (s && s.status === "new") setSubmissionStatus(key, sid, "listening");
        break;
      }
      case "follow-version": {
        const vid = songEl?.querySelector<HTMLSelectElement>("select[data-role=version]")?.value ?? entry.review.latestVersion;
        openFollow(entry, vid, entry.notes.filter((n) => n.versionId === vid && n.status !== "done"), "All open notes", "");
        break;
      }
    }
  });
}

// ------------------------------------------------------------------ follow-along mode
interface Follow { entry: ReviewData; version: Version; notes: Note[]; idx: number; label: string; submissionId: string }
let follow: Follow | null = null;
const prefs = { pauseAtNote: true, autoVoice: true };
let wakeLock: any = null;
let lastFocus: HTMLElement | null = null;

async function keepAwake() {
  try { if ((navigator as any).wakeLock && document.visibilityState === "visible") wakeLock = await (navigator as any).wakeLock.request("screen"); } catch { /* not allowed: fine */ }
}
function releaseAwake() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
function onVisibility() { if (follow && document.visibilityState === "visible") keepAwake(); }

async function openFollow(entry: ReviewData, versionId: string, notes: Note[], label: string, submissionId: string) {
  const version = entry.versions.find((v) => v.id === versionId) ?? entry.versions.at(-1);
  if (!version) return say("That version isn't loaded.", "error");
  stopAll();
  const sorted = notes.filter((n) => n.versionId === version.id).sort((a, b) => a.t - b.t || a.from - b.from);
  follow = { entry, version, notes: sorted, idx: sorted.length ? 0 : -1, label, submissionId };
  lastFocus = document.activeElement as HTMLElement;
  const el = $("mn-follow");
  el.hidden = false;
  document.documentElement.classList.add("mn-follow-on");
  $("mf-title").textContent = entry.review.title;
  $("mf-sub").textContent = `${label} · ${version.label} · ${plural(sorted.length, "note")}`;
  renderFollow(true);
  $("mf-play").focus();
  keepAwake();
  try {
    say(`Loading ${version.label}…`, "busy");
    await loadSong(entry.review.key, version);
    say(demo ? "Demo: no audio, the playhead runs silently." : "Ready. Press play, or Next to jump to the first note.");
    const first = follow?.notes[0];
    if (follow && first) { song.seek(clipFor(first).start); lastT = song.time(); renderFollowTime(); }
  } catch (e: any) {
    say(e instanceof StreamError ? e.message : "Couldn't load the song.", "error");
  }
}

function closeFollow() {
  if (!follow) return;
  follow = null;
  song.pause();
  stopVoice();
  $("mn-follow").hidden = true;
  document.documentElement.classList.remove("mn-follow-on");
  releaseAwake();
  render();
  lastFocus?.focus?.();
}

function durationOf(f: Follow) { return f.version.durationSec || song.duration() || Math.max(1, ...f.notes.map((n) => n.t + 5)); }

function renderFollow(full = false) {
  const f = follow;
  if (!f) return;
  const dur = durationOf(f);
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / dur) * 100)).toFixed(3)}%`;
  if (full) {
    const W = 1000, H = 120;
    $("mf-wave-svg").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true"><path d="${waveformPath(f.version.peaks, W, H, 320)}" fill="currentColor"/></svg>`;
    $("mf-markers").innerHTML = f.version.markers.filter((m) => !/^end$/i.test(m.name)).map((m) => `<span class="mf-marker" style="left:${pct(m.t)}"><span>${esc(m.name)}</span></span>`).join("");
  }
  $("mf-ranges").innerHTML = f.notes.map((n, i) => {
    const c = clipFor(n);
    return `<button type="button" class="mf-range${i === f.idx ? " is-current" : ""}${n.status === "done" ? " is-done" : ""}" style="left:${pct(c.start)};width:max(6px, calc(${pct(c.end)} - ${pct(c.start)}))" data-i="${i}" aria-label="Note ${i + 1}: ${fmtTime(n.t)} ${esc(n.author)}"></button>`;
  }).join("");
  const n = f.notes[f.idx];
  const card = $("mf-note");
  if (!n) {
    card.innerHTML = `<p class="mf-empty">${f.notes.length ? "Pick a note." : "No notes to follow here."}</p>`;
  } else {
    const voice = n.kind === "voice";
    card.innerHTML = `
      <p class="mf-count">Note ${f.idx + 1} of ${f.notes.length} <span class="mn-st mn-st-${n.status}">${STATUS_LABEL[n.status]}</span></p>
      <p class="mf-who">${esc(n.author)}</p>
      <p class="mf-where"><b>${barBeatLabel(n)}</b>${n.section ? ` · ${esc(n.section)}` : ""} · ${fmtTime(n.t)}</p>
      <p class="mf-words${voice && !n.transcript && !n.text ? " is-muted" : ""}">${esc(noteWords(n))}</p>
      ${n.reply ? `<p class="mn-reply"><b>Your reply:</b> ${esc(n.reply)}</p>` : ""}
      ${voice ? `<button type="button" class="adm-btn mf-voice" id="mf-voice">${voiceDone ? "Stop voice note" : `Play voice note (${fmtTime(n.voiceSec).replace(/\.\d$/, "")})`}</button>` : ""}`;
  }
  ($("mf-prev") as HTMLButtonElement).disabled = f.idx <= 0;
  ($("mf-next") as HTMLButtonElement).disabled = f.idx >= f.notes.length - 1;
  ($("mf-done") as HTMLButtonElement).disabled = !n || n.status === "done";
  ($("mf-replay") as HTMLButtonElement).disabled = !n;
  $("mf-pause-at").setAttribute("aria-checked", String(prefs.pauseAtNote));
  $("mf-auto-voice").setAttribute("aria-checked", String(prefs.autoVoice));
  renderFollowTime();
}

function renderFollowTime() {
  const f = follow;
  if (!f) return;
  const t = song.time();
  const dur = durationOf(f);
  $("mf-head").style.left = `${Math.max(0, Math.min(100, (t / dur) * 100))}%`;
  const bb = barBeat(t, f.version);
  $("mf-time").textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
  $("mf-bb").textContent = `Bar ${bb.bar} · Beat ${bb.beat}`;
  const playing = !song.paused();
  $("mf-play").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("mf-play").classList.toggle("is-playing", playing);
}

function setIdx(i: number) {
  if (!follow) return;
  follow.idx = Math.max(0, Math.min(follow.notes.length - 1, i));
  renderFollow();
}

/** Playback crossed note i's time. */
async function arrive(i: number) {
  const f = follow;
  if (!f) return;
  setIdx(i);
  const n = f.notes[i];
  if (prefs.pauseAtNote) song.pause();
  if (prefs.autoVoice && n.kind === "voice" && n.voiceId) {
    const wasPlaying = !song.paused();
    song.pause();
    await playVoice(f.entry.review.key, n);
    if (follow === f && wasPlaying && !prefs.pauseAtNote) { await song.play().catch(() => {}); startTick(); }
    renderFollow();
  }
  renderFollowTime();
}

function followTick(prev: number, cur: number) {
  if (!follow) return;
  const i = crossedNote(follow.notes, prev, cur);
  if (i >= 0) arrive(i);
  renderFollowTime();
}

async function goTo(i: number) {
  const f = follow;
  if (!f || !f.notes.length) return;
  stopVoice();
  setIdx(i);
  const c = clipFor(f.notes[f.idx]);
  await playSong(c.start);
  renderFollowTime();
}

async function markDoneAndNext() {
  const f = follow;
  const n = f?.notes[f.idx];
  if (!f || !n) return;
  const okSaved = await setNoteStatus(f.entry.review.key, n.id, "done");
  if (!okSaved || follow !== f) return;
  if (f.submissionId && f.entry.notes.filter((x) => x.submissionId === f.submissionId).every((x) => x.status === "done")) {
    await setSubmissionStatus(f.entry.review.key, f.submissionId, "done");
  }
  const next = f.notes.findIndex((x, j) => j > f.idx && x.status !== "done");
  if (next >= 0) goTo(next);
  else { song.pause(); stopVoice(); say("That was the last open note."); renderFollow(); }
}

function wireFollow() {
  try { Object.assign(prefs, JSON.parse(ls.get(PREFS_KEY) || "{}")); } catch { /* default */ }
  const savePrefs = () => ls.set(PREFS_KEY, JSON.stringify(prefs));
  voiceUiHook = (on) => {
    $("mn-follow").classList.toggle("is-voice", on);
    const b = document.getElementById("mf-voice");
    if (b && follow) renderFollow();
    if (on) startTick();
  };
  $("mf-close").addEventListener("click", closeFollow);
  $("mf-play").addEventListener("click", async () => {
    if (!follow) return;
    if (song.paused()) { stopVoice(); lastT = song.time(); await song.play().catch(() => say("The browser blocked playback. Tap play again.", "error")); startTick(); }
    else song.pause();
    renderFollowTime();
  });
  $("mf-prev").addEventListener("click", () => follow && goTo(follow.idx - 1));
  $("mf-next").addEventListener("click", () => follow && goTo(follow.idx + 1));
  $("mf-replay").addEventListener("click", () => follow && goTo(follow.idx));
  $("mf-done").addEventListener("click", markDoneAndNext);
  $("mf-pause-at").addEventListener("click", () => { prefs.pauseAtNote = !prefs.pauseAtNote; savePrefs(); renderFollow(); });
  $("mf-auto-voice").addEventListener("click", () => { prefs.autoVoice = !prefs.autoVoice; savePrefs(); renderFollow(); });
  $("mf-note").addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("#mf-voice") || !follow) return;
    const n = follow.notes[follow.idx];
    if (voiceDone) stopVoice();
    else if (n) { song.pause(); playVoice(follow.entry.review.key, n).then(() => renderFollow()); }
    renderFollow();
  });
  // Tap a note range to jump there; tap anywhere else on the waveform to seek.
  $("mf-wave").addEventListener("click", (e) => {
    if (!follow) return;
    const r = (e.target as HTMLElement).closest<HTMLElement>(".mf-range");
    if (r) { goTo(Number(r.dataset.i)); return; }
    const box = $("mf-wave").getBoundingClientRect();
    const t = ((e.clientX - box.left) / box.width) * durationOf(follow);
    song.seek(t);
    lastT = t;
    setIdx(noteAt(follow.notes, t));
    renderFollowTime();
  });
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisibility);
}

function onKey(e: KeyboardEvent) {
  if (!follow || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
  const k = e.key;
  if (k === "Escape") closeFollow();
  else if (k === " " || k === "k") { e.preventDefault(); $("mf-play").click(); }
  else if (k === "ArrowRight" || k === "n") { e.preventDefault(); $("mf-next").click(); }
  else if (k === "ArrowLeft" || k === "p") { e.preventDefault(); $("mf-prev").click(); }
  else if (k === "r") $("mf-replay").click();
  else if (k === "d") $("mf-done").click();
}

// ------------------------------------------------------------------ loading + auth
async function load() {
  if (busy) return;
  busy = true;
  $("mn").dataset.state = "loading";
  say("Loading reviews…", "busy");
  try {
    if (demo) data = demoQueue();
    else data = await loadQueue(await auth.getIdToken());
    render();
    say(`Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}${demo ? " · demo data" : ""}`);
  } catch (e: any) {
    if (e instanceof FirestoreError && e.status === 401) { auth.signOut(); showAuth(e.message, true); }
    else if (e?.code && !(e instanceof FirestoreError) && e.code !== "NETWORK") showAuth(e.message, true);
    else say(e?.message ?? "Couldn't load the notes.", "error");
  } finally {
    busy = false;
    $("mn").dataset.state = "ready";
  }
}

function showAuth(message = "", error = false) {
  $("mn-app").hidden = true;
  $("mn-head-actions").hidden = true;
  $("mn-auth").hidden = false;
  $("mn-who").textContent = "";
  const msg = $("mn-auth-msg");
  msg.hidden = !message;
  msg.textContent = message;
  msg.classList.toggle("is-error", error);
  $("mn").dataset.state = "auth";
}

function showApp() {
  $("mn-auth").hidden = true;
  $("mn-app").hidden = false;
  $("mn-head-actions").hidden = false;
  $("mn-signout").hidden = demo;
  $("mn-who").textContent = demo ? "Previewing with sample data" : `Signed in as ${auth.email}`;
  load();
}

async function handleSignInLink(): Promise<boolean> {
  const q = new URLSearchParams(location.search);
  const code = q.get("oobCode");
  if (!code || (q.get("mode") && q.get("mode") !== "signIn")) return false;
  const clean = () => history.replaceState(history.state, "", location.pathname);
  const email = auth.pendingEmail();
  if (!email) {
    showAuth("Confirm the email this sign-in link was sent to.");
    $("mn-auth-btn").textContent = "Finish signing in";
    $("mn-auth-form").dataset.code = code;
    clean();
    return true;
  }
  showAuth("Signing you in…");
  try { await auth.completeSignIn(email, code); clean(); showApp(); } catch (e: any) { clean(); showAuth(e?.message ?? "Sign-in failed.", true); }
  return true;
}

function wireAuth() {
  const form = $<HTMLFormElement>("mn-auth-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $<HTMLInputElement>("mn-email").value.trim();
    const btn = $<HTMLButtonElement>("mn-auth-btn");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showAuth("That doesn't look like an email address.", true);
    btn.disabled = true;
    try {
      if (form.dataset.code) {
        await auth.completeSignIn(email, form.dataset.code);
        delete form.dataset.code;
        btn.textContent = "Email me a sign-in link";
        showApp();
      } else {
        await auth.sendSignInLink(email, location.origin + "/admin/mix-notes");
        showAuth(`Check your inbox at ${email}. Open the link on this device and you'll land back here, signed in.`);
      }
    } catch (err: any) {
      showAuth(err?.message ?? "Something went wrong.", true);
    } finally {
      btn.disabled = false;
    }
  });
  $("mn-signout").addEventListener("click", () => { stopAll(); auth.signOut(); data = []; showAuth("Signed out."); });
}

// ------------------------------------------------------------------ entry
export function init() {
  const root = $("mn");
  if (!root || root.dataset.wired) return;
  root.dataset.wired = "1";
  wired = true;
  demo = new URLSearchParams(location.search).get("demo") === "1";
  auth = createAuth(API_KEY);
  const f = ls.get(FILTER_KEY) as NoteFilter | null;
  if (f && ["open", "doing", "done", "all"].includes(f)) filter = f;
  voiceEl = $<HTMLAudioElement>("mn-voice-audio");
  song = demo ? clockTransport() : audioTransport($<HTMLAudioElement>("mn-song-audio"));
  if (!demo) {
    const el = $<HTMLAudioElement>("mn-song-audio");
    el.addEventListener("play", startTick);
    el.addEventListener("pause", () => { if (follow) renderFollowTime(); });
    el.addEventListener("error", () => { if (el.getAttribute("src")) { songKey = ""; say("The song didn't load from the stream server. Try again in a moment.", "error"); } });
  }
  wireQueue();
  wireFollow();
  wireAuth();
  if (demo) {
    $("mn-demo").hidden = false;
    document.title = "DEMO · Mix notes · Tritone admin";
    showApp();
    return;
  }
  handleSignInLink().then((handled) => {
    if (handled) return;
    if (auth.signedIn) showApp();
    else showAuth(API_KEY ? "" : "This build has no Firebase API key, so sign-in can't work here. Use the demo preview instead.", !API_KEY);
  });
}

export function teardown() {
  if (!wired) return;
  wired = false;
  closeFollow();
  stopAll();
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  document.removeEventListener("keydown", onKey);
  document.removeEventListener("visibilitychange", onVisibility);
}
