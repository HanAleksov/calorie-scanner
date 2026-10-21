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
const L = require("../../frontend/legion.js");
const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "frontend", "index.html"), "utf8");

test("Normal style: no centurion, no bubble, no preview entry, and a logged meal triggers no reaction", () => {
  const h = page();
  h.run("renderLegion(null)");
  assert.equal(h.el("legionStage").hidden, true);
  assert.equal(h.el("legionBubble").hidden, true);
  assert.equal(h.el("legionPreviewBtn").hidden, true);
  h.run("afterMealLogged()");
  assert.equal(h.run("legion.current"), null);
});

test("Roman style shows the app itself: the centurion and a calm line from real totals, and NO demo tooling on Today", () => {
  const h = page({ storage: { lookMode: "roman" } });
  h.run('state.legionIdle = "idle"; renderLegion(null)');
  assert.equal(h.el("legionStage").hidden, false);
  assert.equal(h.el("legionBubble").hidden, false);
  assert.equal(h.el("legionText").textContent, "Имаш план. Спазвай го.");
  assert.match(h.el("legionPortrait").innerHTML, /data-mood="idle"/);
  const today = html.slice(html.indexOf('id="tab-today"'), html.indexOf('id="tab-history"'));
  for (const gone of ["legionDemo", "demoApprove", "demoRemind", "demoDemand", "demoToggle", "ДЕМО", "DEMO"]) assert.ok(!today.includes(gone), `Today still has ${gone}`);
  assert.ok(!html.includes('id="demoToggle"'), "the old always-on toggle is gone");
});

test("the reaction preview is opened explicitly from Settings, which steps aside and comes back (see dialogs tests)", () => {
  const h = page({ storage: { lookMode: "roman" } });
  h.run("renderLegion(null)");
  assert.equal(h.el("legionPreviewBtn").hidden, false, "offered in Roman style");
  h.el("settingsModal").classList.remove("hidden");
  h.el("legionPreviewModal").classList.add("hidden");
  h.fire("legionPreviewBtn", "click");
  assert.equal(h.el("settingsModal").classList.contains("hidden"), true, "Settings closes");
  assert.equal(h.el("legionPreviewModal").classList.contains("hidden"), false, "the preview opens");
  assert.match(html, /id="legionPreviewModal"[\s\S]*?data-i18n="legion_demo_tag"/, "the preview dialog is labelled DEMO");
  h.fire("legionPreviewCloseBtn", "click");
  assert.equal(h.el("legionPreviewModal").classList.contains("hidden"), true);
});

test("preview reactions: right mood and text IN THE PREVIEW, chips marked demo, the real screen untouched, NOT ONE request sent", () => {
  const h = page({ storage: { lookMode: "roman" }, route: async () => json(200, {}) });
  const before = h.calls.fetches.length;
  h.fire("demoApprove", "click");
  assert.equal(h.run("previewLegion.current.mood"), "approve");
  h.fire("demoRemind", "click");
  assert.equal(h.run("previewLegion.current.mood"), "remind");
  assert.match(h.el("legionPreviewText").textContent, /18:30/);
  assert.match(h.el("legionPreviewChips").innerHTML, /18:30 · демо/);
  h.fire("demoDemand", "click");
  assert.equal(h.run("previewLegion.current.mood"), "demand");
  assert.ok(L.LINES.demand.bg.includes(h.el("legionPreviewText").textContent), "a line of the missing-record set");
  assert.match(h.el("legionPreviewChips").innerHTML, /15:40 · демо/);
  assert.equal(h.run("legion.current"), null, "the real hero was not touched by the preview");
  assert.equal(h.calls.fetches.length, before, "preview reactions never touch the network");
});

test("approval follows a REAL meal log on the real screen; it works in English too", () => {
  const h = page({ storage: { lookMode: "roman", lang: "en" } });
  h.run("afterMealLogged()");
  assert.equal(h.run("legion.current.kind"), "approve");
  assert.equal(h.run("legion.current.demo"), false);
  assert.ok(h.el("legionText").textContent.length > 10);
  assert.match(h.el("legionPortrait").innerHTML, /is-active" data-mood="approve"|data-mood="approve"/);
});

test("a language switch restarts the line in the new language", () => {
  const h = page({ storage: { lookMode: "roman" } });
  h.stub("renderUserList");
  h.run('legion.show("approve", { lang: "bg" })');
  h.run('localStorage.setItem("lang", "en"); legion.reset(); state.legionIdle = "idle"; renderLegion(null)');
  assert.equal(h.el("legionText").textContent, "You have a plan. Stick to it.");
});

test("what is logged is never touched by the legion: previews add no entry and send no write", () => {
  const h = page({ storage: { lookMode: "roman" }, route: async () => json(200, {}) });
  h.fire("demoDemand", "click");
  assert.equal(h.calls.fetches.filter((f) => f.method !== "GET").length, 0);
});

// ---- compact Today: water strip, folds, energy
test("water: +250 ml is the main action; the other amounts sit behind an expander", () => {
  const h = page({ route: async () => json(200, { water_ml: 1250 }) });
  const today = html.slice(html.indexOf('id="tab-today"'), html.indexOf('id="tab-history"'));
  assert.ok(today.indexOf('id="addWater250"') < today.indexOf('id="waterMore"'), "main button first, extras after");
  assert.match(today, /id="waterMore" hidden>[\s\S]*id="removeWater250"[\s\S]*id="addWater500"/, "extras start hidden");
  h.fire("waterMoreBtn", "click");
  assert.equal(h.el("waterMoreBtn").getAttribute("aria-expanded"), "true");
  assert.equal(h.el("waterMore").hidden, false);
  h.fire("waterMoreBtn", "click");
  assert.equal(h.el("waterMore").hidden, true);
  assert.equal(h.el("waterMoreBtn").getAttribute("aria-expanded"), "false");
});

test("order on Today: summary, water strip, meals; then energy, advice and suggestions folded, then the diary row", () => {
  const today = html.slice(html.indexOf('id="tab-today"'), html.indexOf('id="tab-history"'));
  const at = (id) => today.indexOf(id);
  assert.ok(at('id="heroCard"') < at('class="card water-card"') && at('class="card water-card"') < at('id="entriesList"'));
  assert.ok(at('id="entriesList"') < at('class="card energy-card"') && at('class="card energy-card"') < at('id="tipCard"') && at('id="tipCard"') < at('id="gapRecommenderCard"') && at('id="gapRecommenderCard"') < at('id="diaryLink"'));
  assert.match(today, /<details class="card fold" id="tipCard">/, "tip starts folded (no open attribute)");
  assert.match(today, /<details class="card fold" id="gapRecommenderCard" hidden>/, "suggestions start folded");
  assert.ok(!/id="tipCard"[^>]*\bopen\b/.test(today) && !/id="gapRecommenderCard"[^>]*\bopen\b/.test(today));
});

test("energy with no data: a short status and a SEPARATE explanatory line; with data the line goes away", () => {
  const h = page();
  h.run("renderEnergy(null)");
  assert.equal(h.el("energyVal").textContent, "Няма данни");
  assert.ok(h.el("energyVal").textContent.length < 14, "the right-hand status stays short");
  assert.equal(h.el("energyHint").hidden, false);
  assert.match(h.el("energyHint").textContent, /снимка/);
  h.run("renderEnergy(3.6)");
  assert.equal(h.el("energyVal").textContent, "3.6/5");
  assert.equal(h.el("energyHint").hidden, true);
});

test("states the screen must survive: empty day, a very long meal name, values over the target", () => {
  const h = page();
  h.run(`state.goalType = "gain"; renderTotals({ calories: 2760, protein_g: 185, carbs_g: 300, fat_g: 102, energy_avg: null }, ${JSON.stringify(goals)})`);
  assert.equal(h.el("ringCalsLeft").textContent, 0, "never negative");
  assert.equal(h.el("calBarFill").style.width, "100%", "the bar stops at full");
  assert.equal(h.el("proteinFill").style.width, "100%");
  const long = "Домашна мусака ".repeat(12);
  h.run(`renderEntries(${JSON.stringify([entry(1, long, 640, "08:20", { confidence: "low", notes: "Порция около 400 г" })])})`);
  const rows = h.el("entriesList").innerHTML;
  assert.match(rows, /low-confidence/);
  assert.match(rows, /Порция около 400 г/);
  assert.ok(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "frontend", "style.css"), "utf8").match(/\.entry-title \{[^}]*text-overflow: ellipsis/), "a long name is cut with an ellipsis, never wraps the row apart");
  h.run("renderEntries([])");
  assert.match(h.el("entriesList").innerHTML, /empty-state/);
});

// ---- the counter (animation) must not be overwritten by a stale frame
test("counter: two renders with the same new values end on that value, and a stale frame never pulls it back", () => {
  const h = loadApp({ storage: { lang: "bg" }, animation: true });
  h.stub("loadToday");
  h.run("state.firstTodayRender = false");
  const render = (cals) => h.run(`renderTotals({ calories: ${cals}, protein_g: 0, carbs_g: 0, fat_g: 0, energy_avg: null }, ${JSON.stringify(goals)})`);
  render(1440);                                   // 960 left (first paint of this element: instant)
  assert.equal(h.el("ringCalsLeft").textContent, 960);
  render(1740); render(1740);                     // the SAME new total twice, back to back: 660 left
  const seen = [];
  for (let i = 0; i < 14; i++) { h.frames.step(60); seen.push(Number(h.el("ringCalsLeft").textContent)); }
  assert.equal(seen[seen.length - 1], 660, `ended on ${seen[seen.length - 1]}`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] <= seen[i - 1], `the number went back up: ${seen.join(", ")}`);
});

test("counter: a call in the middle of an animation takes over from what is shown and the old frames stop", () => {
  const h = loadApp({ storage: { lang: "bg" }, animation: true });
  h.stub("loadToday");
  h.run("state.firstTodayRender = false");
  const render = (cals) => h.run(`renderTotals({ calories: ${cals}, protein_g: 0, carbs_g: 0, fat_g: 0, energy_avg: null }, ${JSON.stringify(goals)})`);
  render(1440);
  render(1740);                                   // heading to 660
  h.frames.step(150);
  const mid = Number(h.el("ringCalsLeft").textContent);
  assert.ok(mid < 960 && mid > 660, `mid-animation ${mid}`);
  render(1940);                                   // new target 460, called mid-animation
  const seen = [];
  for (let i = 0; i < 14; i++) { h.frames.step(60); seen.push(Number(h.el("ringCalsLeft").textContent)); }
  assert.equal(seen[seen.length - 1], 460);
  assert.ok(seen.every((v) => v <= mid), `it never jumps back up above ${mid}: ${seen.join(", ")}`);
  assert.equal(h.frames.pending, 0, "no frames left running");
});

test("counter: an INSTANT update (no animation) also cancels a running one, so its frames can't overwrite it", () => {
  const h = loadApp({ storage: { lang: "bg" }, animation: true });
  h.stub("loadToday");
  h.run("state.firstTodayRender = false");
  const render = (cals) => h.run(`renderTotals({ calories: ${cals}, protein_g: 0, carbs_g: 0, fat_g: 0, energy_avg: null }, ${JSON.stringify(goals)})`);
  render(1440);
  render(1740);                                   // animating towards 660
  h.frames.step(120);
  h.run("state.firstTodayRender = true");         // e.g. a reload paints instantly
  render(1940);                                   // 460, set at once
  assert.equal(h.el("ringCalsLeft").textContent, 460);
  for (let i = 0; i < 14; i++) { h.frames.step(60); assert.equal(h.el("ringCalsLeft").textContent, 460, `a stale frame overwrote it at step ${i}`); }
});

test("counter: the very first paint and reduced motion are instant", () => {
  const h = loadApp({ storage: { lang: "bg" }, animation: true });
  h.stub("loadToday");
  h.run(`renderTotals({ calories: 1440, protein_g: 0, carbs_g: 0, fat_g: 0, energy_avg: null }, ${JSON.stringify(goals)})`);
  assert.equal(h.el("ringCalsLeft").textContent, 960);
  assert.equal(h.frames.pending, 0, "first paint schedules no animation");
});
