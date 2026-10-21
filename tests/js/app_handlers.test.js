// Drives the real handlers in frontend/app.js (see helpers/app_harness.js). Invented numbers only.
// Run: node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, json, settleFor, makeElement } = require("./helpers/app_harness");

// ---------------------------------------------------------------------------------------------------
// Applying a suggestion = read the CURRENT targets, add a delta, write. It must happen once per tap.
// ---------------------------------------------------------------------------------------------------
function suggestionPage({ goals, suggestions }) {
  const server = { goals: { ...goals }, gets: 0, puts: [], pendingReads: [], failReads: false, dropReads: false, failWrites: false };
  const route = async (path, opts) => {
    if (path !== "/api/goals") return new Promise(() => {});
    if ((opts.method || "GET") === "GET") {
      server.gets += 1;
      if (server.dropReads) throw new Error("connection dropped");
      if (server.failReads) return json(500, { detail: "boom" });
      return new Promise((resolve) => server.pendingReads.push(() => resolve(json(200, { ...server.goals }))));
    }
    server.puts.push(JSON.parse(opts.body));
    if (server.failWrites) return json(500, { detail: "boom" });
    server.goals = { ...server.goals, ...server.puts[server.puts.length - 1] };
    return json(200, server.goals);
  };
  const h = loadApp({ route });
  h.stub("loadToday", "loadGoalsForm");
  h.run("localStorage.setItem('lang','en')");

  const cards = suggestions.map(() => ({ removed: 0, remove() { this.removed += 1; } }));
  const buttons = suggestions.map((s, i) => {
    const btn = makeElement("apply" + i);
    Object.assign(btn.dataset, { delta: String(s.delta), prioritizeCarbs: String(!!s.prioritizeCarbs), proteinFloor: String(s.proteinFloor || 0) });
    return btn;
  });
  const result = h.el("adaptiveTdeeResult");
  result.querySelectorAll = (sel) => (sel === ".apply-suggestion-btn" ? buttons : []);
  h.ctx.__data = {
    suggested_calories: 2600, protein_g: 135, carbs_g: 400, fat_g: 70, surplus_buffer_kcal: 400, elapsed_days: 14,
    real_tdee: 2300, weight_velocity_kg_week: 0.1,
    suggestions: suggestions.map((s) => ({ type: s.type || "under_fueled", calorie_delta: s.delta, weight_delta_kg: 0.1, prioritize_carbs: !!s.prioritizeCarbs })),
  };
  h.run("renderAdaptiveTdee(__data)");
  const tap = (i = 0) => buttons[i].listeners.click[0]({ target: { closest: () => cards[i] } });
  return { h, server, buttons, cards, tap };
}

test("two quick taps on 'apply +150' before the read returns: one read, one write, 2500 -> 2650", async () => {
  const p = suggestionPage({ goals: { calories: 2500, protein_g: 135, carbs_g: 380, fat_g: 70 }, suggestions: [{ delta: 150 }] });
  const first = p.tap();
  const second = p.tap();
  await settleFor();
  p.server.pendingReads.forEach((release) => release());     // the (single) read answers late
  await Promise.all([first, second]);
  await settleFor();
  assert.equal(p.server.gets, 1, "the second tap must not even start a second read");
  assert.equal(p.server.puts.length, 1);
  assert.equal(p.server.puts[0].calories, 2650);
  assert.equal(p.server.goals.calories, 2650, "applied exactly once, not 2800");
  assert.equal(p.cards[0].removed, 1);
});

test("a tap between the read and the write is ignored too", async () => {
  const p = suggestionPage({ goals: { calories: 2500, protein_g: 135, carbs_g: 380, fat_g: 70 }, suggestions: [{ delta: 150 }] });
  const first = p.tap();
  await settleFor();
  p.server.pendingReads.shift()();                           // read done, write in flight/just starting
  const second = p.tap();
  await Promise.all([first, second]);
  await settleFor();
  assert.equal(p.server.gets, 1);
  assert.equal(p.server.puts.length, 1);
  assert.equal(p.server.goals.calories, 2650);
});

test("two DIFFERENT suggestions tapped together: only the first is applied (a delta needs a settled base)", async () => {
  const p = suggestionPage({
    goals: { calories: 2500, protein_g: 135, carbs_g: 380, fat_g: 70 },
    suggestions: [{ delta: 150 }, { delta: -100, type: "fat_spike", prioritizeCarbs: true, proteinFloor: 135 }],
  });
  const a = p.tap(0);
  const b = p.tap(1);
  await settleFor();
  p.server.pendingReads.forEach((release) => release());
  await Promise.all([a, b]);
  await settleFor();
  assert.equal(p.server.puts.length, 1);
  assert.equal(p.server.goals.calories, 2650);
  assert.equal(p.cards[1].removed, 0, "the second suggestion stays on screen for the user to apply deliberately");
});

test("the guard is released afterwards: a later, separate tap works", async () => {
  const p = suggestionPage({ goals: { calories: 2500, protein_g: 135, carbs_g: 380, fat_g: 70 }, suggestions: [{ delta: 150 }, { delta: 100 }] });
  const a = p.tap(0);
  await settleFor();
  p.server.pendingReads.shift()();
  await a;
  await settleFor();
  const b = p.tap(1);
  await settleFor();
  p.server.pendingReads.shift()();
  await b;
  await settleFor();
  assert.equal(p.server.puts.length, 2);
  assert.equal(p.server.goals.calories, 2750);               // 2500 + 150, then + 100: two deliberate taps
});

test("a failed read or write leaves the button usable and writes nothing twice", async () => {
  const p = suggestionPage({ goals: { calories: 2500, protein_g: 135, carbs_g: 380, fat_g: 70 }, suggestions: [{ delta: 150 }] });
  p.server.failReads = true;
  await p.tap();
  assert.equal(p.server.puts.length, 0);
  assert.equal(p.buttons[0].disabled, false);
  assert.equal(p.cards[0].removed, 0);
  p.server.failReads = false;
  p.server.failWrites = true;
  const t2 = p.tap();
  await settleFor();
  p.server.pendingReads.shift()();
  await t2;
  assert.equal(p.server.puts.length, 1, "one attempt, no automatic retry");
  assert.equal(p.buttons[0].disabled, false);
  assert.equal(p.cards[0].removed, 0, "the suggestion stays so the user can try again");
});

test("a read that fails at the network level is reported, nothing is written, the button is usable again", async () => {
  const p = suggestionPage({ goals: { calories: 2500, protein_g: 135, carbs_g: 380, fat_g: 70 }, suggestions: [{ delta: 150 }] });
  p.server.dropReads = true;
  await p.tap();
  assert.equal(p.server.puts.length, 0);
  assert.equal(p.buttons[0].disabled, false);
  assert.equal(p.cards[0].removed, 0);
  p.server.dropReads = false;                                // and the same button works afterwards
  const again = p.tap();
  await settleFor();
  p.server.pendingReads.shift()();
  await again;
  assert.equal(p.server.goals.calories, 2650);
});

test("fat_spike keeps its macro rule through the guarded path (protein held at the floor, fat cut)", async () => {
  const p = suggestionPage({
    goals: { calories: 2923, protein_g: 120, carbs_g: 470, fat_g: 56 },
    suggestions: [{ delta: -100, type: "fat_spike", prioritizeCarbs: true, proteinFloor: 135 }],
  });
  const t = p.tap();
  await settleFor();
  p.server.pendingReads.shift()();
  await t;
  const put = p.server.puts[0];
  assert.equal(put.calories, 2823);
  assert.equal(put.protein_g, 135);
  assert.equal(put.fat_g, 45);                               // 56 - 100/9 = 44.9 -> 45 (floor is 40)
});

// ---------------------------------------------------------------------------------------------------
// Editing one field of the Plan form must not change the other canonical value.
// ---------------------------------------------------------------------------------------------------
function planPage(units, canon) {
  const h = loadApp();
  h.state.units = units;
  h.state.canon = { ...canon };
  h.run("renderUnitFields()");
  const type = (id, value) => { h.el(id).value = String(value); h.fire(id, "input"); };
  return { h, type, canon: () => ({ ...h.state.canon }) };
}

test("imperial: changing only the inches leaves 80 kg at exactly 80 (was 80.01)", () => {
  const p = planPage("imperial", { heightCm: 178, weightKg: 80 });
  assert.equal(p.h.el("weightKg").value, "176.4", "80 kg is displayed as 176.4 lb");
  p.type("heightIn", 11);
  assert.equal(p.canon().weightKg, 80);
  assert.equal(p.canon().heightCm, 180.3);                   // 5 ft 11 in
});

test("imperial: changing only the feet leaves the weight alone", () => {
  const p = planPage("imperial", { heightCm: 178, weightKg: 80 });
  p.type("heightCm", 6);                                     // 6 ft + the 10.1 in still shown
  assert.equal(p.canon().weightKg, 80);
  assert.equal(p.canon().heightCm, 208.5);
});

test("imperial: changing only the weight leaves 178 cm at exactly 178 (display is 5 ft 10.1 in)", () => {
  const p = planPage("imperial", { heightCm: 178, weightKg: 80 });
  assert.equal(p.h.el("heightIn").value, "10.1");
  p.type("weightKg", 180);
  assert.equal(p.canon().heightCm, 178);
  assert.equal(p.canon().weightKg, 81.65);
});

test("imperial: edits one after the other never disturb the field not being edited", () => {
  const p = planPage("imperial", { heightCm: 178, weightKg: 80 });
  p.type("weightKg", 175);
  assert.deepEqual(p.canon(), { heightCm: 178, weightKg: 79.38 });
  p.type("heightIn", 9);
  assert.deepEqual(p.canon(), { heightCm: 175.3, weightKg: 79.38 });
  p.type("weightKg", 176.4);                                 // typed on purpose -> that value is what counts
  assert.deepEqual(p.canon(), { heightCm: 175.3, weightKg: 80.01 });
});

test("metric: each field changes only its own canonical value", () => {
  const p = planPage("metric", { heightCm: 178.4, weightKg: 80.25 });
  p.type("heightCm", 181);
  assert.deepEqual(p.canon(), { heightCm: 181, weightKg: 80.25 });
  p.type("weightKg", 79.5);
  assert.deepEqual(p.canon(), { heightCm: 181, weightKg: 79.5 });
});

test("clearing a field clears only that value", () => {
  const p = planPage("imperial", { heightCm: 178, weightKg: 80 });
  p.type("weightKg", "");
  assert.deepEqual(p.canon(), { heightCm: 178, weightKg: null });
});
