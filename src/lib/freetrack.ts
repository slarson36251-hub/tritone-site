/**
 * /free-track sign-up, posting to the free-track Apps Script web app that the
 * Squarespace /free-track code block used (endpoint from the site archive, site-wide.md).
 *
 * The original block's script was not captured in the archive, so the exact body
 * format it used is not on record. To stay compatible with either common Apps Script
 * pattern, the request carries the fields twice, as a CORS "simple request" (no preflight):
 *   - in the query string, so a doPost reading e.parameter.firstName etc. sees them, and
 *   - as a JSON text/plain body, so a doPost doing JSON.parse(e.postData.contents) sees them.
 * Any 2xx answer that is not an explicit {ok:false} counts as success.
 * Fields: firstName, lastName, email (plus `name`, the two joined).
 */

export const ENDPOINT =
  "https://script.google.com/macros/s/AKfycby7DXnYPXt2odT9N5PLVtecmN9ZJNuJFt20iwsX8rMxPHS5TJu6g5QXnfWEO3U2ejI_eA/exec";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function initFreeTrack() {
  const root = document.getElementById("ft-root");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  const screens = {
    form: q("[data-screen=form]"),
    tip: q("[data-screen=tip]"),
    thanks: q("[data-screen=thanks]"),
  };
  const go = (name: keyof typeof screens) => {
    (Object.keys(screens) as (keyof typeof screens)[]).forEach((k) => (screens[k].hidden = k !== name));
    const h = screens[name].querySelector<HTMLElement>("h1, h2");
    h?.setAttribute("tabindex", "-1");
    h?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  };

  const form = q<HTMLFormElement>("#ft-form");
  const first = q<HTMLInputElement>("#ft-first");
  const last = q<HTMLInputElement>("#ft-last");
  const email = q<HTMLInputElement>("#ft-email");
  const msg = q("#ft-msg");
  const btn = q<HTMLButtonElement>("#ft-submit");
  let busy = false;
  const openedAt = Date.now();
  const hp = q<HTMLInputElement>("#ft-company");

  const rules: [HTMLInputElement, (v: string) => boolean][] = [
    [first, (v) => v.length > 0],
    [email, (v) => EMAIL_RE.test(v)],
  ];
  const check = (el: HTMLInputElement, test: (v: string) => boolean) => {
    const ok = test(el.value.trim());
    if (ok) el.removeAttribute("aria-invalid"); else el.setAttribute("aria-invalid", "true");
    return ok;
  };
  rules.forEach(([el, t]) => {
    el.addEventListener("blur", () => { if (el.value.trim()) check(el, t); });
    el.addEventListener("input", () => { if (el.getAttribute("aria-invalid")) check(el, t); });
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy) return;
    msg.hidden = true;
    let bad: HTMLInputElement | null = null;
    for (const [el, t] of rules) if (!check(el, t) && !bad) bad = el;
    if (bad) { bad.focus(); return; }

    // Bot traps: filled honeypot or a sub-3-second fill. Show the normal next screen, send nothing.
    if (hp.value || Date.now() - openedAt < 3000) { go("tip"); return; }

    const data = {
      firstName: first.value.trim(),
      lastName: last.value.trim(),
      email: email.value.trim(),
      name: (first.value.trim() + " " + last.value.trim()).trim(),
    };
    busy = true;
    btn.disabled = true;
    btn.textContent = "Sending…";

    fetch(ENDPOINT + "?" + new URLSearchParams(data).toString(), { method: "POST", body: JSON.stringify(data) })
      .then(async (r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        let body: any = null;
        try { body = await r.json(); } catch { /* a non-JSON 2xx still means the row went in */ }
        if (body && body.ok === false) throw new Error(String(body.error || "rejected"));
        go("tip");
      })
      .catch(() => {
        msg.hidden = false;
        msg.innerHTML = 'That didn’t go through. Try again in a moment, or write to <a href="mailto:scott@tritone-productions.com">scott@tritone-productions.com</a>.';
      })
      .finally(() => {
        busy = false;
        btn.disabled = false;
        btn.textContent = "Get my free track";
      });
  });

  root.querySelectorAll<HTMLAnchorElement>("[data-tip]").forEach((a) => a.addEventListener("click", () => setTimeout(() => go("thanks"), 400)));
  q("[data-skip]").addEventListener("click", () => go("thanks"));
  q("[data-restart]").addEventListener("click", () => { form.reset(); go("form"); });
}
