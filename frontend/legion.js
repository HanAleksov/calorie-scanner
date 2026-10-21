// Roman Legion presentation: the centurion's portraits, his lines, and the small state machine that decides which
// reaction is on screen. Everything here is LOCAL and PRESENTATIONAL: no network, no AI, nothing stored.
//
// PLACEHOLDER ART: the four portraits are temporary SVG files in frontend/legion/ (see its README for the spec of
// the final ones). To use final artwork replace those files, or change the four paths in ASSETS; nothing else
// depends on how they look. Moods are shown by cross-fading between the four <img> elements.
//
// Real-data hooks that exist but are intentionally NOT wired yet (the real meal schedule, the time a meal was
// eaten and background notifications are a separate piece of work; a photo's upload time is not proof of when
// something was eaten):
//   - reaction("remind", lang, n, { time })       <- will be driven by a user-chosen reminder time
//   - reaction("demand", lang, n)                 <- will be driven by "an expected record is missing"
//   - chipsHtml({ nextMeal, lastLog }, ...)       <- renders the "next meal / last record" chips from real values
// Until then those two reactions are reachable only through the clearly-labelled reaction preview in Settings.
(function (root) {
  "use strict";

  const MOODS = ["idle", "approve", "remind", "demand"];

  // Lines are deterministic (index = a counter, never Math.random) so tests and screenshots are repeatable.
  const LINES = {
    idle: {
      bg: ["Имаш план. Спазвай го.", "Редът е прост: храна, вода, дисциплина."],
      en: ["You have a plan. Stick to it.", "The order is simple: food, water, discipline."],
    },
    idle_empty: {
      bg: ["Още няма доклад за днес. Строят чака, легионер."],
      en: ["No report yet today. The ranks are waiting, legionary."],
    },
    idle_done: {
      bg: ["Нормата е изпълнена. Почивай по устав."],
      en: ["Quota met. Stand easy."],
    },
    idle_over: {
      bg: ["Над нормата за днес. Утре отново в строя."],
      en: ["Over today's quota. Back in formation tomorrow."],
    },
    approve: {
      bg: [
        "Приемам доклада. Така се печелят войни, легионер.",
        "Записано. Стомахът ти най-после изпълни заповедта.",
        "Одобрявам. Не го казвам често — запомни момента.",
      ],
      en: [
        "Report accepted. This is how wars are won, legionary.",
        "Logged. Your stomach finally followed orders.",
        "Approved. I rarely say it, so remember this moment.",
      ],
    },
    remind: {
      bg: [
        "В {time} те чака храна. Не закъснявай, легионер — гладът не прощава.",
        "Остава малко до {time}. Приборите — готови, без извинения.",
        "{time} е близо. Легионер, който пропуска храна, пропуска и битката.",
      ],
      en: [
        "Food waits for you at {time}. Don't be late, legionary — hunger forgives nothing.",
        "{time} is close. Cutlery ready, no excuses.",
        "{time} approaches. A legionary who skips a meal skips the battle.",
      ],
    },
    demand: {
      bg: [
        "Няма доклад, легионер. Яде ли, или чакаш специална заповед?",
        "Тишина по линията. Или си гладувал, или си забравил да докладваш. И двете са проблем.",
        "Къде е записът? Армията не воюва със статистика от въздуха.",
      ],
      en: [
        "No report, legionary. Did you eat, or are you waiting for a special order?",
        "Silence on the line. Either you starved or forgot to report. Both are a problem.",
        "Where is the record? An army doesn't fight on statistics from thin air.",
      ],
    },
  };

  const MOOD_OF = { idle: "idle", idle_empty: "idle", idle_done: "idle", idle_over: "idle", approve: "approve", remind: "remind", demand: "demand" };

  function reaction(kind, lang, n, vars) {
    const set = LINES[kind];
    if (!set) throw new Error(`unknown reaction: ${kind}`);
    const lines = set[lang] || set.en;
    const raw = lines[Math.abs(n || 0) % lines.length];
    const text = raw.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
    return { kind, mood: MOOD_OF[kind], text };
  }

  // The line shown when nothing special happened, from real totals only (no schedule involved).
  // Goal-aware: eating up to or past the target is the point of a "gain" goal, but for "lose"/"maintain" going over
  // is not something to congratulate.
  function idleKind({ entries, calories, goal, goalType }) {
    if (!entries) return "idle_empty";
    if (!goal) return "idle";
    if (goalType === "gain") return calories >= goal ? "idle_done" : "idle";
    if (calories > goal) return "idle_over";
    return calories === goal ? "idle_done" : "idle";
  }

  // "next meal / last record" chips. Both come from real values once they exist; with none, no chips at all.
  function chipsHtml(data, labels, esc) {
    const escape = esc || ((s) => String(s));
    const out = [];
    if (data && data.nextMeal) out.push(`<span class="lg-chip">${escape(labels.next)} · ${escape(data.nextMeal)}</span>`);
    if (data && data.lastLog) out.push(`<span class="lg-chip">${escape(labels.last)} · ${escape(data.lastLog)}</span>`);
    return out.join("");
  }

  // ---- state machine: which reaction is showing; auto-returns to idle; knows whether it is a demo ----
  function createController({ render, setTimer, clearTimer, idleDelayMs }) {
    const wait = idleDelayMs || 7000;
    let current = null;       // { kind, mood, text, demo }
    let timer = null;
    let counter = 0;
    const set = setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clear = clearTimer || ((t) => clearTimeout(t));

    function show(kind, { lang, demo = false, vars, hold = false, ms } = {}) {
      if (timer !== null) { clear(timer); timer = null; }
      const r = reaction(kind, lang || "bg", counter++, vars);
      current = { ...r, demo };
      render(current);
      if (!hold && kind !== "idle" && !kind.startsWith("idle_")) {
        timer = set(() => { timer = null; current = null; render(null); }, ms || wait);
      }
      return current;
    }
    function reset() {
      if (timer !== null) { clear(timer); timer = null; }
      current = null;
      render(null);
    }
    return { show, reset, get current() { return current; } };
  }

  // ---- portraits (temporary placeholder files; see the header comment) ----
  const ASSETS = {
    idle: "/legion/portrait-idle.svg",
    approve: "/legion/portrait-approve.svg",
    remind: "/legion/portrait-remind.svg",
    demand: "/legion/portrait-demand.svg",
  };

  // All four portraits stacked; only the active one is visible, so a mood change is a cross-fade and every file is
  // already loaded when it is needed. `active` is the mood to show first.
  function portraitHtml(active) {
    return MOODS.map((m) =>
      `<img class="lg-img${m === (active || "idle") ? " is-active" : ""}" data-mood="${m}" src="${ASSETS[m]}" alt="" decoding="async" draggable="false">`
    ).join("");
  }

  const api = { MOODS, LINES, ASSETS, reaction, idleKind, chipsHtml, createController, portraitHtml };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CSLegion = api;
})(typeof window !== "undefined" ? window : globalThis);
