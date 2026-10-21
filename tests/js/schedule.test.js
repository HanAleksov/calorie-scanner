const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../../frontend/schedule.js");

const slots = [
  { meal_type: "breakfast", time: "08:00" },
  { meal_type: "lunch", time: "13:00" },
  { meal_type: "dinner", time: "19:00" },
];
const on = { enabled: true, lead_min: 15 };
const at = (hhmm, date = "2026-10-22") => ({ date, min: S.parseTime(hhmm) });
const ev = (over) => S.evaluate({ slots, reminders: on, entries: [], now: at("12:00"), local: null, ...over });

test("times parse and format", () => {
  assert.equal(S.parseTime("13:05"), 785);
  assert.equal(S.parseTime("8:05"), 485);
  assert.equal(S.parseTime("00:00"), 0);
  assert.equal(S.parseTime("23:59"), 1439);
  for (const bad of ["24:00", "12:60", "", null, undefined, "noon", "12", "12:5"]) assert.equal(S.parseTime(bad), null, String(bad));
  assert.equal(S.formatTime(785), "13:05");
  assert.equal(S.formatTime(0), "00:00");
  assert.equal(S.formatTime(1440 + 5), "00:05");
});

test("the app's clock follows the server time and rolls over at midnight", () => {
  const clock = S.clockFrom("2026-10-22T23:58:30", 1_000_000);
  assert.deepEqual(S.clockNow(clock, 1_000_000), { date: "2026-10-22", min: 1438 });
  assert.deepEqual(S.clockNow(clock, 1_000_000 + 60_000), { date: "2026-10-22", min: 1439 });
  assert.deepEqual(S.clockNow(clock, 1_000_000 + 120_000), { date: "2026-10-23", min: 0 });
  assert.deepEqual(S.clockNow(S.clockFrom("2026-12-31T23:59:50", 0), 20_000), { date: "2027-01-01", min: 0 });
  assert.equal(S.clockFrom("not a time", 0), null);
  assert.equal(S.clockNow(null, 5), null);
});

test("a planned meal is covered by enough entries of its meal type, in time order", () => {
  const two = [{ meal_type: "snack", time: "10:30" }, { meal_type: "snack", time: "16:00" }, { meal_type: "lunch", time: "13:00" }];
  assert.deepEqual(S.coverage(two, []), { "snack@10:30": false, "snack@16:00": false, "lunch@13:00": false });
  assert.deepEqual(S.coverage(two, [{ meal_type: "snack" }]), { "snack@10:30": true, "snack@16:00": false, "lunch@13:00": false });
  assert.deepEqual(S.coverage(two, [{ meal_type: "snack" }, { meal_type: "snack" }, { meal_type: "lunch" }]),
    { "snack@10:30": true, "snack@16:00": true, "lunch@13:00": true });
  // an unsorted list gives the same answer
  assert.deepEqual(S.coverage(two.slice().reverse(), [{ meal_type: "snack" }]), S.coverage(two, [{ meal_type: "snack" }]));
});

test("reminders off: the next meal is known but nobody is ever nudged", () => {
  const r = S.evaluate({ slots, reminders: { enabled: false, lead_min: 15 }, entries: [], now: at("13:10"), local: null });
  assert.equal(r.notice, null);
  assert.equal(r.next.key, "dinner@19:00");
  const none = S.evaluate({ slots, reminders: null, entries: [], now: at("12:50"), local: null });
  assert.equal(none.notice, null);
  assert.equal(none.next.key, "lunch@13:00");
});

test("upcoming reminder starts `lead` minutes before and lasts until the grace period ends", () => {
  assert.equal(ev({ now: at("12:44") }).notice, null);
  assert.deepEqual(ev({ now: at("12:45") }).notice, { phase: "upcoming", slot: slots[1], key: "lunch@13:00", minutes: 15 });
  assert.equal(ev({ now: at("13:00") }).notice.phase, "upcoming");
  assert.equal(ev({ now: at("13:29") }).notice.phase, "upcoming");
  assert.equal(ev({ now: at("13:29") }).notice.minutes, -29);                 // already late by 29 minutes
});

test("with no lead time the reminder is at the planned time", () => {
  const r = (hhmm) => ev({ reminders: { enabled: true, lead_min: 0 }, now: at(hhmm) }).notice;
  assert.equal(r("12:59"), null);
  assert.equal(r("13:00").phase, "upcoming");
});

test("after the grace period with no record he asks; after the window he stops", () => {
  assert.equal(ev({ now: at("13:30") }).notice.phase, "ask");
  assert.equal(ev({ now: at("13:30") }).notice.minutes, 30);
  assert.equal(ev({ now: at("16:00") }).notice.phase, "ask");
  assert.equal(ev({ now: at("16:01") }).notice, null);
});

test("a logged meal of that type ends the reminder, a different type does not", () => {
  assert.equal(ev({ now: at("13:40"), entries: [{ meal_type: "lunch" }] }).notice, null);
  assert.equal(ev({ now: at("13:40"), entries: [{ meal_type: "snack" }] }).notice.key, "lunch@13:00");
  assert.equal(ev({ now: at("12:50"), entries: [{ meal_type: "lunch" }] }).notice, null);
});

test("the eaten time of an entry plays no part (only the meal type counts)", () => {
  const entries = [{ meal_type: "lunch", eaten_time: null, created_at: "2026-10-22T09:00:00" }];
  assert.equal(ev({ now: at("13:40"), entries }).notice, null);
});

test("when two meals are overdue he asks about the latest one first, then the earlier one", () => {
  let r = ev({ now: at("14:00") });
  assert.equal(r.notice.key, "lunch@13:00");                                     // breakfast (08:00) is past the window already
  const wide = [{ meal_type: "snack", time: "11:00" }, { meal_type: "snack", time: "12:00" }];
  r = S.evaluate({ slots: wide, reminders: on, entries: [], now: at("12:40"), local: null });
  assert.equal(r.notice.key, "snack@12:00");
  r = S.evaluate({ slots: wide, reminders: on, entries: [{ meal_type: "snack" }], now: at("12:40"), local: null });
  assert.equal(r.notice.key, "snack@12:00");                                     // the first snack is covered, the second is still open
});

test("snoozing hides a slot until the snooze ends; skipping hides it for the day", () => {
  let local = S.emptyLocal("2026-10-22");
  local = S.snooze(local, "lunch@13:00", S.parseTime("13:55"));
  assert.equal(ev({ now: at("13:40"), local }).notice, null);
  assert.equal(ev({ now: at("13:55"), local }).notice.phase, "ask");
  local = S.skip(local, "lunch@13:00");
  assert.equal(ev({ now: at("13:55"), local }).notice, null);
  assert.equal(S.skip(local, "lunch@13:00"), local);                              // idempotent
});

test("answers from another day are ignored", () => {
  const yesterday = S.skip(S.emptyLocal("2026-10-21"), "lunch@13:00");
  assert.equal(ev({ now: at("13:40"), local: yesterday }).notice.key, "lunch@13:00");
});

test("next meal: the first planned, uneaten meal still ahead", () => {
  assert.equal(ev({ now: at("07:00") }).next.key, "breakfast@08:00");
  assert.equal(ev({ now: at("07:00") }).next.minutes, 60);
  assert.equal(ev({ now: at("07:00"), entries: [{ meal_type: "breakfast" }] }).next.key, "lunch@13:00");
  assert.equal(ev({ now: at("20:00") }).next, null);
  assert.equal(S.evaluate({ slots: [], reminders: on, entries: [], now: at("12:00"), local: null }).next, null);
});

test("slots with an unreadable time are ignored instead of crashing", () => {
  const r = S.evaluate({ slots: [{ meal_type: "lunch", time: "??" }, ...slots], reminders: on, entries: [], now: at("13:40"), local: null });
  assert.equal(r.notice.key, "lunch@13:00");
});

test("suggested meal type: the closest planned, uneaten meal within two hours, otherwise snack", () => {
  const pick = (hhmm, entries = []) => S.suggestMealType({ slots, entries, now: at(hhmm) });
  assert.equal(pick("12:30"), "lunch");
  assert.equal(pick("18:00"), "dinner");
  assert.equal(pick("12:30", [{ meal_type: "lunch" }]), "snack");               // lunch is done and dinner is further than 2 h
  assert.equal(pick("03:00"), "snack");
  assert.equal(S.suggestMealType({ slots: [], entries: [], now: at("12:00") }), "snack");
});

test("the preset is a fresh copy and every time in it is valid", () => {
  const a = S.presetSlots();
  a[0].time = "09:09";
  assert.equal(S.presetSlots()[0].time, "08:00");
  S.presetSlots().forEach((s) => { assert.notEqual(S.parseTime(s.time), null); assert.ok(S.MEAL_TYPES.includes(s.meal_type)); });
});

test("local answers survive in storage, and blocked or damaged storage is harmless", () => {
  const mem = {};
  const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; } };
  const local = S.skip(S.emptyLocal("2026-10-22"), "lunch@13:00");
  S.saveLocal(storage, local);
  assert.deepEqual(S.loadLocal(storage, "2026-10-22"), local);
  assert.deepEqual(S.loadLocal(storage, "2026-10-23"), S.emptyLocal("2026-10-23"));
  mem[S.STORE_KEY] = "{not json";
  assert.deepEqual(S.loadLocal(storage, "2026-10-22"), S.emptyLocal("2026-10-22"));
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(S.loadLocal(blocked, "2026-10-22"), S.emptyLocal("2026-10-22"));
  assert.doesNotThrow(() => S.saveLocal(blocked, local));
});

test("the module is pure: no network, no randomness, no real clock, no storage of its own", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../frontend/schedule.js"), "utf8").replace(/\/\/.*$/gm, "");
  for (const forbidden of ["fetch(", "XMLHttpRequest", "Math.random", "Date.now", "new Date()", "localStorage", "sessionStorage", "navigator", "Notification", "serviceWorker"]) {
    assert.ok(!src.includes(forbidden), `schedule.js must not use ${forbidden}`);
  }
});
