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
  assert.equal(L.idleKind({ entries: 3, calories: 2400, goal: 2400, goalType: "gain" }), "idle_done");
});

test("the idle line is goal-aware: going over is never congratulated for lose/maintain", () => {
  const over = { entries: 3, calories: 2600, goal: 2400 };
  assert.equal(L.idleKind({ ...over, goalType: "gain" }), "idle_done");
  assert.equal(L.idleKind({ ...over, goalType: "lose" }), "idle_over");
  assert.equal(L.idleKind({ ...over, goalType: "maintain" }), "idle_over");
  assert.equal(L.idleKind({ ...over, goalType: null }), "idle_over");
  assert.equal(L.idleKind({ entries: 3, calories: 2400, goal: 2400, goalType: "lose" }), "idle_done");
  assert.equal(L.idleKind({ entries: 3, calories: 1500, goal: 2400, goalType: "lose" }), "idle");
  for (const lang of ["bg", "en"]) assert.ok(!/изпълнена|met/i.test(L.reaction("idle_over", lang, 0).text), "the over line must not say the quota is met");
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

// ---- the portraits and the guarantees
const crypto = require("node:crypto");
const FRONT = path.join(__dirname, "..", "..", "frontend");

test("the four states each have their own portrait file, listed in one place, and the files exist", () => {
  assert.deepEqual(Object.keys(L.ASSETS).sort(), [...L.MOODS].sort());
  const hashes = new Set();
  for (const mood of L.MOODS) {
    const url = L.ASSETS[mood];
    assert.ok(url.startsWith("/legion/"), url);
    const file = path.join(FRONT, url);
    assert.ok(fs.existsSync(file), `${url} is missing`);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length > 500 && bytes.length < 150 * 1024, `${url} has a strange size`);
    hashes.add(crypto.createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal(hashes.size, 4, "the four states must not be the same picture");
});

test("replacing the art is only a file swap: the markup is four plain <img> elements and only the active one is shown", () => {
  const html = L.portraitHtml("approve");
  assert.equal((html.match(/<img /g) || []).length, 4);
  assert.equal((html.match(/is-active/g) || []).length, 1);
  assert.match(html, /data-mood="approve"[^>]*>/);
  assert.ok(/class="lg-img is-active" data-mood="approve"/.test(html));
  for (const url of Object.values(L.ASSETS)) assert.ok(html.includes(`src="${url}"`));
  assert.ok(/class="lg-img is-active" data-mood="idle"/.test(L.portraitHtml()), "idle is the default");
  const css = read("style.css");
  assert.match(css, /\.lg-img\.is-active\s*\{\s*opacity:\s*1/);
});

test("the placeholder portraits are serious: no flush, sparks, shouting mouth, props or caricature parts", () => {
  for (const mood of L.MOODS) {
    const svg = fs.readFileSync(path.join(FRONT, L.ASSETS[mood]), "utf8");
    assert.match(svg, /TEMPORARY placeholder/);
    for (const banned of ["flush", "spark", "vein", "#D2362C", "#E0463A", "#F6EEE6\"/></g>", "prop"]) assert.ok(!svg.includes(banned), `${mood}: ${banned}`);
  }
  assert.ok(!read("style.css").includes("lg-flush") && !read("style.css").includes("lg-prop") && !read("style.css").includes("lg-mood-"));
});

test("the folder says what the final portraits must be and that these are temporary", () => {
  const readme = read("legion/README.md");
  assert.match(readme, /placeholders/i);
  assert.match(readme, /3:4/);
  for (const f of ["portrait-idle.svg", "portrait-approve.svg", "portrait-remind.svg", "portrait-demand.svg"]) assert.ok(readme.includes(f), f);
});

test("the service worker refreshes the portraits network-first, so replaced art is not stuck behind a cache", () => {
  const sw = read("sw.js");
  for (const url of Object.values(L.ASSETS)) assert.ok(sw.includes(`"${url}"`), url);
  assert.ok(sw.includes('"/dialogs.js"'));
});

test("it is presentation only: no network, no storage, no AI, no timers of its own in legion.js", () => {
  const src = read("legion.js").replace(/\/\/.*$/gm, "");
  for (const banned of ["fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "localStorage", "sessionStorage", "indexedDB", "Math.random", "anthropic", "/api/"]) {
    assert.ok(!src.includes(banned), `legion.js uses ${banned}`);
  }
});

test("the portraits are marked as a temporary resource in the source", () => {
  assert.match(read("legion.js"), /PLACEHOLDER ART/);
});
