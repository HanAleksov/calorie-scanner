// Run: node --test tests/js/*.test.js
// The centurion: lines, moods, the reaction state machine and the guarantees that make him presentation-only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../../frontend/legion.js");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "frontend", f), "utf8");

test("the three required reactions exist in both languages, each with several distinct lines", () => {
  for (const kind of ["approve", "remind", "demand"]) for (const lang of ["bg", "en"]) {
    const lines = L.LINES[kind][lang];
    assert.ok(lines.length >= 3, `${kind}/${lang}`);
    assert.equal(new Set(lines).size, lines.length, `${kind}/${lang} repeats a line`);
  }
});

test("each reaction has its own mood, so the portrait can look different", () => {
  const moods = ["approve", "remind", "demand"].map((k) => L.reaction(k, "bg", 0, { time: "18:30" }).mood);
  assert.deepEqual(moods, ["approve", "remind", "demand"]);
  assert.equal(new Set(moods).size, 3);
  assert.equal(L.reaction("idle", "bg", 0).mood, "idle");
});

test("the example line from the brief is there, word for word", () => {
  assert.ok(L.LINES.demand.bg.includes("Няма доклад, легионер. Яде ли, или чакаш специална заповед?"));
});

test("lines are deterministic: same counter, same line; the counter cycles through all of them", () => {
  const seen = new Set();
  for (let n = 0; n < 6; n++) {
    assert.equal(L.reaction("approve", "bg", n).text, L.reaction("approve", "bg", n).text);
    seen.add(L.reaction("approve", "bg", n).text);
  }
  assert.equal(seen.size, L.LINES.approve.bg.length);
});

test("the reminder fills in the time it is given and leaves nothing unresolved", () => {
  for (const lang of ["bg", "en"]) for (let n = 0; n < 3; n++) {
    const r = L.reaction("remind", lang, n, { time: "07:45" });
    assert.ok(r.text.includes("07:45"), r.text);
    assert.ok(!/\{\w+\}/.test(r.text), r.text);
  }
  assert.ok(L.LINES.remind.bg.every((l) => l.includes("{time}")));
});

test("no other line carries a placeholder", () => {
  for (const [kind, set] of Object.entries(L.LINES)) {
    if (kind === "remind") continue;
    for (const lang of ["bg", "en"]) for (const line of set[lang]) assert.ok(!/\{\w+\}/.test(line), `${kind}: ${line}`);
  }
});

test("an unknown language falls back to English; an unknown kind is an error", () => {
  assert.equal(L.reaction("demand", "xx", 0).text, L.LINES.demand.en[0]);
  assert.throws(() => L.reaction("celebrate", "bg", 0));
});

test("the idle line comes from real totals only (nothing about times)", () => {
  assert.equal(L.idleKind({ entries: 0, calories: 0, goal: 2400 }), "idle_empty");
  assert.equal(L.idleKind({ entries: 3, calories: 1440, goal: 2400 }), "idle");
  assert.equal(L.idleKind({ entries: 3, calories: 2400, goal: 2400 }), "idle_done");
});

test("chips: nothing without data, only the values that exist, and the text is escaped", () => {
  const labels = { next: "Next", last: "Last" };
  assert.equal(L.chipsHtml(null, labels), "");
  assert.equal(L.chipsHtml({}, labels), "");
  assert.match(L.chipsHtml({ nextMeal: "18:30" }, labels), /Next · 18:30/);
  assert.ok(!/Last/.test(L.chipsHtml({ nextMeal: "18:30" }, labels)));
  assert.equal((L.chipsHtml({ nextMeal: "a", lastLog: "b" }, labels).match(/lg-chip/g) || []).length, 2);
  const esc = (s) => String(s).replace(/</g, "&lt;");
  assert.ok(!L.chipsHtml({ nextMeal: "<b>" }, labels, esc).includes("<b>"));
});

// ---- controller
function fakeTimers() {
  const t = { pending: new Map(), next: 1 };
  t.set = (fn, ms) => { const id = t.next++; t.pending.set(id, { fn, ms }); return id; };
  t.clear = (id) => t.pending.delete(id);
  t.fire = () => { const all = [...t.pending.values()]; t.pending.clear(); all.forEach((x) => x.fn()); };
  return t;
}

test("a reaction is shown, marked demo or not, and returns to idle by itself", () => {
  const timers = fakeTimers();
  const renders = [];
  const c = L.createController({ render: (r) => renders.push(r), setTimer: timers.set, clearTimer: timers.clear, idleDelayMs: 7000 });
  const r = c.show("approve", { lang: "bg" });
  assert.equal(r.demo, false);
  assert.equal(c.current.kind, "approve");
  assert.equal([...timers.pending.values()][0].ms, 7000);
  timers.fire();
  assert.equal(c.current, null);
  assert.equal(renders[renders.length - 1], null);
});

test("a demo reaction is flagged as demo and holds the time it was given", () => {
  const timers = fakeTimers();
  const c = L.createController({ render: () => {}, setTimer: timers.set, clearTimer: timers.clear });
  c.show("demand", { lang: "bg", demo: true, ms: 20000 });
  assert.equal(c.current.demo, true);
  assert.equal([...timers.pending.values()][0].ms, 20000);
});

test("a new reaction replaces the old one and cancels its timer (no early snap-back)", () => {
  const timers = fakeTimers();
  const c = L.createController({ render: () => {}, setTimer: timers.set, clearTimer: timers.clear });
  c.show("approve", { lang: "bg" });
  c.show("demand", { lang: "bg" });
  assert.equal(timers.pending.size, 1);
  assert.equal(c.current.kind, "demand");
});

test("successive shows of one kind rotate through its lines", () => {
  const timers = fakeTimers();
  const c = L.createController({ render: () => {}, setTimer: timers.set, clearTimer: timers.clear });
  const texts = [0, 1, 2].map(() => c.show("demand", { lang: "bg" }).text);
  assert.equal(new Set(texts).size, 3);
});

test("reset clears the reaction and its timer; idle kinds never start a timer", () => {
  const timers = fakeTimers();
  const renders = [];
  const c = L.createController({ render: (r) => renders.push(r), setTimer: timers.set, clearTimer: timers.clear });
  c.show("approve", { lang: "bg" });
  c.reset();
  assert.equal(timers.pending.size, 0);
  assert.equal(c.current, null);
  c.show("idle_done", { lang: "bg" });
  assert.equal(timers.pending.size, 0);
});

// ---- the portrait and the guarantees
test("the portrait draws every mood part, and the stylesheet gives every mood its own rules", () => {
  const svg = L.portraitSvg();
  for (const part of ["lg-mouth-idle", "lg-mouth-approve", "lg-mouth-remind", "lg-mouth-demand", "lg-prop-approve", "lg-prop-remind", "lg-prop-demand", "lg-brow-l", "lg-brow-r", "lg-crest", "lg-lids"]) {
    assert.ok(svg.includes(part), part);
  }
  const css = read("style.css");
  for (const mood of ["approve", "remind", "demand"]) assert.ok(css.includes(`.lg-mood-${mood} `), `no CSS for ${mood}`);
  assert.ok(L.MOODS.every((m) => ["idle", "approve", "remind", "demand"].includes(m)));
});

test("it is presentation only: no network, no storage, no AI, no timers of its own in legion.js", () => {
  const src = read("legion.js").replace(/\/\/.*$/gm, "");
  for (const banned of ["fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "localStorage", "sessionStorage", "indexedDB", "Math.random", "anthropic", "/api/"]) {
    assert.ok(!src.includes(banned), `legion.js uses ${banned}`);
  }
});

test("the portrait is marked as a temporary resource in the source", () => {
  assert.match(read("legion.js"), /PLACEHOLDER ART/);
});
