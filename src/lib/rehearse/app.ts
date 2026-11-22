// Rehearsal planner page (src/pages/rehearse/[key].astro). Reads the plan baked into the page,
// loads everyone's answers from Firestore (REST, no SDK, no sign-in), saves this player's answers
// as one document a moment after each tap, and polls for the others every 20 s and on return.
import {
  NEXT, answerKey, answersListUrl, blockFor, commitUrl, datesBetween, dayParts, docToAnswers, fmtTime, rank, saveBody, slug, statsFor,
  type Answer, type PlanData, type PlayerAnswers,
} from "./core";

const API_KEY = (import.meta.env.PUBLIC_FEEDBACK_API_KEY as string | undefined)?.trim() || "";
const FETCH_INIT = { credentials: "omit", referrerPolicy: "no-referrer" } as const satisfies RequestInit;
const LBL: Record<Answer, string> = { yes: "Yes", maybe: "Maybe", no: "No" };
const MARK: Record<Answer, string> = { yes: "✓", maybe: "?", no: "✕" };
const POLL_MS = 20_000;

const ls = {
  get(k: string) { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function initRehearse() {
  const root = document.getElementById("rh");
  const planEl = document.getElementById("rh-plan");
  if (!root || !planEl || root.dataset.ready) return;
  root.dataset.ready = "1";
  const plan: PlanData = JSON.parse(planEl.textContent || "{}");
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dates = datesBetween(plan.from, plan.to);
  const valid = new Set(dates.flatMap((d) => plan.slots.map((s) => answerKey(d, s.id))));
  const whoKey = `tritone:rehearse:${plan.key}:who`;

  let all: Record<string, PlayerAnswers> = {};
  let who = ls.get(whoKey);
  if (!plan.roster.some((p) => slug(p.name) === who)) who = "";
  let dirty = false; // my edits not yet confirmed by the server
  let saving = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let loaded = false;

  const status = (msg: string) => { const s = $("rh-status"); s.hidden = !msg; s.textContent = msg; };
  const saveMsg = (msg: string) => { $("rh-save").textContent = msg; };
  const mine = (): PlayerAnswers => {
    const p = plan.roster.find((x) => slug(x.name) === who)!;
    return (all[who] ??= { name: p.name, answers: {}, note: "" });
  };

  /* ------------------------------------------------------------ my times ------------------------------------------------------------ */
  function renderWho() {
    const sel = $<HTMLSelectElement>("rh-who");
    sel.replaceChildren(new Option("Pick your name", ""));
    plan.roster.forEach((p) => {
      const o = new Option(p.name + (p.role ? ` (${p.role})` : ""), slug(p.name));
      o.selected = slug(p.name) === who;
      sel.add(o);
    });
  }

  function renderMe() {
    const box = $("rh-days");
    const my = who ? all[who]?.answers ?? {} : {};
    const note = $<HTMLInputElement>("rh-note");
    note.disabled = !who;
    if (document.activeElement !== note) note.value = (who && all[who]?.note) || "";
    const frag = document.createDocumentFragment();
    for (const date of dates) {
      const { dow, md } = dayParts(date);
      const row = el("div", "rh-day");
      const d = el("div", "rh-d");
      d.append(el("b", "", dow), el("small", "", md));
      const slots = el("div", "rh-slots");
      slots.style.setProperty("--n", String(plan.slots.length));
      for (const s of plan.slots) {
        const blk = blockFor(plan.blocks, date, s);
        const v = my[answerKey(date, s.id)];
        const b = el("button", `rh-slot ${blk ? "blk" : v ?? ""}`);
        b.type = "button";
        b.append(el("span", "t", s.label), el("span", "s", blk ? blk.label : v ? LBL[v] : "—"));
        b.setAttribute("aria-label", `${dow} ${md}, ${s.label} ${fmtTime(s.start)} to ${fmtTime(s.end)}: ${blk ? `blocked, ${blk.label}` : v ? LBL[v] : "not answered"}`);
        if (blk || !who) b.disabled = true;
        else b.addEventListener("click", () => cycle(date, s.id));
        slots.append(b);
      }
      row.append(d, slots);
      const others = plan.slots
        .filter((s) => !blockFor(plan.blocks, date, s))
        .map((s) => {
          const n = statsFor(plan.roster.filter((p) => slug(p.name) !== who), all, date, s.id).yes.length;
          return n ? `${s.label}: ${n} yes` : "";
        })
        .filter(Boolean);
      if (others.length) row.append(el("div", "rh-others", `Others so far · ${others.join(" · ")}`));
      frag.append(row);
    }
    box.replaceChildren(frag);
    if (!who) saveMsg("Pick your name above to start marking times.");
  }

  function cycle(date: string, slotId: string) {
    const m = mine();
    const k = answerKey(date, slotId);
    const nv = NEXT[m.answers[k] ?? ""];
    if (nv) m.answers[k] = nv;
    else delete m.answers[k];
    renderMe();
    queueSave();
  }

  /* ------------------------------------------------------------ saving ------------------------------------------------------------ */
  function queueSave() {
    dirty = true;
    if (!API_KEY) { saveMsg("Preview build: answers aren't saved here."); return; }
    saveMsg("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 800);
  }
  async function flush() {
    if (!who || !API_KEY) return;
    if (saving) { saveTimer = setTimeout(flush, 400); return; }
    saving = true;
    const snapshot = JSON.stringify(mine());
    try {
      const res = await fetch(commitUrl(API_KEY), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(saveBody(plan.key, who, mine())), ...FETCH_INIT,
      });
      if (!res.ok) throw new Error(String(res.status));
      if (JSON.stringify(mine()) === snapshot) dirty = false;
      saveMsg("Saved. The band sees this now.");
    } catch {
      saveMsg("Couldn't save just now. Your taps are kept on this screen; we'll try again in a moment.");
      saveTimer = setTimeout(flush, 5000);
    } finally {
      saving = false;
    }
  }

  /* ------------------------------------------------------------ band grid ------------------------------------------------------------ */
  function renderGrid() {
    const R = plan.roster, N = R.length;
    const hide = $("rh-hide").getAttribute("aria-pressed") === "true";
    const answered = R.filter((p) => Object.keys(all[slug(p.name)]?.answers ?? {}).length).length;
    $("rh-answered").textContent = `${answered} of ${N} players have marked times. Ranked by yes, then maybe. A "no" moves a time down the list.`;

    const best = $("rh-best");
    const top = rank(plan, all).filter((x) => x.st.yes.length + x.st.maybe.length > 0).slice(0, 3);
    best.replaceChildren();
    if (!top.length) {
      const c = el("div", "rh-card");
      c.append(el("b", "", "No answers yet"), el("span", "c", "As players mark times, the strongest three show up here."));
      best.append(c);
    }
    top.forEach((x, i) => {
      const { dow, md } = dayParts(x.date);
      const c = el("div", `rh-card${i === 0 && x.st.yes.length === N ? " top" : ""}`);
      const bar = el("div", "rh-bar");
      (["yes", "maybe", "no"] as const).forEach((k) => {
        const seg = el("i", k);
        seg.style.width = `${(x.st[k].length / N) * 100}%`;
        bar.append(seg);
      });
      c.append(
        el("b", "", `${dow} ${md}`),
        el("span", "", `${x.slot.label} · ${fmtTime(x.slot.start)}–${fmtTime(x.slot.end)}`),
        bar,
        el("span", "c", `${x.st.yes.length} yes · ${x.st.maybe.length} maybe · ${x.st.no.length} no · ${x.st.waiting.length} waiting`),
      );
      if (x.st.waiting.length) c.append(el("span", "c", `Waiting on ${x.st.waiting.map((n) => n.split(" ")[0]).join(", ")}`));
      if (x.st.no.length) c.append(el("span", "c", `Can't make it: ${x.st.no.map((n) => n.split(" ")[0]).join(", ")}`));
      best.append(c);
    });

    const table = $("rh-grid");
    const thead = el("thead"), hr = el("tr");
    hr.append(el("th", "row", "Date / time"));
    R.forEach((p) => {
      const th = el("th", `who${slug(p.name) === who ? " me" : ""}`, p.name.split(" ")[0]);
      th.title = p.name;
      th.scope = "col";
      hr.append(th);
    });
    hr.append(el("th", "", "Yes"));
    thead.append(hr);
    const tbody = el("tbody");
    for (const date of dates) {
      const { dow, md } = dayParts(date);
      let first = true;
      for (const s of plan.slots) {
        const blk = blockFor(plan.blocks, date, s);
        if (blk && hide) continue;
        const st = statsFor(R, all, date, s.id);
        const tr = el("tr", `${blk ? "blk" : ""}${first ? " daystart" : ""}`);
        const th = el("th", "row");
        th.scope = "row";
        if (first) th.append(`${dow} ${md}`);
        th.append(el("small", "", `${s.label} ${fmtTime(s.start)}`));
        tr.append(th);
        R.forEach((p) => {
          const td = el("td", "c");
          if (!blk) {
            const v = all[slug(p.name)]?.answers?.[answerKey(date, s.id)];
            const sp = el("span", v ?? "none", v ? MARK[v] : "");
            sp.setAttribute("aria-label", `${p.name}: ${v ? LBL[v] : "no answer"}`);
            td.append(sp);
          }
          tr.append(td);
        });
        tr.append(el("td", "sum", blk ? blk.label : `${st.yes.length}/${N}`));
        tbody.append(tr);
        first = false;
      }
    }
    table.replaceChildren(thead, tbody);

    const notes = R.map((p) => ({ n: p.name, t: all[slug(p.name)]?.note ?? "" })).filter((x) => x.t);
    const nb = $("rh-notes");
    nb.hidden = !notes.length;
    nb.replaceChildren(...notes.map((x) => { const d = el("div"); d.append(el("b", "", `${x.n}: `), x.t); return d; }));
  }

  /* ------------------------------------------------------------ loading ------------------------------------------------------------ */
  async function load() {
    if (!API_KEY) { status("Preview build: shared answers aren't loaded here."); return; }
    try {
      const next: Record<string, PlayerAnswers> = {};
      let token = "";
      for (let page = 0; page < 5; page++) {
        const res = await fetch(answersListUrl(plan.key, API_KEY, token), FETCH_INIT);
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        for (const d of body?.documents ?? []) {
          const pair = docToAnswers(d, valid);
          if (pair && plan.roster.some((p) => slug(p.name) === pair[0])) next[pair[0]] = pair[1];
        }
        token = body?.nextPageToken ?? "";
        if (!token) break;
      }
      if (who && (dirty || saving) && all[who]) next[who] = all[who]; // keep my unsaved taps
      all = next;
      loaded = true;
      status("");
      renderAll();
    } catch {
      status(loaded ? "Couldn't refresh the band's answers. What you see may be a minute old." : "Couldn't load the band's answers yet. Check your connection; this page keeps trying.");
    }
  }

  const view = () => ($("rh-grid-view").hidden ? "me" : "grid");
  function renderAll() {
    renderMe();
    if (view() === "grid") renderGrid();
  }
  function show(v: "me" | "grid") {
    $("rh-me").hidden = v !== "me";
    $("rh-grid-view").hidden = v !== "grid";
    $("rh-tab-me").setAttribute("aria-selected", String(v === "me"));
    $("rh-tab-grid").setAttribute("aria-selected", String(v === "grid"));
    ls.set("tritone:rehearse:tab", v);
    if (v === "grid") renderGrid();
  }

  $("rh-tab-me").addEventListener("click", () => show("me"));
  $("rh-tab-grid").addEventListener("click", () => show("grid"));
  $<HTMLSelectElement>("rh-who").addEventListener("change", (e) => {
    who = (e.target as HTMLSelectElement).value;
    ls.set(whoKey, who);
    saveMsg("");
    renderAll();
  });
  $<HTMLInputElement>("rh-note").addEventListener("input", (e) => {
    if (!who) return;
    mine().note = (e.target as HTMLInputElement).value;
    queueSave();
  });
  $("rh-hide").addEventListener("click", (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    b.textContent = on ? "Show blocked times" : "Hide blocked times";
    renderGrid();
  });

  const at = new Date(plan.busyAt);
  if (!isNaN(at.getTime())) {
    const t = at.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    $("rh-updated").textContent = `All times Pacific. Blocked times checked ${t}.`;
  }

  renderWho();
  renderAll();
  show(ls.get("tritone:rehearse:tab") === "grid" ? "grid" : "me");
  load();
  const poll = setInterval(() => { if (document.visibilityState === "visible" && !saving) load(); }, POLL_MS);
  const onVis = () => { if (document.visibilityState === "visible") load(); };
  document.addEventListener("visibilitychange", onVis);
  document.addEventListener("astro:before-swap", () => { clearInterval(poll); document.removeEventListener("visibilitychange", onVis); }, { once: true });
}
