// "Request an earlier time": opens the small form under the time picker and sends it to the
// booking web app as type "request". Scott gets it by email; nothing goes on the calendar.
import { ENDPOINT } from "./booking";
import { buildTimeRequest, isoDay } from "./booking-request-core";

const MIN_FILL_MS = 3000; // faster than this from opening the form = a bot

export function initTimeRequest() {
  const openBtn = document.getElementById("hbh-req-open") as HTMLButtonElement | null;
  const form = document.getElementById("hbh-req") as HTMLFormElement | null;
  if (!openBtn || !form || form.dataset.ready) return;
  form.dataset.ready = "1";

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const msg = $<HTMLElement>("hbh-req-msg");
  const done = $<HTMLElement>("hbh-req-done");
  const submit = $<HTMLButtonElement>("hbh-req-submit");
  const date = $<HTMLInputElement>("hbh-req-date");
  let openedAt = 0;
  let busy = false;

  date.min = isoDay(new Date(Date.now() + 864e5));

  // Clear a field's error as soon as it's edited.
  form.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.getAttribute("aria-invalid") !== "true") return;
    t.setAttribute("aria-invalid", "false");
    document.getElementById(`${t.id}-err`)?.classList.remove("is-on");
  });

  openBtn.addEventListener("click", () => {
    const open = form.hidden;
    form.hidden = !open;
    done.hidden = true;
    openBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      openedAt = Date.now();
      // Carry over what's already typed in the main form.
      for (const k of ["name", "email", "phone"]) {
        const from = document.getElementById(`hbh-${k}`) as HTMLInputElement | null;
        const to = $<HTMLInputElement>(`hbh-req-${k}`);
        if (from?.value && !to.value) to.value = from.value;
      }
      form.scrollIntoView({ behavior: "smooth", block: "nearest" });
      $<HTMLInputElement>("hbh-req-name").focus({ preventScroll: true });
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) return;
    msg.hidden = true;
    const val = (id: string) => ($<HTMLInputElement>(`hbh-req-${id}`).value ?? "");
    const res = buildTimeRequest({
      name: val("name"), email: val("email"), phone: val("phone"), date: val("date"),
      time: val("time"), hours: val("hours"), note: val("note"), company: val("company"),
    });

    for (const k of ["name", "email", "date", "time", "hours", "note"]) {
      const input = $<HTMLInputElement>(`hbh-req-${k}`);
      const err = document.getElementById(`hbh-req-${k}-err`);
      const text = res.ok ? "" : res.errors[k as keyof typeof res.errors] ?? "";
      input.setAttribute("aria-invalid", text ? "true" : "false");
      if (err) { err.textContent = text; err.classList.toggle("is-on", !!text); }
    }
    if (!res.ok) {
      ($<HTMLInputElement>(`hbh-req-${Object.keys(res.errors)[0]}`)).focus();
      return;
    }

    const showDone = () => {
      form.hidden = true;
      openBtn.setAttribute("aria-expanded", "false");
      done.hidden = false;
      done.focus({ preventScroll: true });
    };
    // Bots: a filled honeypot or an instant submit get the normal thank-you and nothing is sent.
    if (res.payload.company || Date.now() - openedAt < MIN_FILL_MS) { showDone(); return; }

    busy = true;
    submit.disabled = true;
    submit.textContent = "Sending…";
    // Plain-text body on purpose: a JSON Content-Type would trigger a CORS preflight Apps Script can't answer.
    fetch(ENDPOINT, { method: "POST", body: JSON.stringify(res.payload) })
      .then((r) => r.json())
      .then((data) => {
        if (!data || !data.ok) throw Object.assign(new Error("bad response"), { userMsg: data?.error });
        showDone();
      })
      .catch((err) => {
        msg.textContent = (typeof err?.userMsg === "string" && err.userMsg ? err.userMsg + " " : "Something hiccuped on our end. ") +
          "Nothing was sent. You can also write to scott@tritone-productions.com.";
        msg.hidden = false;
      })
      .finally(() => {
        busy = false;
        submit.disabled = false;
        submit.textContent = "Send the request";
      });
  });
}
