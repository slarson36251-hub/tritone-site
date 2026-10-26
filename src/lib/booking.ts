/**
 * Hummingbird Hut booking form, ported from the live Squarespace code block
 * (tritone repo: studio/Automation/hummingbird/squarespace-booking-block.html).
 *
 * Wire contract with the "Hummingbird Hut Booking" Apps Script web app
 * (HummingbirdBooking-Code.gs), unchanged from the Squarespace block:
 *   GET  ENDPOINT                 -> {ok, tz, days:[{date:"YYYY-MM-DD", windows:[{start:"YYYY-MM-DDTHH:mm", end, hours}]}]}
 *   POST ENDPOINT, body = JSON.stringify(payload), no Content-Type header
 *        (the browser sends text/plain, so there is no CORS preflight Apps Script can't answer)
 *        payload = {name, email, phone, project, musicians, numMusicians, hours, start:"YYYY-MM-DDTHH:00", company}
 *                  -> {ok:true, id, conflict} | {ok:false, error}
 * `company` is the honeypot. The page now stops a filled honeypot (or a sub-3-second fill)
 * before sending; the server's own honeypot check stays as the second line.
 */

import { track } from "./track";

export const ENDPOINT =
  "https://script.google.com/macros/s/AKfycbwVzX-VCx7_UCAj6rZ_DplyZaNdT4MGNOJXVinDPWn1pTem6T6Pt07gBkeKu8NykfJX/exec";

const MAILTO = '<a href="mailto:scott@tritone-productions.com">scott@tritone-productions.com</a>';
const FULL_MSG = "The calendar’s full right now. Email " + MAILTO + " and Scott will find you a day.";
const ERR_MSG = "Couldn’t reach the booking calendar. Give it a minute and try again.";
const MIN_HOURS = 2;
const MAX_HOURS = 12;
const DEFAULT_HOURS = 4;
const MAX_DAYS = 21;
const MIN_FILL_MS = 3000; // faster than this from page open = a bot // same as the Squarespace block: the next 21 open days
// Weekday sessions can start from 4 pm (Scott, Oct 2026). The calendar web app still opens weekday
// evenings at 6 pm, so a weekday whose first window opens exactly at 6 pm is offered from 4 pm too.
// Once the web app itself opens at 4 pm this is a no-op. Earlier than 4 pm: ask in the notes.
export const WEEKDAY_OPEN_MIN = 16 * 60;
const OLD_WEEKDAY_OPEN_MIN = 18 * 60;

type Window = { startMin: number; endMin: number };
type Day = { date: string; windows: Window[] };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONFULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// All wall-clock string math, as in the original: no time-zone drift.
const minutesOf = (isoLocal: string) => Number(isoLocal.slice(11, 13)) * 60 + Number(isoLocal.slice(14, 16));
export function fmtHour(h: number) {
  const ap = h < 12 ? "am" : "pm";
  let d = h % 12;
  if (d === 0) d = 12;
  return d + ":00 " + ap;
}
export function fmtLongDate(dstr: string) {
  const y = +dstr.slice(0, 4), m = +dstr.slice(5, 7), d = +dstr.slice(8, 10);
  const wd = new Date(y, m - 1, d).getDay();
  return DOW[wd] + ", " + MON[m - 1] + " " + d + ", " + y;
}
/** Mon–Fri days: a first window that opens at the old 6 pm start opens at 4 pm instead. */
export function withWeekdayHours(day: Day): Day {
  const y = +day.date.slice(0, 4), m = +day.date.slice(5, 7), d = +day.date.slice(8, 10);
  const dow = new Date(y, m - 1, d).getDay();
  if (dow === 0 || dow === 6 || !day.windows.length) return day;
  const [first, ...rest] = [...day.windows].sort((a, b) => a.startMin - b.startMin);
  if (first.startMin !== OLD_WEEKDAY_OPEN_MIN) return day;
  return { ...day, windows: [{ ...first, startMin: WEEKDAY_OPEN_MIN }, ...rest] };
}

export function startHoursFor(day: Day, reqHours: number) {
  const out: number[] = [];
  day.windows.forEach((w) => {
    const first = Math.ceil(w.startMin / 60);
    const last = Math.floor((w.endMin - reqHours * 60) / 60);
    for (let h = first; h <= last; h++) if (!out.includes(h)) out.push(h);
  });
  return out.sort((a, b) => a - b);
}

export function initBooking() {
  const root = document.getElementById("hbh-booking");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>("#" + id)!;

  const daysEl = $("hbh-days");
  const timesEl = $("hbh-times");
  const calTitle = $("hbh-cal-title");
  const prevBtn = $<HTMLButtonElement>("hbh-prev");
  const nextBtn = $<HTMLButtonElement>("hbh-next");
  const availMsg = $("hbh-avail-msg");
  const formEl = $<HTMLFormElement>("hbh-form");
  const formMsg = $("hbh-form-msg");
  const submitBtn = $<HTMLButtonElement>("hbh-submit");
  const hoursOut = $("hbh-hours-out");
  const hoursDec = $<HTMLButtonElement>("hbh-hours-dec");
  const hoursInc = $<HTMLButtonElement>("hbh-hours-inc");
  const summary = $("hbh-summary-text");
  const doneEl = $("hbh-done");
  const pickerEl = $("hbh-picker");

  let days: Day[] = [];
  let selDate: string | null = null;
  let selHour: number | null = null;
  let hours = DEFAULT_HOURS;
  let calMonth: string | null = null;
  let months: string[] = [];
  let busy = false;
  const openedAt = Date.now();
  const ctrl = new AbortController();
  document.addEventListener("astro:before-swap", () => ctrl.abort(), { once: true });

  const showMsg = (el: HTMLElement, html: string) => { el.innerHTML = html; el.hidden = false; };
  const hideMsg = (el: HTMLElement) => { el.hidden = true; };

  /* ---------- session length ---------- */
  function renderHours() {
    hoursOut.innerHTML = hours + "<small>hours</small>";
    hoursDec.disabled = hours <= MIN_HOURS;
    hoursInc.disabled = hours >= MAX_HOURS;
  }
  hoursDec.addEventListener("click", () => { if (hours > MIN_HOURS) { hours--; renderHours(); renderTimes(); } });
  hoursInc.addEventListener("click", () => { if (hours < MAX_HOURS) { hours++; renderHours(); renderTimes(); } });

  function renderSummary() {
    summary.textContent = selDate && selHour !== null
      ? fmtLongDate(selDate) + " · " + fmtHour(selHour) + " · " + hours + " hours"
      : selDate ? fmtLongDate(selDate) + " · pick a start time" : "Pick a day and start time";
  }

  /* ---------- availability ---------- */
  function loadAvailability(keepMsg = false) {
    if (!keepMsg) hideMsg(availMsg);
    daysEl.innerHTML = '<div class="bk-skel"></div>';
    timesEl.innerHTML = '<p class="bk-times-empty">Loading open times…</p>';

    fetch(ENDPOINT, { signal: ctrl.signal }) // plain GET, no custom headers
      .then((r) => r.json())
      .then((data) => {
        if (!data || !data.ok) throw new Error("bad payload");
        days = (data.days || []).slice(0, MAX_DAYS).map((d: any) => ({
          date: String(d.date),
          windows: (d.windows || []).map((w: any) => ({ startMin: minutesOf(w.start), endMin: minutesOf(w.end) })),
        })).filter((d: Day) => d.windows.length).map(withWeekdayHours);

        if (!days.length) {
          daysEl.innerHTML = "";
          calTitle.textContent = "";
          timesEl.innerHTML = '<p class="bk-times-empty">No open times</p>';
          showMsg(availMsg, FULL_MSG);
          return;
        }
        if (!selDate || !days.some((d) => d.date === selDate)) { selDate = days[0].date; selHour = null; }
        months = [...new Set(days.map((d) => d.date.slice(0, 7)))].sort();
        if (!calMonth || !months.includes(calMonth)) calMonth = selDate.slice(0, 7);
        renderCal();
        renderTimes();
      })
      .catch((err) => {
        if (err && err.name === "AbortError") return;
        daysEl.innerHTML = "";
        timesEl.innerHTML = '<p class="bk-times-empty">—</p>';
        showMsg(availMsg, ERR_MSG + ' <button type="button" class="bk-time" id="hbh-retry" style="display:block;padding:0 18px;margin-top:10px">Retry</button>');
        availMsg.querySelector("#hbh-retry")?.addEventListener("click", () => loadAvailability());
      });
  }

  function renderCal() {
    if (!calMonth) return;
    const y = +calMonth.slice(0, 4), m = +calMonth.slice(5, 7);
    calTitle.textContent = MONFULL[m - 1] + " " + y;
    const idx = months.indexOf(calMonth);
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx === -1 || idx >= months.length - 1;

    const open = new Set(days.filter((d) => d.date.startsWith(calMonth!)).map((d) => d.date));
    const frag = document.createDocumentFragment();
    const firstDow = new Date(y, m - 1, 1).getDay();
    const numDays = new Date(y, m, 0).getDate();
    for (let i = 0; i < firstDow; i++) {
      const pad = document.createElement("span");
      pad.className = "bk-cell";
      pad.setAttribute("aria-hidden", "true");
      frag.appendChild(pad);
    }
    for (let dnum = 1; dnum <= numDays; dnum++) {
      const dstr = calMonth + "-" + String(dnum).padStart(2, "0");
      if (open.has(dstr)) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bk-cell";
        b.textContent = String(dnum);
        b.dataset.date = dstr;
        b.setAttribute("aria-pressed", dstr === selDate ? "true" : "false");
        b.setAttribute("aria-label", fmtLongDate(dstr) + ", open");
        b.addEventListener("click", () => {
          selDate = dstr; selHour = null;
          renderCal(); renderTimes(); hideMsg(formMsg);
          root!.querySelector<HTMLButtonElement>(`.bk-cell[data-date="${dstr}"]`)?.focus({ preventScroll: true });
          // On a phone the start times sit below the fold: bring them up.
          if (matchMedia("(max-width: 760px)").matches) {
            const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
            timesEl.closest(".tf-field")?.previousElementSibling?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
          }
        });
        frag.appendChild(b);
      } else {
        const s = document.createElement("span");
        s.className = "bk-cell";
        s.textContent = String(dnum);
        s.setAttribute("aria-hidden", "true");
        frag.appendChild(s);
      }
    }
    daysEl.replaceChildren(frag);
  }

  prevBtn.addEventListener("click", () => {
    const i = months.indexOf(calMonth!);
    if (i > 0) { calMonth = months[i - 1]; renderCal(); }
  });
  nextBtn.addEventListener("click", () => {
    const i = months.indexOf(calMonth!);
    if (i !== -1 && i < months.length - 1) { calMonth = months[i + 1]; renderCal(); }
  });

  function renderTimes() {
    const day = days.find((d) => d.date === selDate);
    timesEl.replaceChildren();
    if (!day) {
      timesEl.innerHTML = '<p class="bk-times-empty">Pick a day first</p>';
      selHour = null; renderSummary();
      return;
    }
    const starts = startHoursFor(day, hours);
    if (!starts.length) {
      timesEl.innerHTML = '<p class="bk-times-empty">No ' + hours + "-hour openings that day. Try a shorter session or another day.</p>";
      selHour = null; renderSummary();
      return;
    }
    if (selHour !== null && !starts.includes(selHour)) selHour = null;
    if (selHour === null && starts.length === 1) selHour = starts[0]; // one choice: take it
    starts.forEach((h) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bk-time";
      b.textContent = fmtHour(h);
      b.setAttribute("aria-pressed", h === selHour ? "true" : "false");
      b.addEventListener("click", () => {
        selHour = h;
        timesEl.querySelectorAll(".bk-time").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
        hideMsg(formMsg);
        renderSummary();
      });
      timesEl.appendChild(b);
    });
    renderSummary();
  }

  /* ---------- inline validation (same rules as the Squarespace block) ---------- */
  const rules: Record<string, (v: string) => boolean> = {
    "hbh-name": (v) => v.length > 1,
    "hbh-email": (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    "hbh-phone": (v) => v.replace(/\D/g, "").length >= 7,
    "hbh-project": (v) => v.length > 2,
    "hbh-num": (v) => Number(v) >= 1,
  };
  const field = (id: string) => $<HTMLInputElement | HTMLTextAreaElement>(id);
  function check(id: string) {
    const el = field(id);
    const ok = rules[id](el.value.trim());
    if (ok) el.removeAttribute("aria-invalid"); else el.setAttribute("aria-invalid", "true");
    return ok;
  }
  Object.keys(rules).forEach((id) => {
    const el = field(id);
    el.addEventListener("blur", () => { if (el.value.trim() || el.dataset.touched) { el.dataset.touched = "1"; check(id); } });
    el.addEventListener("input", () => { if (el.getAttribute("aria-invalid")) check(id); });
  });

  /* ---------- submit ---------- */
  formEl.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy) return;
    hideMsg(formMsg);

    let firstBad: HTMLElement | null = null;
    for (const id of Object.keys(rules)) {
      if (!check(id) && !firstBad) firstBad = field(id);
    }
    if (firstBad) {
      showMsg(formMsg, "A couple of fields need a look. They’re marked above.");
      firstBad.focus();
      return;
    }
    if (!selDate || selHour === null) {
      showMsg(formMsg, "Pick a day and start time above first.");
      pickerEl.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    const startIso = selDate + "T" + String(selHour).padStart(2, "0") + ":00";
    const payload = {
      name: field("hbh-name").value.trim(),
      email: field("hbh-email").value.trim(),
      phone: field("hbh-phone").value.trim(),
      project: field("hbh-project").value.trim(),
      musicians: field("hbh-musicians").value.trim(),
      numMusicians: field("hbh-num").value.trim(),
      hours: hours,
      start: startIso,
      company: field("hbh-company").value, // honeypot passthrough
    };
    const bookedDate = selDate, bookedHour = selHour, bookedHours = hours;

    const showDone = (id?: string) => {
      $("hbh-done-detail").textContent = fmtLongDate(bookedDate) + " at " + fmtHour(bookedHour) + " · " + bookedHours + " hours";
      if (id) {
        const ref = $("hbh-done-ref");
        ref.textContent = "Reference " + id;
        ref.hidden = false;
      }
      formEl.hidden = true;
      pickerEl.hidden = true;
      doneEl.hidden = false;
      doneEl.scrollIntoView({ behavior: "smooth", block: "center" });
      doneEl.focus({ preventScroll: true });
    };

    // Bot traps, checked before anything is sent: a filled honeypot, or a form
    // completed faster than a person could (under MIN_FILL_MS since the page opened).
    // Bots get the normal success screen and nothing is posted.
    if (payload.company || Date.now() - openedAt < MIN_FILL_MS) {
      showDone();
      return;
    }

    busy = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";

    // Plain-text body on purpose: a JSON Content-Type would trigger a CORS
    // preflight that Apps Script can't answer.
    fetch(ENDPOINT, { method: "POST", body: JSON.stringify(payload) })
      .then((r) => r.json())
      .then((data) => {
        if (!data || !data.ok) {
          const fail: Error & { userMsg?: string } = new Error("bad response");
          fail.userMsg = data && typeof data.error === "string" ? data.error : "";
          throw fail;
        }
        if (data.conflict) {
          selHour = null;
          showMsg(formMsg, "That slot was just taken. Pick another time.");
          loadAvailability(true);
          pickerEl.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        showDone(typeof data.id === "string" ? data.id : "");
        // Analytics: session length and weekday only, never anything typed into the form.
        track("book_submit", `${bookedHours}h ${fmtLongDate(bookedDate).slice(0, 3)}`);
      })
      .catch((err) => {
        if (err && err.userMsg) {
          formMsg.textContent = err.userMsg + " Nothing was booked.";
          formMsg.hidden = false;
          return;
        }
        showMsg(formMsg, "Something hiccuped on our end, and nothing was booked. Please try again, or email " + MAILTO + ".");
      })
      .finally(() => {
        busy = false;
        submitBtn.disabled = false;
        submitBtn.textContent = "Request the date";
      });
  });

  renderHours();
  renderSummary();
  loadAvailability();
}
