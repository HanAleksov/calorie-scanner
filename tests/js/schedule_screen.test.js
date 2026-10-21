// Run: node --test tests/js/*.test.js
// The meal schedule, the "time you ate", in-app reminders, Progress and Plan, driven through the REAL app.js
// (fake DOM, fake network, a movable clock, the page's own interval under test control).
const test = require("node:test");
const assert = require("node:assert/strict");
const { Blob } = require("node:buffer");
const { loadApp, json, settleFor } = require("./helpers/app_harness");

const T0 = Date.parse("2026-10-22T09:00:00Z");
const slots = [
  { meal_type: "breakfast", time: "08:00" }, { meal_type: "lunch", time: "13:00" }, { meal_type: "dinner", time: "19:30" },
];
const on = { enabled: true, lead_min: 15 };
const entry = (id, name, hour, over = {}) => ({
  id, meal_type: "snack", total_calories: 300, protein_g: 20, carbs_g: 30, fat_g: 10, confidence: "high", energy_score: null, notes: null,
  created_at: `2026-10-22T${hour}:00`, eaten_time: null, image_path: null, items: [{ name }], ...over,
});

function page(opts = {}) {
  const route = opts.route && ((p, o) => (p === "/api/session" && (!o.method || o.method === "GET") ? new Promise(() => {}) : opts.route(p, o)));
  const h = loadApp({ storage: { lang: "bg", ...(opts.storage || {}) }, route, confirm: opts.confirm, now: T0 });
  h.stub("loadToday");
  return h;
}
// Puts the page on a given day state: today's entries, the schedule, and the app's clock showing `at`.
function setDay(h, { at, entries = [], schedule = { slots, reminders: on } }) {
  h.run(`state.today = { date: "2026-10-22", entries: ${JSON.stringify(entries)}, totals: { calories: 0 }, goals: { calories: 2400 } };
    state.schedule = ${JSON.stringify(schedule)};
    state.clock = CSSchedule.clockFrom("2026-10-22T${at}:00", Date.now());`);
}
const bar = (h) => ({ shown: !h.el("reminderBar").hidden, title: h.el("reminderTitle").textContent, sub: h.el("reminderSub").textContent, ate: h.el("reminderAte").textContent });
const mood = (h) => h.run("legion.current ? legion.current.kind : null");

// ---------- eaten time vs logged time ----------
test("a row shows the time the user SAID they ate, and an entry without one only says when it was logged", () => {
  const h = page();
  h.run(`renderEntries(${JSON.stringify([entry(1, "Oats", "08:10", { eaten_time: "08:05" }), entry(2, "Chicken", "13:05")])})`);
  const html = h.el("entriesList").innerHTML;
  assert.match(html, /entry-time confirmed">[^]*Ядено в 08:05/);
  assert.match(html, /<span class="entry-time">Записано в 13:05<\/span>/);
  assert.equal((html.match(/entry-time confirmed/g) || []).length, 1, "only the timed entry is marked as confirmed");
  assert.ok(!/Ядено в 13:05/.test(html), "a logged time is never presented as an eating time");
});

test("the list is ordered by the time eaten, or - lacking one - the time logged", () => {
  const h = page();
  h.run(`renderEntries(${JSON.stringify([entry(1, "Late log, eaten early", "14:00", { eaten_time: "07:30" }), entry(2, "Lunch", "13:05"), entry(3, "Breakfast", "08:10")])})`);
  const html = h.el("entriesList").innerHTML;
  assert.ok(html.indexOf("Late log") < html.indexOf("Breakfast") && html.indexOf("Breakfast") < html.indexOf("Lunch"), "07:30, 08:10, 13:05");
});

test("English wording for the two kinds of time", () => {
  const h = page({ storage: { lang: "en" } });
  h.run(`renderEntries(${JSON.stringify([entry(1, "Oats", "08:10", { eaten_time: "08:05" }), entry(2, "Chicken", "13:05")])})`);
  const html = h.el("entriesList").innerHTML;
  assert.match(html, /Ate at 08:05/);
  assert.match(html, /Logged 13:05/);
});

// ---------- sheets that log a meal ----------
test("manual entry: the sheet's own meal type and time are what is sent", async () => {
  const sent = [];
  const h = page({ route: async (p, o) => { sent.push({ p, body: o.body }); return json(200, { id: 1 }); } });
  setDay(h, { at: "16:00" });
  h.fire("manualEntryBtn", "click");
  assert.equal(h.el("manualMealTime").value, "16:00", "starts at the app's current time");
  assert.equal(h.el("manualMealType").value, "snack", "no meal planned around now -> Snack");
  h.el("manualDesc").value = "Shake"; h.el("manualCals").value = "300";
  h.el("manualMealType").value = "breakfast"; h.el("manualMealTime").value = "10:15";
  h.fire("manualSaveBtn", "click");
  await settleFor();
  const form = sent.find((c) => c.p === "/api/log-manual").body;
  assert.equal(form.get("meal_type"), "breakfast");
  assert.equal(form.get("eaten_time"), "10:15");
});

test("manual entry: an emptied time field sends no time at all (nothing is invented)", async () => {
  const sent = [];
  const h = page({ route: async (p, o) => { sent.push({ p, body: o.body }); return json(200, { id: 1 }); } });
  setDay(h, { at: "11:00" });
  h.fire("manualEntryBtn", "click");
  h.el("manualDesc").value = "Shake"; h.el("manualCals").value = "300"; h.el("manualMealTime").value = "";
  h.fire("manualSaveBtn", "click");
  await settleFor();
  assert.equal(sent.find((c) => c.p === "/api/log-manual").body.get("eaten_time"), null);
});

test("the meal type suggested for a new entry is the planned, uneaten meal closest to now", () => {
  const h = page();
  setDay(h, { at: "12:40" });
  h.fire("manualEntryBtn", "click");
  assert.equal(h.el("manualMealType").value, "lunch");
  assert.equal(h.el("manualMealTime").value, "12:40");
  setDay(h, { at: "12:40", entries: [entry(1, "Lunch", "12:00", { meal_type: "lunch" })] });
  h.fire("manualEntryBtn", "click");
  assert.equal(h.el("manualMealType").value, "snack", "lunch is already logged -> back to Snack");
});

test("photo: the review sheet carries the meal type and time to the analysis request", async () => {
  const sent = [];
  const h = page({ route: async (p, o) => { sent.push({ p, body: o.body }); return json(200, { total_calories: 520, confidence: "high" }); } });
  setDay(h, { at: "13:10" });
  h.ctx.__photo = new Blob(["x"], { type: "image/jpeg" });
  h.run("state.pendingPhotos = [__photo]; openPhotoReview()");
  assert.equal(h.el("photoMealType").value, "lunch");
  assert.equal(h.el("photoMealTime").value, "13:10");
  h.el("photoMealTime").value = "12:55";
  h.fire("photoAnalyzeBtn", "click");
  await settleFor();
  const form = sent.find((c) => c.p === "/api/log-meal").body;
  assert.equal(form.get("meal_type"), "lunch");
  assert.equal(form.get("eaten_time"), "12:55");
});

test("favourites: the sheet's meal type and time go with the log request", async () => {
  const sent = [];
  const h = page({ route: async (p, o) => { sent.push({ p, body: o.body }); return json(200, { id: 1 }); } });
  setDay(h, { at: "16:00" });
  h.stub("renderFavorites");
  h.fire("quickAddBtn", "click");
  assert.equal(h.el("favMealTime").value, "16:00");
  h.el("favMealType").value = "snack"; h.el("favMealTime").value = "15:40";
  h.run("logFavorite(7)");
  await settleFor();
  const call = sent.find((c) => c.p === "/api/favorites/7/log");
  assert.deepEqual(JSON.parse(call.body), { meal_type: "snack", eaten_time: "15:40" });
});

// ---------- the editor ----------
async function editSent(initial, change) {
  const sent = [];
  const h = page({ route: async (p, o) => {
    if (o.method === "PUT") { sent.push(JSON.parse(o.body)); return json(200, {}); }
    return json(200, { id: 5, meal_type: "lunch", total_calories: 500, protein_g: 20, carbs_g: 30, fat_g: 10, created_at: "2026-10-22T13:05:00", eaten_time: initial, items: [{ name: "x", est_grams: null }] });
  } });
  await h.run("openEdit(5)");
  await settleFor();
  change(h);
  h.fire("editSaveBtn", "click");
  await settleFor();
  return { h, payload: sent[0] };
}

test("editor: an old entry opens with an empty time and a note that it was never confirmed", async () => {
  const { h } = await editSent(null, () => {});
  assert.equal(h.el("editMealTime").value, "");
  assert.match(h.el("editTimeNote").textContent, /Записано в 13:05\. Часът на хранене не е потвърден/);
});

test("editor: saving without touching the time sends no eaten_time (it can never be confirmed by accident)", async () => {
  const { payload } = await editSent(null, (h) => { h.el("editMealType").value = "dinner"; });
  assert.equal("eaten_time" in payload, false);
  assert.equal(payload.meal_type, "dinner");
});

test("editor: typing a time sends it; clearing a stored one sends null; an unchanged stored one is not resent", async () => {
  assert.equal((await editSent(null, (h) => { h.el("editMealTime").value = "12:50"; })).payload.eaten_time, "12:50");
  assert.equal((await editSent("12:50", (h) => { h.el("editMealTime").value = ""; })).payload.eaten_time, null);
  assert.equal("eaten_time" in (await editSent("12:50", () => {})).payload, false);
});

test("editor: a confirmed time is shown together with when it was logged", async () => {
  const { h } = await editSent("12:50", () => {});
  assert.match(h.el("editTimeNote").textContent, /Записано в 13:05\. Ти си посочил, че си ял в 12:50/);
});

// ---------- the next meal ----------
test("Today names the next planned, uneaten meal; nothing planned (or all done) -> no line", () => {
  const h = page();
  setDay(h, { at: "11:00", entries: [entry(1, "Oats", "08:10", { meal_type: "breakfast" })] });
  h.run("reminderTick()");
  assert.equal(h.el("nextMeal").hidden, false);
  assert.equal(h.el("nextMeal").textContent, "Следва: Обяд · 13:00");
  setDay(h, { at: "20:00" });
  h.run("reminderTick()");
  assert.equal(h.el("nextMeal").hidden, true);
  setDay(h, { at: "11:00", schedule: { slots: [], reminders: on } });
  h.run("reminderTick()");
  assert.equal(h.el("nextMeal").hidden, true);
});

// ---------- reminders ----------
test("reminders OFF: nothing ever shows, whatever the time", () => {
  const h = page();
  for (const at of ["07:50", "13:40", "20:00"]) {
    setDay(h, { at, schedule: { slots, reminders: { enabled: false, lead_min: 15 } } });
    h.run("reminderTick()");
    assert.equal(bar(h).shown, false, at);
  }
});

test("reminders ON: a reminder before the planned time, then a question when there is no record", () => {
  const h = page();
  setDay(h, { at: "19:10" });
  h.run("reminderTick()");
  assert.equal(bar(h).shown, false, "20 minutes before is outside the 15 minute lead");
  setDay(h, { at: "19:20" });
  h.run("reminderTick()");
  assert.deepEqual([bar(h).shown, bar(h).title, bar(h).ate], [true, "Вечеря · 19:30", "Запиши"]);
  setDay(h, { at: "20:05" });
  h.run("reminderTick()");
  assert.deepEqual([bar(h).shown, bar(h).title, bar(h).sub, bar(h).ate], [true, "Вечеря · 19:30 — няма запис", "Яде ли?", "Ядох"]);
  setDay(h, { at: "20:05", entries: [entry(9, "Dinner", "19:50", { meal_type: "dinner" })] });
  h.run("reminderTick()");
  assert.equal(bar(h).shown, false, "a dinner entry ends it");
});

test("the question is only asked for meals that really have no record", () => {
  const h = page();
  setDay(h, { at: "13:45", entries: [entry(1, "Oats", "08:10", { meal_type: "breakfast" })] });
  h.run("reminderTick()");
  assert.equal(bar(h).title, "Обяд · 13:00 — няма запис", "lunch is open, breakfast was logged");
  setDay(h, { at: "13:45", entries: [entry(1, "Oats", "08:10", { meal_type: "breakfast" }), entry(2, "Lunch", "13:20", { meal_type: "lunch" })] });
  h.run("reminderTick()");
  assert.equal(bar(h).shown, false);
});

test("an unconfirmed old entry (no eaten time) still counts as the meal being logged; its upload time does not matter", () => {
  const h = page();
  setDay(h, { at: "20:00", entries: [entry(1, "Dinner", "09:00", { meal_type: "dinner", eaten_time: null })] });
  h.run("reminderTick()");
  assert.equal(bar(h).shown, false);
});

test("Later hides it for 15 minutes and it comes back; the answer is kept on this device for the day", () => {
  const h = page();
  setDay(h, { at: "20:05" });
  h.run("reminderTick()");
  h.fire("reminderLater", "click");
  assert.equal(bar(h).shown, false);
  assert.match(h.run("localStorage.getItem('csReminderState')"), /dinner@19:30/);
  setDay(h, { at: "20:10" });
  h.run("reminderTick()");
  assert.equal(bar(h).shown, false, "still snoozed (until 20:20)");
  setDay(h, { at: "20:20" });
  h.run("reminderTick()");
  assert.equal(bar(h).shown, true);
});

test("Skip hides that meal for the whole day, other meals are not affected, and a new day starts fresh", () => {
  const h = page();
  setDay(h, { at: "13:45" });
  h.run("reminderTick()");
  h.fire("reminderSkip", "click");
  assert.equal(bar(h).shown, false);
  setDay(h, { at: "20:05" });
  h.run("reminderTick()");
  assert.equal(bar(h).title, "Вечеря · 19:30 — няма запис", "lunch was skipped, dinner still asks");
  h.run(`state.clock = CSSchedule.clockFrom("2026-10-23T13:45:00", Date.now()); state.today.date = "2026-10-23"`);
  h.run("reminderTick()");
  assert.equal(bar(h).title, "Обяд · 13:00 — няма запис", "yesterday's skip is not carried over");
});

test("a saved answer survives a page reload (read back from storage)", () => {
  const first = page();
  setDay(first, { at: "20:05" });
  first.run("reminderTick()");
  first.fire("reminderSkip", "click");
  const saved = first.run("localStorage.getItem('csReminderState')");
  const second = page({ storage: { csReminderState: saved } });
  setDay(second, { at: "20:05" });
  second.run("reminderTick()");
  assert.equal(bar(second).shown, false);
});

test("'I ate' opens the add panel and its next step starts at the planned meal", () => {
  const h = page();
  setDay(h, { at: "20:05" });
  h.run("reminderTick()");
  h.el("addFoodModal").classList.add("hidden");
  h.fire("reminderAte", "click");
  assert.equal(h.el("addFoodModal").classList.contains("hidden"), false);
  h.fire("manualEntryBtn", "click");
  assert.equal(h.el("manualMealType").value, "dinner");
  h.el("addFoodModal").classList.add("hidden");
  h.fire("addFoodBtn", "click");                         // the ordinary button: no reminder context any more
  h.fire("manualEntryBtn", "click");
  assert.equal(h.run("state.addContext"), null, "context cleared");
});

test("a midnight rollover while the page stays open reloads Today instead of using a stale day", () => {
  const h = page();
  h.run("loadToday = () => { globalThis.__loads = (globalThis.__loads || 0) + 1; }");
  setDay(h, { at: "23:50" });
  h.run(`state.clock = CSSchedule.clockFrom("2026-10-22T23:59:59", Date.now())`);
  h.setNow(T0 + 3000);
  h.run("reminderTick()");
  assert.equal(h.run("globalThis.__loads"), 1);
});

test("the page's own timer ticks the reminders (every 15 s) and does not need a reload", () => {
  const h = page();
  assert.equal(h.timers.count >= 1, true, "an interval was registered");
  setDay(h, { at: "20:05" });
  h.el("reminderBar").hidden = true;
  h.timers.tick();
  assert.equal(bar(h).shown, true);
});

test("the reminder text is not rewritten on every tick (it is a live region: it would be re-read)", () => {
  const h = page();
  setDay(h, { at: "20:05" });
  h.run("reminderTick()");
  let writes = 0;
  const el = h.el("reminderTitle");
  const original = el.textContent;
  Object.defineProperty(el, "textContent", { get: () => original, set: () => { writes += 1; }, configurable: true });
  h.run("reminderTick(); reminderTick(); reminderTick()");
  assert.equal(writes, 0);
});

test("changing the language redraws a visible reminder in the new language", () => {
  const h = page();
  setDay(h, { at: "20:05" });
  h.run("reminderTick()");
  assert.match(bar(h).title, /няма запис/);
  h.run("localStorage.setItem('lang', 'en'); reminderTick()");
  assert.equal(bar(h).title, "Dinner · 19:30 — no record");
});

test("without a clock (Today never loaded) nothing is drawn and nothing crashes", () => {
  const h = page();
  assert.doesNotThrow(() => h.run("reminderTick()"));
  assert.equal(bar(h).shown, false);
});

// ---------- Roman ----------
test("Roman: the centurion reminds, then asks, and goes back to calm when it is resolved", () => {
  const h = page({ storage: { lookMode: "roman" } });
  setDay(h, { at: "19:20" });
  h.run("reminderTick()");
  assert.equal(mood(h), "remind");
  assert.match(h.el("legionText").textContent, /19:30/);
  setDay(h, { at: "20:05" });
  h.run("reminderTick()");
  assert.equal(mood(h), "demand");
  h.fire("reminderSkip", "click");
  assert.equal(mood(h), null, "reaction cleared with the bar");
});

test("Roman: a calm line names the next planned meal, and is not redrawn on every tick", () => {
  const h = page({ storage: { lookMode: "roman" } });
  h.run(`state.goalType = "gain"; state.today = { date: "2026-10-22", entries: [{ id: 1, meal_type: "breakfast" }], totals: { calories: 500 }, goals: { calories: 2400 } }; state.schedule = ${JSON.stringify({ slots, reminders: { enabled: false, lead_min: 15 } })}; state.clock = CSSchedule.clockFrom("2026-10-22T11:00:00", Date.now())`);
  h.run("reminderTick()");
  assert.match(h.el("legionText").textContent, /обяд.*13:00|13:00.*обяд/);
  h.run("const __r = renderLegion; renderLegion = (r) => { globalThis.__draws = (globalThis.__draws || 0) + 1; return __r(r); }");
  h.run("reminderTick(); reminderTick(); reminderTick()");
  assert.equal(h.run("globalThis.__draws || 0"), 0);
});

test("Roman: an approval that is on screen is not pushed out by a reminder for another meal", () => {
  const h = page({ storage: { lookMode: "roman" } });
  setDay(h, { at: "20:05" });
  h.run("legion.show('approve', { lang: 'bg' })");
  h.run("reminderTick()");
  assert.equal(mood(h), "approve");
  assert.equal(bar(h).shown, true, "the bar itself still appears");
});

test("Normal style: the same reminder is a plain bar and the centurion is not involved", () => {
  const h = page();
  setDay(h, { at: "20:05" });
  h.run("reminderTick()");
  assert.equal(bar(h).shown, true);
  assert.equal(mood(h), null);
});

// ---------- the schedule dialog ----------
test("the dialog edits a copy: cancelling throws the changes away", () => {
  const h = page();
  setDay(h, { at: "11:00" });
  h.run("openSchedule()");
  assert.equal(h.el("scheduleModal").classList.contains("hidden"), false);
  h.run("scheduleDraftSet(0, 'time', '07:00'); scheduleDraftRemove(2)");
  assert.equal(h.run("state.scheduleDraft.slots.length"), 2);
  h.fire("scheduleCancelBtn", "click");
  assert.equal(h.el("scheduleModal").classList.contains("hidden"), true);
  assert.equal(h.run("state.schedule.slots.length"), 3);
  assert.equal(h.run("state.schedule.slots[0].time"), "08:00");
});

test("saving sends the slots and the reminder switch in ONE request and updates every view", async () => {
  const sent = [];
  const h = page({ route: async (p, o) => { sent.push({ p, method: o.method, body: JSON.parse(o.body) }); return json(200, { slots: [{ meal_type: "lunch", time: "12:30" }], reminders: { enabled: true, lead_min: 30 } }); } });
  setDay(h, { at: "11:00", schedule: { slots, reminders: { enabled: false, lead_min: 15 } } });
  h.run("openSchedule()");
  h.run("state.scheduleDraft.slots = [{ meal_type: 'lunch', time: '12:30' }]; state.scheduleDraft.reminders = { enabled: true, lead_min: 30 }");
  h.fire("scheduleSaveBtn", "click");
  await settleFor();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { p: "/api/schedule", method: "PUT", body: { slots: [{ meal_type: "lunch", time: "12:30" }], reminders: { enabled: true, lead_min: 30 } } });
  assert.equal(h.el("scheduleModal").classList.contains("hidden"), true);
  assert.match(h.el("scheduleSummary").innerHTML, /1 планирано хранене/);
  assert.match(h.el("scheduleSummary").innerHTML, /Напомняния · 30 мин преди/);
  assert.match(h.el("scheduleChips").innerHTML, /12:30/);
  assert.equal(h.el("scheduleValue").textContent, "1 хранения");
  assert.equal(h.run("state.scheduleDraft"), null);
});

test("a rejected schedule keeps the dialog open and the draft as typed, and says why", async () => {
  const h = page({ route: async () => json(422, { detail: { code: "duplicate", field: "slots[1].time", message: "x" } }) });
  setDay(h, { at: "11:00" });
  h.run("openSchedule()");
  h.run("scheduleDraftSet(1, 'time', '08:00')");
  h.fire("scheduleSaveBtn", "click");
  await settleFor();
  assert.equal(h.el("scheduleModal").classList.contains("hidden"), false);
  assert.equal(h.run("state.scheduleDraft.slots[1].time"), "08:00");
  assert.equal(h.run("state.schedule.slots[1].time"), "13:00", "the saved schedule is unchanged");
});

test("at most six meals; the preset only fills an empty list; a new row gets an unused time", () => {
  const h = page();
  setDay(h, { at: "11:00", schedule: { slots: [], reminders: on } });
  h.run("openSchedule()");
  assert.equal(h.el("schedulePresetBtn").hidden, false);
  h.fire("schedulePresetBtn", "click");
  assert.equal(h.run("state.scheduleDraft.slots.map(s => s.time).join()"), "08:00,13:00,19:00");
  assert.equal(h.el("schedulePresetBtn").hidden, true);
  for (let i = 0; i < 6; i++) h.fire("scheduleAddBtn", "click");
  const times = h.run("state.scheduleDraft.slots.map(s => s.time)");
  assert.equal(times.length, 6);
  assert.equal(new Set(times).size, 6, "no two rows share a time");
  assert.equal(h.el("scheduleAddBtn").disabled, true);
});

test("the toggle shows or hides the lead-time choice and is part of the draft only", () => {
  const h = page();
  setDay(h, { at: "11:00", schedule: { slots, reminders: { enabled: false, lead_min: 15 } } });
  h.run("openSchedule()");
  assert.equal(h.el("leadField").hidden, true);
  h.el("remindersToggle").checked = true;
  h.fire("remindersToggle", "change", { target: h.el("remindersToggle") });
  assert.equal(h.run("state.scheduleDraft.reminders.enabled"), true);
  assert.equal(h.el("leadField").hidden, false);
  assert.equal(h.run("state.schedule.reminders.enabled"), false, "nothing saved yet");
});

test("the dialog is reachable from the Plan card and from Settings (which it replaces and brings back)", () => {
  const h = page();
  setDay(h, { at: "11:00" });
  h.fire("scheduleEditBtn", "click");
  assert.equal(h.el("scheduleModal").classList.contains("hidden"), false);
  h.fire("scheduleCancelBtn", "click");
  h.el("settingsModal").classList.remove("hidden");
  h.fire("scheduleOpenBtn", "click");
  assert.equal(h.el("settingsModal").classList.contains("hidden"), true, "Settings steps aside");
  assert.equal(h.el("scheduleModal").classList.contains("hidden"), false);
});

test("an empty schedule says so and explains what it is for", () => {
  const h = page();
  setDay(h, { at: "11:00", schedule: { slots: [], reminders: { enabled: false, lead_min: 15 } } });
  h.run("renderScheduleViews()");
  assert.equal(h.el("scheduleSummary").innerHTML, "Още няма планирани хранения.");
  assert.match(h.el("scheduleChips").innerHTML, /sc-empty/);
  assert.equal(h.el("scheduleValue").textContent, "Не е зададен");
});

// ---------- Progress ----------
const day = (date, status, kcal, over = {}) => ({ date, status, mark: null, entry_count: status === "empty" ? 0 : 3, totals: { calories: kcal, protein_g: 100, carbs_g: 200, fat_g: 60 }, ...over });
const days14 = Array.from({ length: 14 }, (_, i) => day(`2026-10-${String(9 + i).padStart(2, "0")}`, i === 4 ? "partial" : i === 7 ? "empty" : "complete", i === 7 ? 0 : 2000 + i * 20));

test("Progress chart: a column per day, today marked, the selected day described, dim for days the analysis ignores", () => {
  const h = page();
  h.run(`state.historyDays = ${JSON.stringify(days14)}; state.historyGoal = 2400; state.historySelected = "2026-10-22"; renderHistory()`);
  const html = h.el("historyChart").innerHTML;
  assert.equal((html.match(/class="hc-col[ "]/g) || []).length, 14);
  assert.equal((html.match(/is-today/g) || []).length, 1);
  assert.equal((html.match(/is-unknown/g) || []).length, 2, "the partial day and the empty day");
  assert.equal((html.match(/is-empty/g) || []).length, 1);
  assert.match(html, /hc-goal/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(h.el("historyAvg").textContent, /Средно \d+ ккал · 12 от 14 пълни дни/);
  assert.match(h.el("historyLegend").innerHTML, /Цел 2400 ккал/);
  assert.match(h.el("historyDay").innerHTML, /2260 ккал/);
  assert.equal(h.el("historyHint").hidden, false, "partial days explain themselves");
});

test("Progress: the average is over full days only (a partial or empty day never drags it down)", () => {
  const h = page();
  const only = [day("2026-10-20", "complete", 2000), day("2026-10-21", "partial", 300), day("2026-10-22", "empty", 0)];
  h.run(`state.historyDays = ${JSON.stringify(only)}; state.historyGoal = null; state.historySelected = "2026-10-20"; renderHistory()`);
  assert.match(h.el("historyAvg").textContent, /Средно 2000 ккал · 1 от 3 пълни дни/);
  assert.equal(h.el("historyLegend").innerHTML, "", "no target line without a target");
  h.run(`state.historyDays = [${JSON.stringify(day("2026-10-22", "empty", 0))}]; state.historySelected = "2026-10-22"; renderHistory()`);
  assert.equal(h.el("historyAvg").textContent, "Още няма пълни дни");
});

test("Progress day detail: partial -> count it; confirmed/skipped -> back to inferred; an empty day has no action", () => {
  const h = page();
  const show = (d) => { h.run(`state.historyDays = [${JSON.stringify(d)}]; state.historySelected = ${JSON.stringify(d.date)}; renderHistoryDay()`); return h.el("historyDay").innerHTML; };
  assert.match(show(day("2026-10-22", "partial", 400)), /day-status-chip include" data-day="2026-10-22" data-next="complete"/);
  assert.match(show(day("2026-10-22", "skipped", 400, { mark: "skip" })), /day-status-chip" data-day="2026-10-22" data-next="clear"/);
  assert.match(show(day("2026-10-22", "complete", 2000, { mark: "complete" })), /day-status-chip confirmed" data-day="2026-10-22" data-next="clear"/);
  const inferred = show(day("2026-10-22", "complete", 2000));
  assert.ok(!/day-status-chip/.test(inferred), "an inferred full day needs no control");
  assert.match(inferred, /Пълен ден, брои се в анализа/);
  const empty = show(day("2026-10-22", "empty", 0));
  assert.ok(!/day-status-chip/.test(empty));
  assert.match(empty, /Нищо записано/);
});

test("Progress: the first and last day disable the step button that has nowhere to go", () => {
  const h = page();
  h.run(`state.historyDays = ${JSON.stringify(days14)}; state.historySelected = "2026-10-09"; renderHistoryDay()`);
  assert.match(h.el("historyDay").innerHTML, /data-step="-1"[^>]*disabled/);
  assert.ok(!/data-step="1"[^>]*disabled/.test(h.el("historyDay").innerHTML));
  h.run(`state.historySelected = "2026-10-22"; renderHistoryDay()`);
  assert.match(h.el("historyDay").innerHTML, /data-step="1"[^>]*disabled/);
});

test("Progress: selecting a day by id only works for a day that exists", () => {
  const h = page();
  h.run(`state.historyDays = ${JSON.stringify(days14)}; state.historySelected = "2026-10-22"; renderHistory()`);
  h.run(`selectHistoryDay("2026-10-12")`);
  assert.equal(h.run("state.historySelected"), "2026-10-12");
  h.run(`selectHistoryDay("1999-01-01")`);
  assert.equal(h.run("state.historySelected"), "2026-10-12");
});

const w = (id, kg, at) => ({ id, weight_kg: kg, logged_at: `${at}T08:00:00`, fat_mass_kg: null, muscle_mass_kg: null, water_pct: null });
const weights = [w(8, 70.0, "2026-10-21"), w(7, 69.7, "2026-10-19"), w(6, 69.4, "2026-10-16"), w(5, 69.0, "2026-10-13"), w(4, 69.1, "2026-10-10"), w(3, 68.4, "2026-10-01")];

test("weight hero: current weight with one decimal, the change since ~2 weeks ago, coloured by the goal", () => {
  const h = page();
  h.run(`renderWeightHero(${JSON.stringify(weights)}, "gain")`);
  assert.equal(h.el("weightNow").textContent, "70,0");
  assert.match(h.el("weightDelta").textContent, /^\+0,9 кг от 10 октомври$/);
  assert.equal(h.el("weightDelta").className, "wh-delta good", "gaining while the goal is gaining");
  h.run(`renderWeightHero(${JSON.stringify(weights)}, "lose")`);
  assert.equal(h.el("weightDelta").className, "wh-delta neutral", "gaining while losing is never shown as good");
});

test("weight hero: the line of recent weigh-ins, a first weigh-in, flat, and no data", () => {
  const h = page();
  h.run(`renderWeightHero(${JSON.stringify(weights)}, null)`);
  assert.match(h.el("weightSpark").innerHTML, /<path d="M[^"]+L/);
  assert.match(h.el("weightSpark").innerHTML, /<circle/);
  h.run(`renderWeightHero(${JSON.stringify([w(1, 65.2, "2026-10-21")])}, null)`);
  assert.equal(h.el("weightDelta").textContent, "Първо претегляне");
  assert.equal(h.el("weightSpark").innerHTML, "", "one point is not a line");
  h.run(`renderWeightHero(${JSON.stringify([w(2, 70, "2026-10-21"), w(1, 70, "2026-10-01")])}, "gain")`);
  assert.match(h.el("weightDelta").textContent, /^Без промяна от 1 октомври$/);
  h.run("renderWeightHero([], null)");
  assert.equal(h.el("weightNow").textContent, "–");
  assert.equal(h.el("weightSpark").innerHTML, "");
});

// ---------- Plan ----------
test("Plan: the targets are shown as a summary card (values and units), the goal is named, and a goal-less profile has no tag", () => {
  const h = page();
  h.run(`renderGoalsHero({ calories: 2400, protein_g: 150, carbs_g: 270, fat_g: 80, water_ml: 2500 })`);
  assert.equal(h.el("ghCalories").textContent, 2400);
  assert.equal(h.el("ghProtein").textContent, "150 г");
  assert.equal(h.el("ghWater").textContent, "2,5 л");
  h.run(`renderGoalTag("lose")`);
  assert.equal(h.el("ghGoalType").hidden, false);
  assert.equal(h.el("ghGoalType").textContent, "Сваляне");
  h.run(`renderGoalTag(null)`);
  assert.equal(h.el("ghGoalType").hidden, true);
});

// ---------- sign-in ----------
test("sign-in cards: initial letter, escaped names, a lock only for PIN profiles", async () => {
  const h = loadApp({ storage: { lang: "bg" }, route: async (p) => (p === "/api/users" ? json(200, [{ id: 1, name: "Ана <b>x</b>", has_pin: false }, { id: 2, name: "Боян", has_pin: true }]) : new Promise(() => {})) });
  await h.run("renderUserList()");
  const html = h.el("userList").innerHTML;
  assert.match(html, /pu-avatar[^>]*>А</);
  assert.match(html, /pu-avatar[^>]*>Б</);
  assert.ok(!html.includes("<b>x</b>"), "names are escaped");
  assert.equal((html.match(/pin-lock/g) || []).length, 1);
  assert.equal((html.match(/pu-go/g) || []).length, 1);
});

test("sign-in screen in Roman style speaks to the legionary", () => {
  const h = page({ storage: { lookMode: "roman" } });
  const title = { textContent: "" };
  h.ctx.document.querySelector = (s) => (s === "#userGate h1" ? title : null);
  h.run("refreshGate()");
  assert.match(title.textContent, /легионер/);
  const plain = page();
  const t2 = { textContent: "" };
  plain.ctx.document.querySelector = (s) => (s === "#userGate h1" ? t2 : null);
  plain.run("refreshGate()");
  assert.equal(t2.textContent, "Кой влиза?");
});

// ---------- toasts ----------
test("toasts never swallow taps and are announced", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "style.css"), "utf8");
  const rule = css.slice(css.indexOf(".toast {"), css.indexOf("}", css.indexOf(".toast {")));
  assert.match(rule, /pointer-events:\s*none/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "app.js"), "utf8"), /setAttribute\("role", "status"\)/);
});

// ---------- local only ----------
test("reminders are local: a tick, a snooze and a skip make no network request at all", () => {
  const h = page();
  setDay(h, { at: "20:05" });
  const before = h.calls.fetches.length;
  h.run("reminderTick()");
  h.fire("reminderLater", "click");
  setDay(h, { at: "20:30" });
  h.run("reminderTick()");
  h.fire("reminderSkip", "click");
  h.timers.tick();
  assert.equal(h.calls.fetches.length, before, "nothing was sent anywhere");
});

test("the reminder code path never mentions the AI or any paid endpoint", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "app.js"), "utf8");
  const block = app.slice(app.indexOf("// ================== MEAL SCHEDULE & IN-APP REMINDERS"), app.indexOf("// ---------- the schedule dialog ----------"));
  assert.ok(block.length > 2000, "found the reminder block");
  for (const banned of ["fetch(", "apiFetch(", "api.request(", "/api/coach", "/api/meal-plan", "/api/log-meal", "Notification", "serviceWorker"]) {
    assert.ok(!block.includes(banned), `the reminder block must not use ${banned}`);
  }
});
