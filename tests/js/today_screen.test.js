// Run: node --test tests/js/*.test.js
// The redesigned Today screen driven through the REAL app.js (fake DOM, fake network).
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, json, settleFor } = require("./helpers/app_harness");

const goals = { calories: 2400, protein_g: 150, carbs_g: 270, fat_g: 80, water_ml: 2500 };
const totals = { calories: 1440, protein_g: 90, carbs_g: 162, fat_g: 48, energy_avg: null };
const entry = (id, name, kcal, hour, over = {}) => ({
  id, meal_type: "snack", total_calories: kcal, protein_g: 20, carbs_g: 30, fat_g: 10, confidence: "high", energy_score: null, notes: null,
  created_at: `2026-10-21T${hour}:00`, image_path: `p${id}.jpg`, items: [{ name }], ...over,
});

function page(opts = {}) {
  // the page's own sign-in probe (GET /api/session) is never answered, so the app stays on its boot screen
  const route = opts.route && ((p, o) => (p === "/api/session" && (!o.method || o.method === "GET") ? new Promise(() => {}) : opts.route(p, o)));
  const h = loadApp({ storage: { lang: "bg", ...(opts.storage || {}) }, route, confirm: opts.confirm });
  h.stub("loadToday");   // the page's own boot fetch is not part of these tests
  return h;
}

test("calories: the number left, a bar at the right width, progress described for assistive tech", () => {
  const h = page();
  h.run(`renderTotals(${JSON.stringify(totals)}, ${JSON.stringify(goals)})`);
  assert.equal(h.el("ringCalsLeft").textContent, 960);
  assert.equal(h.el("totalCals").textContent, 1440);
  assert.equal(h.el("calGoalDisplay").textContent, 2400);
  assert.equal(h.el("calBarFill").style.width, "60%");
  assert.equal(h.el("calBar").getAttribute("aria-valuenow"), "60");
  assert.match(h.el("calBar").getAttribute("aria-valuetext"), /1440 от 2400/);
});

test("macros: grams with units, own bars, and the old over/under rules keep their meaning per goal", () => {
  const h = page();
  h.run(`state.goalType = "gain"; renderTotals(${JSON.stringify(totals)}, ${JSON.stringify(goals)})`);
  assert.equal(h.el("proteinVal").textContent, "90 / 150 г");
  assert.equal(h.el("proteinFill").style.width, "60%");
  assert.equal(h.el("calBarFill").classList.contains("under-warning"), true, "gain user under 85% is flagged");
  h.run(`state.goalType = "gain"; renderTotals({...${JSON.stringify(totals)}, calories: 2600}, ${JSON.stringify(goals)})`);
  assert.equal(h.el("calBarFill").classList.contains("over-good"), true, "gain user over target is good");
  h.run(`state.goalType = "lose"; renderTotals({...${JSON.stringify(totals)}, calories: 2600}, ${JSON.stringify(goals)})`);
  assert.equal(h.el("calBarFill").classList.contains("over"), true, "lose user over target is NOT celebrated");
  assert.equal(h.el("calBarFill").classList.contains("over-good"), false);
  h.run(`state.goalType = "lose"; renderTotals(${JSON.stringify(totals)}, ${JSON.stringify(goals)})`);
  assert.equal(h.el("calBarFill").classList.contains("under-warning"), false, "a lose user is never warned for being under");
});

test("water is shown in litres with a bar, in the chosen language", () => {
  const h = page();
  h.run("renderWater(1000, 2500)");
  assert.equal(h.el("waterVal").textContent, "1,0 / 2,5 л");
  assert.equal(h.el("waterFill").style.width, "40%");
  const en = page({ storage: { lang: "en" } });
  en.run("renderWater(1500, 2500)");
  assert.equal(en.el("waterVal").textContent, "1.5 / 2.5 L");
  h.run("renderWater(9000, 2500)");
  assert.equal(h.el("waterFill").style.width, "100%", "the bar never overflows");
});

test("meals: one row each with photo, name, kcal, time, macros and an edit control; oldest first", () => {
  const h = page();
  const entries = [entry(1, "Oats", 420, "08:10"), entry(2, "Chicken <b>x</b>", 720, "13:05")];
  h.run(`renderEntries(${JSON.stringify(entries)})`);
  const html = h.el("entriesList").innerHTML;
  assert.ok(html.indexOf("Oats") < html.indexOf("Chicken"), "chronological");
  assert.match(html, /src="\/uploads\/p1\.jpg"/);
  assert.match(html, /420 ккал/);
  assert.match(html, /08:10/);
  assert.match(html, /П 20 · В 30 · М 10/);
  assert.ok(!html.includes("<b>x</b>"), "names are escaped");
  assert.equal((html.match(/class="edit-btn"/g) || []).length, 2);
  assert.match(html, /aria-label="Редактирай: Oats"/);
});

test("meals: no photo -> a placeholder; no item names -> the meal type is the title; empty day -> a friendly empty state", () => {
  const h = page();
  h.run(`renderEntries(${JSON.stringify([entry(3, "", 300, "10:00", { image_path: null, items: [{ name: "" }], meal_type: "lunch" })])})`);
  const html = h.el("entriesList").innerHTML;
  assert.match(html, /thumb-placeholder/);
  assert.match(html, /entry-title">Обяд</);
  h.run("renderEntries([])");
  assert.match(h.el("entriesList").innerHTML, /empty-state/);
});

test("the Add food button opens one panel holding photo, manual and favourites; choosing one closes the panel", () => {
  const h = page();
  assert.equal(h.el("addFoodModal").classList.contains("hidden"), false, "starts without the hidden class only because the test DOM starts empty");
  h.el("addFoodModal").classList.add("hidden");
  h.fire("addFoodBtn", "click");
  assert.equal(h.el("addFoodModal").classList.contains("hidden"), false, "opened");
  h.fire("takePhotoBtn", "click");
  assert.equal(h.el("photoInput").clicks, 1, "the file picker is opened by the photo option");
  assert.equal(h.el("addFoodModal").classList.contains("hidden"), true, "panel closed after choosing");
  h.el("addFoodModal").classList.remove("hidden");
  h.fire("manualEntryBtn", "click");
  assert.equal(h.el("manualModal").classList.contains("hidden"), false, "manual sheet opened");
  assert.equal(h.el("addFoodModal").classList.contains("hidden"), true);
  h.el("addFoodModal").classList.remove("hidden");
  h.stub("renderFavorites");
  h.fire("quickAddBtn", "click");
  assert.equal(h.el("favoritesModal").classList.contains("hidden"), false, "favourites sheet opened");
  assert.equal(h.el("addFoodModal").classList.contains("hidden"), true);
});

test("a failed manual save keeps the sheet open and every typed value (nothing is lost)", async () => {
  const h = page({ route: async () => json(500, { detail: "boom" }) });
  h.el("manualModal").classList.remove("hidden");
  Object.entries({ manualDesc: "Shake", manualCals: "300", manualProtein: "25", manualCarbs: "10", manualFat: "5" }).forEach(([id, v]) => { h.el(id).value = v; });
  h.fire("manualSaveBtn", "click");
  await settleFor();
  assert.equal(h.el("manualModal").classList.contains("hidden"), false, "sheet still open");
  assert.equal(h.el("manualDesc").value, "Shake");
  assert.equal(h.el("manualCals").value, "300");
});

test("a successful manual save closes the sheet, clears the fields and refreshes Today", async () => {
  const h = page({ route: async () => json(200, { id: 9 }) });
  h.el("manualModal").classList.remove("hidden");
  h.el("manualDesc").value = "Shake"; h.el("manualCals").value = "300";
  let refreshed = 0;
  h.run("loadToday = async () => { globalThis.__refresh = (globalThis.__refresh || 0) + 1; }");
  h.fire("manualSaveBtn", "click");
  await settleFor();
  assert.equal(h.el("manualModal").classList.contains("hidden"), true);
  assert.equal(h.el("manualDesc").value, "");
  assert.equal(h.run("globalThis.__refresh"), 1);
});

test("the editor carries favourite and delete; delete asks first and only deletes after yes", async () => {
  const no = page({ confirm: () => false, route: async () => json(200, {}) });
  no.state.entryBeingEdited = 7;
  no.fire("editDeleteBtn", "click");
  await settleFor();
  assert.equal(no.calls.confirms, 1);
  assert.equal(no.calls.fetches.filter((f) => f.method === "DELETE").length, 0, "cancelled: nothing sent");

  const yes = page({ confirm: () => true, route: async () => json(200, {}) });
  yes.state.entryBeingEdited = 7;
  yes.el("editModal").classList.remove("hidden");
  yes.fire("editDeleteBtn", "click");
  await settleFor();
  const del = yes.calls.fetches.filter((f) => f.method === "DELETE");
  assert.deepEqual(del.map((f) => f.path), ["/api/entries/7"]);
  assert.equal(yes.el("editModal").classList.contains("hidden"), true);
});

test("favourite from the editor posts the entry being edited", async () => {
  const h = page({ route: async () => json(200, { id: 1 }) });
  h.state.entryBeingEdited = 7;
  h.fire("editFavoriteBtn", "click");
  await settleFor();
  assert.deepEqual(h.calls.fetches.filter((f) => f.method === "POST").map((f) => f.path), ["/api/favorites"]);
});

test("the avatar asks before signing out, and cancelling keeps the session", async () => {
  const h = page({ confirm: () => false, route: async () => json(200, {}) });
  h.fire("switchUserBtn", "click");
  await settleFor();
  assert.equal(h.calls.confirms, 1);
  assert.equal(h.calls.fetches.filter((f) => f.method === "DELETE").length, 0);
  assert.equal(h.calls.reloads, 0);
});

test("tabs: the floating button belongs to Today only, titles follow the tab", () => {
  const h = page();
  h.stub("loadHistory", "loadPlanTab");
  h.run('switchTab("history")');
  assert.equal(h.ctx.document.body.dataset.tab, "history");
  assert.equal(h.el("screenTitle").textContent, "Прогрес");
  h.run('switchTab("plan")');
  assert.equal(h.el("screenTitle").textContent, "План");
  h.run('switchTab("today")');
  assert.equal(h.el("screenTitle").textContent, "Днес");
  assert.equal(h.ctx.document.body.dataset.tab, "today");
});

// ---- Roman Legion wiring
test("Normal style: no stage, no demo panel, and a logged meal triggers no reaction", () => {
  const h = page();
  h.run("renderLegion(null)");
  assert.equal(h.el("legionStage").hidden, true);
  assert.equal(h.el("legionDemo").hidden, true);
  h.run("afterMealLogged()");
  assert.equal(h.run("legion.current"), null);
});

test("Roman style: stage and the clearly-labelled demo panel appear; the idle line comes from real totals", () => {
  const h = page({ storage: { lookMode: "roman" } });
  h.run('state.legionIdle = "idle"; renderLegion(null)');
  assert.equal(h.el("legionStage").hidden, false);
  assert.equal(h.el("legionDemo").hidden, false);
  assert.equal(h.el("legionText").textContent, "Имаш план. Спазвай го.");
  assert.equal(h.el("legionDemoTag").hidden, true, "the idle line is not a demo");
  assert.match(h.el("legionPortrait").innerHTML, /lg-portrait/);
});

test("the demo toggle can hide the demo panel and remembers the choice", () => {
  const h = page({ storage: { lookMode: "roman" } });
  h.el("demoToggle").checked = false;
  h.fire("demoToggle", "change", { target: h.el("demoToggle") });
  assert.equal(h.el("legionDemo").hidden, true);
  assert.equal(h.run('localStorage.getItem("legionDemo")'), "0");
});

test("demo reactions: labelled DEMO, correct mood and text, chips marked demo, and NOT ONE request is sent", () => {
  const h = page({ storage: { lookMode: "roman" }, route: async () => json(200, {}) });
  const before = h.calls.fetches.length;
  h.fire("demoApprove", "click");
  assert.equal(h.run("legion.current.mood"), "approve");
  assert.equal(h.el("legionDemoTag").hidden, false);
  h.fire("demoRemind", "click");
  assert.equal(h.run("legion.current.mood"), "remind");
  assert.match(h.el("legionText").textContent, /18:30/);
  assert.match(h.el("legionChips").innerHTML, /18:30 · демо/);
  h.fire("demoDemand", "click");
  assert.equal(h.run("legion.current.mood"), "demand");
  assert.ok(require("../../frontend/legion.js").LINES.demand.bg.includes(h.el("legionText").textContent), "a line of the missing-record set");
  assert.match(h.el("legionChips").innerHTML, /15:40 · демо/);
  assert.equal(h.calls.fetches.length, before, "demo reactions never touch the network");
  assert.equal(h.run("legion.current.demo"), true);
});

test("approval follows a REAL meal log and is not marked demo; it works in English too", () => {
  const h = page({ storage: { lookMode: "roman", lang: "en" } });
  h.run("afterMealLogged()");
  assert.equal(h.run("legion.current.kind"), "approve");
  assert.equal(h.run("legion.current.demo"), false);
  assert.equal(h.el("legionDemoTag").hidden, true);
  assert.ok(h.run("legion.current.text").length > 10);
});

test("a language switch restarts the line in the new language", () => {
  const h = page({ storage: { lookMode: "roman" } });
  h.stub("renderUserList");
  h.run('legion.show("demand", { lang: "bg", demo: true })');
  h.run('localStorage.setItem("lang", "en"); legion.reset(); state.legionIdle = "idle"; renderLegion(null)');
  assert.equal(h.el("legionText").textContent, "You have a plan. Stick to it.");
});

test("what is logged is never touched by the legion: the demo adds no entry and sends no write", () => {
  const h = page({ storage: { lookMode: "roman" }, route: async () => json(200, {}) });
  h.fire("demoDemand", "click");
  assert.equal(h.calls.fetches.filter((f) => f.method !== "GET").length, 0);
});
