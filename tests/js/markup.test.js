// Run: node --test tests/js/*.test.js
// The page script looks elements up by id. The test DOM happily invents any id, so a renamed or deleted id in
// index.html would pass every other test and crash the real page on load. This pins every id app.js uses.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FRONTEND = path.join(__dirname, "..", "..", "frontend");
const html = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
const app = fs.readFileSync(path.join(FRONTEND, "app.js"), "utf8");

const inMarkup = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
// ids that app.js itself puts on elements it renders (innerHTML templates)
const rendered = new Set([...app.matchAll(/\sid="([^"$]+)"/g)].map((m) => m[1]));

test("every id app.js looks up with $(\"...\") exists in index.html or is rendered by app.js itself", () => {
  const used = [...new Set([...app.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]))];
  assert.ok(used.length > 150, `expected to find the page's lookups, found ${used.length}`);
  const missing = used.filter((id) => !inMarkup.has(id) && !rendered.has(id));
  assert.deepEqual(missing, [], `app.js asks for ids that do not exist: ${missing.join(", ")}`);
});

test("templated lookups ($(`${name}Val`), $(`${prefix}MealTime`) ...) resolve to real ids too", () => {
  for (const name of ["protein", "carbs", "fat"]) for (const suffix of ["Val", "Bar", "Fill"]) assert.ok(inMarkup.has(`${name}${suffix}`), `${name}${suffix}`);
  for (const prefix of ["photo", "manual", "fav", "edit"]) for (const suffix of ["MealType", "MealTime"]) assert.ok(inMarkup.has(`${prefix}${suffix}`), `${prefix}${suffix}`);
});

test("no id appears twice in index.html (a duplicate silently steals the lookup)", () => {
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dups = all.filter((id, i) => all.indexOf(id) !== i);
  assert.deepEqual(dups, []);
});

test("every <label for> points at a control that exists", () => {
  const labels = [...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]);
  const missing = labels.filter((id) => !inMarkup.has(id));
  assert.deepEqual(missing, []);
});

test("every script the page loads exists, in an order where the ones app.js needs come first", () => {
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map((m) => m[1]);
  for (const s of scripts) assert.ok(fs.existsSync(path.join(FRONTEND, s)), s);
  const order = (n) => scripts.indexOf(n);
  for (const dep of ["i18n.js", "units.js", "schedule.js", "legion.js", "dialogs.js", "api.js"]) assert.ok(order(dep) >= 0 && order(dep) < order("app.js"), `${dep} before app.js`);
  const sw = fs.readFileSync(path.join(FRONTEND, "sw.js"), "utf8");
  for (const s of scripts) assert.ok(sw.includes(`"/${s}"`), `${s} is in the service worker's shell`);
});
