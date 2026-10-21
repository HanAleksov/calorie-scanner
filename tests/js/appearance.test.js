// Run: node --test tests/js/*.test.js
// Appearance: theme and style are independent and remembered; every theme x style combination keeps readable
// contrast; macro colours are the same in all of them; success / warning / danger never reuse a macro colour.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { create, THEMES, MODES } = require("../../frontend/look.js");

// ---------------------------------------------------------------- look.js
function fakeEnv({ stored = {}, dark = false, throwing = false } = {}) {
  const data = new Map(Object.entries(stored));
  const attrs = {};
  const listeners = [];
  const mql = { matches: dark, addEventListener: (t, fn) => listeners.push(fn) };
  return {
    storage: {
      getItem: (k) => { if (throwing) throw new Error("blocked"); return data.has(k) ? data.get(k) : null; },
      setItem: (k, v) => { if (throwing) throw new Error("blocked"); data.set(k, String(v)); },
      removeItem: (k) => { if (throwing) throw new Error("blocked"); data.delete(k); },
    },
    doc: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
    matchMedia: () => mql,
    data, attrs, setSystemDark(v) { mql.matches = v; listeners.forEach((fn) => fn()); },
  };
}

test("defaults: follows the system theme, Normal style", () => {
  const env = fakeEnv({ dark: true });
  const look = create(env);
  look.apply();
  assert.equal(look.theme, "system");
  assert.equal(look.mode, "normal");
  assert.deepEqual([env.attrs["data-theme"], env.attrs["data-mode"]], ["dark", "normal"]);
});

test("theme and style are independent: every one of the 4 explicit combinations can be set in any order", () => {
  for (const order of [["theme", "mode"], ["mode", "theme"]]) {
    for (const theme of ["light", "dark"]) for (const mode of MODES) {
      const env = fakeEnv();
      const look = create(env);
      for (const what of order) what === "theme" ? look.setTheme(theme) : look.setMode(mode);
      assert.deepEqual([env.attrs["data-theme"], env.attrs["data-mode"]], [theme, mode], `${theme}/${mode} via ${order}`);
    }
  }
});

test("changing the style never touches the theme, and the other way round", () => {
  const env = fakeEnv();
  const look = create(env);
  look.setTheme("dark");
  look.setMode("roman");
  assert.equal(look.theme, "dark");
  look.setTheme("light");
  assert.equal(look.mode, "roman");
});

test("choices are remembered (and 'system' / 'normal' store nothing)", () => {
  const env = fakeEnv();
  const look = create(env);
  look.setTheme("dark"); look.setMode("roman");
  assert.equal(env.data.get("theme"), "dark");
  assert.equal(env.data.get("lookMode"), "roman");
  const again = create({ ...env });
  assert.deepEqual([again.theme, again.mode], ["dark", "roman"]);
  look.setTheme("system"); look.setMode("normal");
  assert.equal(env.data.has("theme"), false);
  assert.equal(env.data.has("lookMode"), false);
});

test("the old light/dark choice stored under 'theme' still works", () => {
  const look = create(fakeEnv({ stored: { theme: "light" }, dark: true }));
  assert.equal(look.theme, "light");
  assert.equal(look.effectiveTheme(), "light");
});

test("unknown stored or requested values are ignored", () => {
  const env = fakeEnv({ stored: { theme: "neon", lookMode: "gladiator" } });
  const look = create(env);
  assert.deepEqual([look.theme, look.mode], ["system", "normal"]);
  assert.equal(look.setTheme("neon"), false);
  assert.equal(look.setMode("gladiator"), false);
});

test("'system' follows the OS live; an explicit theme does not", () => {
  const env = fakeEnv({ dark: false });
  const look = create(env);
  look.apply();
  assert.equal(env.attrs["data-theme"], "light");
  env.setSystemDark(true);
  assert.equal(env.attrs["data-theme"], "dark");
  look.setTheme("light");
  env.setSystemDark(false); env.setSystemDark(true);
  assert.equal(env.attrs["data-theme"], "light");
});

test("blocked storage never breaks the page: choices still apply for this visit", () => {
  const env = fakeEnv({ throwing: true });
  const look = create(env);
  assert.doesNotThrow(() => { look.setTheme("dark"); look.setMode("roman"); });
  assert.deepEqual([env.attrs["data-theme"], env.attrs["data-mode"]], ["dark", "roman"]);
});

test("listeners hear every change", () => {
  const look = create(fakeEnv());
  const seen = [];
  look.onChange((s) => seen.push(`${s.effective}/${s.mode}`));
  look.setTheme("dark"); look.setMode("roman");
  assert.deepEqual(seen, ["dark/normal", "dark/roman"]);
});

// ---------------------------------------------------------------- the stylesheet's tokens
const css = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "style.css"), "utf8");

function block(selector) {
  const start = css.indexOf(selector + " {");
  assert.ok(start >= 0, `block not found: ${selector}`);
  const end = css.indexOf("\n}", start);
  const tokens = {};
  for (const m of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
  return tokens;
}
const normalLight = block(':root, :root[data-theme="light"]');
const normalDark = block(':root[data-theme="dark"]');
const COMBOS = {
  "normal/light": normalLight,
  "normal/dark": normalDark,
  "roman/light": { ...normalLight, ...block(':root[data-mode="roman"][data-theme="light"]') },
  "roman/dark": { ...normalDark, ...block(':root[data-mode="roman"][data-theme="dark"]') },
};

const hex = (v) => { const m = /^#([0-9a-f]{6})$/i.exec(v); assert.ok(m, `not a plain hex colour: ${v}`); return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)); };
const lum = ([r, g, b]) => { const c = [r, g, b].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [hi, lo] = [lum(hex(a)), lum(hex(b))].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const stops = (gradient) => [...gradient.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]);

test("all four combinations define every colour token the screens use", () => {
  const needed = ["bg", "surface", "surface-2", "surface-3", "text", "text-dim", "border", "accent", "accent-ink", "on-accent", "accent-gradient",
    "protein", "carbs", "fat", "water", "success", "warning", "danger", "focus", "bronze", "bronze-ink"];
  for (const [name, t] of Object.entries(COMBOS)) for (const k of needed) assert.ok(t[k], `${name} is missing --${k}`);
});

test("text is readable (>= 4.5:1) on every surface in every combination", () => {
  const pairs = [["text", "bg"], ["text", "surface"], ["text", "surface-2"], ["text", "surface-3"],
    ["text-dim", "bg"], ["text-dim", "surface"], ["text-dim", "surface-2"], ["text-dim", "surface-3"],
    ["accent-ink", "bg"], ["accent-ink", "surface"], ["bronze-ink", "surface"],
    ["success", "surface"], ["warning", "surface"], ["danger", "surface"]];
  for (const [name, t] of Object.entries(COMBOS)) for (const [fg, bg] of pairs) {
    const r = ratio(t[fg], t[bg]);
    assert.ok(r >= 4.5, `${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
  }
});

test("text on the primary button is readable (>= 4.5:1) along the whole gradient", () => {
  for (const [name, t] of Object.entries(COMBOS)) for (const stop of stops(t["accent-gradient"])) {
    const r = ratio(t["on-accent"], stop);
    assert.ok(r >= 4.5, `${name}: --on-accent on ${stop} is ${r.toFixed(2)}:1`);
  }
});

test("bars and focus rings are visible (>= 3:1) against the card", () => {
  for (const [name, t] of Object.entries(COMBOS)) {
    for (const k of ["protein", "carbs", "fat", "water", "focus"]) {
      const r = ratio(t[k], t.surface);
      assert.ok(r >= 3, `${name}: --${k} on --surface is ${r.toFixed(2)}:1`);
    }
  }
});

test("macro colours: protein blue, carbs green, fat gold in every combination, and the same in both styles", () => {
  for (const theme of ["light", "dark"]) {
    const normal = COMBOS[`normal/${theme}`], roman = COMBOS[`roman/${theme}`];
    for (const k of ["protein", "carbs", "fat"]) assert.equal(roman[k], normal[k], `--${k} differs between styles in the ${theme} theme`);
  }
  const hue = (v) => { const [r, g, b] = hex(v).map((x) => x / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; return (h + 360) % 360; };
  for (const [name, t] of Object.entries(COMBOS)) {
    assert.ok(hue(t.protein) > 200 && hue(t.protein) < 240, `${name}: protein is not blue (${hue(t.protein)})`);
    assert.ok(hue(t.carbs) > 120 && hue(t.carbs) < 160, `${name}: carbs is not green (${hue(t.carbs)})`);
    assert.ok(hue(t.fat) > 35 && hue(t.fat) < 50, `${name}: fat is not gold (${hue(t.fat)})`);
  }
});

test("success, warning and danger are separate colours and never a macro colour", () => {
  for (const [name, t] of Object.entries(COMBOS)) {
    const states = ["success", "warning", "danger"], others = ["protein", "carbs", "fat", "water", "accent"];
    const all = [...states, ...others].map((k) => t[k].toLowerCase());
    assert.equal(new Set(all).size, all.length, `${name}: two of ${[...states, ...others]} share a colour`);
  }
});

test("reduced motion: the stylesheet switches animations and transitions off", () => {
  const rule = /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{([^}]*)\}/.exec(css);
  assert.ok(rule, "the reduced-motion media rule must target everything");
  assert.match(rule[1], /animation-duration: 0\.001ms !important/);
  assert.match(rule[1], /transition-duration: 0\.001ms !important/);
});

test("a visible keyboard focus ring exists", () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/);
});

test("themes and modes the picker offers are exactly the ones look.js accepts", () => {
  assert.deepEqual(THEMES, ["system", "light", "dark"]);
  assert.deepEqual(MODES, ["normal", "roman"]);
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "index.html"), "utf8");
  for (const t of ["light", "dark", "system"]) assert.ok(html.includes(`data-theme-choice="${t}"`), t);
  for (const m of MODES) assert.ok(html.includes(`data-mode-choice="${m}"`), m);
});
