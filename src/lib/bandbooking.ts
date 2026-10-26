/**
 * /book-a-band request form. The Book the Hut web app can't take these: it needs a studio
 * start time and session length, and every request it accepts holds a day on the studio
 * calendar. So this form writes the request up as a prefilled email to Scott (mailto:), which
 * the visitor sends from their own mail app. Nothing is posted anywhere from the page.
 */

import { track } from "./track";

export const BAND_EMAIL = "scott@tritone-productions.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type BandRequest = { occasion: string; date: string; where: string; band: string; notes: string; name: string; email: string };

/** The mailto: link for a request: subject "Band booking: Wedding · June 14", body one line per field. */
export function bandMailto(r: BandRequest) {
  const subject = ["Band booking: " + (r.occasion || "event"), r.date].filter(Boolean).join(" · ");
  const lines = [
    "Occasion: " + (r.occasion || "-"),
    "Date: " + (r.date || "-"),
    "Where: " + (r.where || "-"),
    "Band: " + (r.band || "Help me pick"),
    "",
    r.notes,
    "",
    r.name,
    r.email,
  ];
  return "mailto:" + BAND_EMAIL + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(lines.join("\n"));
}

export function initBandBooking() {
  const root = document.getElementById("bb-root");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>("#" + id)!;
  const form = $<HTMLFormElement>("bb-form");
  const msg = $("bb-msg");
  const done = $("bb-done");
  const again = $<HTMLAnchorElement>("bb-again");

  const rules: Record<string, (v: string) => boolean> = {
    "bb-notes": (v) => v.length > 2,
    "bb-name": (v) => v.length > 1,
    "bb-email": (v) => EMAIL_RE.test(v),
  };
  const field = (id: string) => $<HTMLInputElement | HTMLTextAreaElement>(id);
  const val = (id: string) => field(id).value.trim();
  function check(id: string) {
    const ok = rules[id](val(id));
    if (ok) field(id).removeAttribute("aria-invalid"); else field(id).setAttribute("aria-invalid", "true");
    return ok;
  }
  Object.keys(rules).forEach((id) => {
    const el = field(id);
    el.addEventListener("blur", () => { if (el.value.trim() || el.dataset.touched) { el.dataset.touched = "1"; check(id); } });
    el.addEventListener("input", () => { if (el.getAttribute("aria-invalid")) check(id); });
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    msg.hidden = true;
    let firstBad: HTMLElement | null = null;
    for (const id of Object.keys(rules)) if (!check(id) && !firstBad) firstBad = field(id);
    if (firstBad) {
      msg.textContent = "A couple of fields need a look. They’re marked above.";
      msg.hidden = false;
      firstBad.focus();
      return;
    }
    const occasion = form.querySelector<HTMLInputElement>('input[name="occasion"]:checked')?.value ?? "";
    const href = bandMailto({
      occasion, date: val("bb-date"), where: val("bb-where"), band: $<HTMLSelectElement>("bb-band").value,
      notes: val("bb-notes"), name: val("bb-name"), email: val("bb-email"),
    });
    again.href = href;
    track("contact_click", "band form"); // never anything typed into the form
    window.location.href = href;
    form.hidden = true;
    done.hidden = false;
    done.scrollIntoView({ behavior: "smooth", block: "center" });
    done.focus({ preventScroll: true });
  });
}
