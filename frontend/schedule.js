// The user's eating schedule and the in-app reminders built on it. Pure logic: no DOM, no network, no AI, no
// Math.random, no real clock (the caller passes "now"), so the same inputs always give the same answer and the
// whole thing is testable. app.js feeds it the server's schedule, today's entries and the app's clock, and draws
// the result.
//
// What it will and will not do:
//   * Reminders exist ONLY while the app is open (the page evaluates this every few seconds). There is no push, no
//     service-worker notification, no background timer: closing the app means no reminder.
//   * They are OFF until the user switches them on in the schedule dialog; with them off, the schedule still shows a
//     "next meal" line but nothing ever nudges.
//   * A planned meal counts as eaten when today has enough entries of its meal type (the 2nd breakfast-type slot needs
//     2 breakfast entries). The time of an entry is irrelevant here: an upload time is not proof of when something was
//     eaten, and old entries have no confirmed eating time at all.
(function (root) {
  "use strict";

  const GRACE_MIN = 30;        // after the planned time he waits this long before asking "did you eat?"
  const ASK_WINDOW_MIN = 180;  // ... and stops asking this long after the planned time
  const SNOOZE_MIN = 15;
  const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];
  const MAX_SLOTS = 6;
  const LEAD_CHOICES = [0, 5, 10, 15, 30, 60];
  const DEFAULT_SCHEDULE = [
    { meal_type: "breakfast", time: "08:00" },
    { meal_type: "lunch", time: "13:00" },
    { meal_type: "dinner", time: "19:00" },
  ];

  // "13:05" / "8:05" -> minutes since midnight; anything else -> null
  function parseTime(text) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text == null ? "" : text).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  function formatTime(min) {
    const m = ((Math.round(min) % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }

  // The app's clock: a naive local ISO string from the server ("2026-10-22T11:07:15") plus how long ago it was
  // received. Keeps the page on the app's (Sofia) time even if the phone is set to another time zone.
  function clockFrom(serverIso, receivedAtMs) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(serverIso || ""));
    if (!m) return null;
    return { date: m[1], sec: Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] || 0), at: receivedAtMs };
  }
  // -> { date, min } at the moment `nowMs`; the date rolls over at midnight so a page left open overnight stays right
  function clockNow(clock, nowMs) {
    if (!clock) return null;
    const total = clock.sec + Math.floor((nowMs - clock.at) / 1000);
    const days = Math.floor(total / 86400);
    let date = clock.date;
    if (days !== 0) {
      const d = new Date(`${clock.date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      date = d.toISOString().slice(0, 10);
    }
    return { date, min: Math.floor((((total % 86400) + 86400) % 86400) / 60) };
  }

  function slotKey(slot) { return `${slot.meal_type}@${slot.time}`; }

  // Which planned meals already have an entry today. Slots of one meal type are matched in time order.
  function coverage(slots, entries) {
    const eaten = {};
    (entries || []).forEach((e) => { eaten[e.meal_type] = (eaten[e.meal_type] || 0) + 1; });
    const seen = {};
    const out = {};
    (slots || []).slice().sort((a, b) => parseTime(a.time) - parseTime(b.time)).forEach((s) => {
      const i = seen[s.meal_type] || 0;
      seen[s.meal_type] = i + 1;
      out[slotKey(s)] = (eaten[s.meal_type] || 0) > i;
    });
    return out;
  }

  // Local, per-day memory of what the user answered ("later" / "skip today"). Never sent anywhere.
  function emptyLocal(day) { return { day, skipped: [], snoozed: {} }; }
  function freshLocal(local, day) { return local && local.day === day ? local : emptyLocal(day); }
  function snooze(local, key, untilMin) { return { ...local, snoozed: { ...local.snoozed, [key]: untilMin } }; }
  function skip(local, key) { return local.skipped.includes(key) ? local : { ...local, skipped: [...local.skipped, key] }; }

  // The whole decision. Returns
  //   next   - the first planned meal still ahead of "now" and not yet eaten (for the "next meal" line), or null
  //   notice - null, or { phase: "upcoming" | "ask", slot, key, minutes }   (only when reminders are on)
  //              upcoming: from `lead` minutes before the planned time until GRACE_MIN after it
  //              ask:      GRACE_MIN..ASK_WINDOW_MIN after the planned time with no entry of that type: "did you eat?"
  //            skipped slots and snoozed ones (until their snooze ends) are left out.
  function evaluate({ slots, reminders, entries, now, local }) {
    const list = (slots || []).filter((s) => parseTime(s.time) !== null).sort((a, b) => parseTime(a.time) - parseTime(b.time));
    const covered = coverage(list, entries);
    const nowMin = now.min;
    const result = { next: null, notice: null };

    const upcoming = list.find((s) => !covered[slotKey(s)] && parseTime(s.time) > nowMin);
    if (upcoming) result.next = { slot: upcoming, key: slotKey(upcoming), minutes: parseTime(upcoming.time) - nowMin };

    if (!reminders || !reminders.enabled) return result;
    const lead = Number.isFinite(reminders.lead_min) ? reminders.lead_min : 15;
    const lc = freshLocal(local, now.date);
    const quiet = (key) => lc.skipped.includes(key) || (lc.snoozed[key] != null && nowMin < lc.snoozed[key]);

    let ask = null;
    let remind = null;
    list.forEach((s) => {
      const key = slotKey(s);
      if (covered[key] || quiet(key)) return;
      const at = parseTime(s.time);
      if (nowMin >= at + GRACE_MIN && nowMin <= at + ASK_WINDOW_MIN) ask = { phase: "ask", slot: s, key, minutes: nowMin - at };   // the latest one wins
      else if (nowMin >= at - lead && nowMin < at + GRACE_MIN && !remind) remind = { phase: "upcoming", slot: s, key, minutes: at - nowMin };
    });
    result.notice = ask || remind;
    return result;
  }

  // Which meal type to suggest when the user starts logging: the planned, uneaten meal closest to now (within 2 hours
  // either way); otherwise "snack" (the old default). No guessing from the time of day.
  function suggestMealType({ slots, entries, now }) {
    const covered = coverage(slots, entries);
    let best = null;
    (slots || []).forEach((s) => {
      const at = parseTime(s.time);
      if (at === null || covered[slotKey(s)]) return;
      const gap = Math.abs(at - now.min);
      if (gap <= 120 && (!best || gap < best.gap)) best = { gap, type: s.meal_type };
    });
    return best ? best.type : "snack";
  }

  // A schedule the user can start from. Plain data, never applied automatically.
  function presetSlots() { return DEFAULT_SCHEDULE.map((s) => ({ ...s })); }

  // Persistence for the local answers; every access is guarded (private windows and blocked storage throw).
  const STORE_KEY = "csReminderState";
  function loadLocal(storage, day) {
    try {
      const raw = JSON.parse(storage.getItem(STORE_KEY) || "null");
      if (raw && raw.day === day && Array.isArray(raw.skipped) && raw.snoozed && typeof raw.snoozed === "object") return raw;
    } catch (e) { /* unreadable or blocked: start empty */ }
    return emptyLocal(day);
  }
  function saveLocal(storage, local) {
    try { storage.setItem(STORE_KEY, JSON.stringify(local)); } catch (e) { /* the answer just won't survive a reload */ }
  }

  const api = {
    GRACE_MIN, ASK_WINDOW_MIN, SNOOZE_MIN, MEAL_TYPES, MAX_SLOTS, LEAD_CHOICES, STORE_KEY,
    parseTime, formatTime, clockFrom, clockNow, slotKey, coverage, emptyLocal, snooze, skip,
    evaluate, suggestMealType, presetSlots, loadLocal, saveLocal,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CSSchedule = api;
})(typeof window !== "undefined" ? window : globalThis);
