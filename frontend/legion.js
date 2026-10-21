// Roman Legion presentation: the centurion portrait, his lines, and the small state machine that decides which
// reaction is on screen. Everything here is LOCAL and PRESENTATIONAL: no network, no AI, nothing stored.
//
// PLACEHOLDER ART: the portrait below is a vector illustration drawn in code so the whole feature works with no
// external asset. It is a temporary resource; replace `portraitSvg()` (or point it at final artwork) later —
// the rest of the code only relies on the root class `lg-mood-<mood>` and the part classes listed in style.css.
//
// Real-data hooks that exist but are intentionally NOT wired yet (the real meal schedule, the time a meal was
// eaten and background notifications are a separate piece of work; a photo's upload time is not proof of when
// something was eaten):
//   - reaction("remind", lang, n, { time })       <- will be driven by a user-chosen reminder time
//   - reaction("demand", lang, n)                 <- will be driven by "an expected record is missing"
//   - chipsHtml({ nextMeal, lastLog }, ...)       <- renders the "next meal / last record" chips from real values
// Until then the three states are reachable only through the clearly-labelled demo control.
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

  const MOOD_OF = { idle: "idle", idle_empty: "idle", idle_done: "idle", approve: "approve", remind: "remind", demand: "demand" };

  function reaction(kind, lang, n, vars) {
    const set = LINES[kind];
    if (!set) throw new Error(`unknown reaction: ${kind}`);
    const lines = set[lang] || set.en;
    const raw = lines[Math.abs(n || 0) % lines.length];
    const text = raw.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
    return { kind, mood: MOOD_OF[kind], text };
  }

  // The line shown when nothing special happened, from real totals only (no schedule involved).
  function idleKind({ entries, calories, goal }) {
    if (!entries) return "idle_empty";
    if (goal && calories >= goal) return "idle_done";
    return "idle";
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

  // ---- temporary portrait ----
  // Parts the stylesheet animates/toggles: .lg-crest .lg-head .lg-lids .lg-brow-l .lg-brow-r .lg-pupil
  // .lg-mouth-idle/-approve/-remind/-demand and the props .lg-prop-approve/-remind/-demand.
  function portraitSvg() {
    return `
<svg class="lg-portrait lg-mood-idle" viewBox="0 -36 200 266" role="img" aria-label="" focusable="false">
  <defs>
    <linearGradient id="lgBronze" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#E8C27A"/><stop offset=".45" stop-color="#B8843A"/><stop offset="1" stop-color="#7B5222"/>
    </linearGradient>
    <linearGradient id="lgBronzeDark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#A67430"/><stop offset="1" stop-color="#5E3D17"/>
    </linearGradient>
    <linearGradient id="lgCape" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9B1B26"/><stop offset="1" stop-color="#4E0B12"/>
    </linearGradient>
    <linearGradient id="lgSkin" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#C98E68"/><stop offset=".5" stop-color="#E0AB84"/><stop offset="1" stop-color="#C58A64"/>
    </linearGradient>
    <linearGradient id="lgCrest" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#D5342E"/><stop offset="1" stop-color="#7C0F18"/>
    </linearGradient>
  </defs>
  <path d="M6 230 L16 164 Q40 130 72 142 L128 142 Q160 130 184 164 L194 230 Z" fill="url(#lgCape)"/>
  <path d="M32 230 L40 170 Q70 152 100 158 Q130 152 160 170 L168 230 Z" fill="url(#lgBronzeDark)"/>
  <path d="M46 186 Q100 170 154 186 M44 204 Q100 188 156 204 M42 222 Q100 206 158 222" stroke="#E8C27A" stroke-opacity=".55" stroke-width="2.2" fill="none"/>
  <ellipse cx="46" cy="172" rx="22" ry="12" fill="url(#lgBronze)"/><ellipse cx="154" cy="172" rx="22" ry="12" fill="url(#lgBronze)"/>
  <path d="M82 134 L118 134 L122 164 Q100 176 78 164 Z" fill="#B97B57"/>
  <g class="lg-head">
    <ellipse cx="52" cy="102" rx="6" ry="10" fill="#C58A64"/><ellipse cx="148" cy="102" rx="6" ry="10" fill="#C58A64"/>
    <path d="M56 76 Q56 58 100 56 Q144 58 144 76 L142 108 Q138 140 100 150 Q62 140 58 108 Z" fill="url(#lgSkin)"/>
    <path d="M60 114 Q100 156 140 114 L139 104 Q100 142 61 104 Z" fill="#3B2216" fill-opacity=".22"/>
    <path d="M80 140 Q100 134 120 140" stroke="#3B2216" stroke-opacity=".25" stroke-width="5" fill="none" stroke-linecap="round"/>
    <path d="M98 94 L93 113 Q100 118 107 113 L102 94" stroke="#8D5B3E" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <g class="lg-flush"><ellipse cx="68" cy="112" rx="11" ry="8" fill="#D2362C"/><ellipse cx="132" cy="112" rx="11" ry="8" fill="#D2362C"/></g>
    <path class="lg-scar" d="M66 92 L73 114" stroke="#F1C9A8" stroke-width="2.2" stroke-linecap="round"/>
    <g class="lg-eyes">
      <ellipse cx="80" cy="95" rx="8.5" ry="5.2" fill="#F6EEE6"/><ellipse cx="120" cy="95" rx="8.5" ry="5.2" fill="#F6EEE6"/>
      <circle class="lg-pupil lg-pupil-l" cx="80" cy="95" r="3.4" fill="#2B1B14"/><circle class="lg-pupil lg-pupil-r" cx="120" cy="95" r="3.4" fill="#2B1B14"/>
      <g class="lg-lids"><path d="M70 88 Q80 84 91 88 L91 95 L70 95 Z M109 88 Q120 84 130 88 L130 95 L109 95 Z" fill="#D8A07A"/></g>
    </g>
    <path class="lg-brow lg-brow-l" d="M66 83 Q79 77 93 83" stroke="#2B1B14" stroke-width="5.5" fill="none" stroke-linecap="round"/>
    <path class="lg-brow lg-brow-r" d="M107 83 Q121 77 134 83" stroke="#2B1B14" stroke-width="5.5" fill="none" stroke-linecap="round"/>
    <path class="lg-mouth lg-mouth-idle" d="M84 127 Q100 124 116 128" stroke="#4A2417" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    <g class="lg-mouth lg-mouth-approve"><path d="M83 128 Q102 134 119 120" stroke="#4A2417" stroke-width="3.4" fill="none" stroke-linecap="round"/><path d="M119 120 q4 -1 5 -5" stroke="#8D5B3E" stroke-width="2" fill="none" stroke-linecap="round"/></g>
    <path class="lg-mouth lg-mouth-remind" d="M86 128 L112 126" stroke="#4A2417" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    <g class="lg-mouth lg-mouth-demand"><path d="M85 138 Q100 116 115 138 Q100 147 85 138 Z" fill="#3A0F12"/><path d="M90 132.5 Q100 124 110 132.5 L108.5 135.5 Q100 129 91.5 135.5 Z" fill="#F6EEE6"/><path d="M83 139 q-2 3 -1 6 M117 139 q2 3 1 6" stroke="#4A2417" stroke-width="2.4" fill="none" stroke-linecap="round"/></g>
    <path d="M42 70 Q42 22 100 20 Q158 22 158 70 L148 70 Q142 48 100 46 Q58 48 52 70 Z" fill="url(#lgBronze)"/>
    <path d="M50 60 Q100 38 150 60 L150 70 Q100 52 50 70 Z" fill="url(#lgBronzeDark)"/>
    <path d="M46 64 Q40 104 54 132 L74 124 L68 66 Z" fill="url(#lgBronze)"/><path d="M154 64 Q160 104 146 132 L126 124 L132 66 Z" fill="url(#lgBronze)"/>
    <path class="lg-vein" d="M146 76 l-6 8 l6 4 l-5 8" stroke="#B8352B" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <g class="lg-crest">
      <rect x="90" y="16" width="20" height="9" rx="2" fill="url(#lgBronzeDark)"/>
      <path d="M44 34 Q100 -26 156 34 L150 46 Q100 -2 50 46 Z" fill="url(#lgCrest)"/>
      <path d="M58 32 Q100 -12 142 32 M66 36 Q100 4 134 36 M52 38 Q100 -4 148 38" stroke="#F0645A" stroke-opacity=".5" stroke-width="1.6" fill="none"/>
    </g>
  </g>
  <g class="lg-prop lg-prop-approve">
    <rect x="144" y="170" width="34" height="30" rx="10" fill="#D8A07A"/>
    <path d="M152 172 L152 150 Q152 142 160 144 Q166 146 164 154 L162 170 Z" fill="#E0AB84"/>
    <path d="M150 184 L176 184 M150 191 L176 191" stroke="#B97B57" stroke-width="2" stroke-linecap="round"/>
  </g>
  <g class="lg-prop lg-prop-remind">
    <circle cx="160" cy="178" r="20" fill="url(#lgBronze)"/><circle cx="160" cy="178" r="15" fill="#F3E3C3"/>
    <path class="lg-clock-hand" d="M160 178 L160 167" stroke="#4E0B12" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M160 178 L168 182" stroke="#4E0B12" stroke-width="2.6" stroke-linecap="round"/>
  </g>
  <g class="lg-prop lg-prop-demand">
    <path d="M30 150 l-12 -8 M26 164 l-16 0 M32 136 l-8 -12" stroke="#E0463A" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M170 150 l12 -8 M174 164 l16 0 M168 136 l8 -12" stroke="#E0463A" stroke-width="3.2" stroke-linecap="round"/>
  </g>
</svg>`;
  }

  const api = { MOODS, LINES, reaction, idleKind, chipsHtml, createController, portraitSvg };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CSLegion = api;
})(typeof window !== "undefined" ? window : globalThis);
