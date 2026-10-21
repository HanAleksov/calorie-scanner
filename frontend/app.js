const state = {
  entryBeingEdited: null, units: "metric", pendingPinUserId: null, pendingPhotos: [],
  goalType: null, lastAdaptiveTdee: null,
  sessionUserId: null,                          // who this page was signed in as (to spot a profile change)
  canon: { heightCm: null, weightKg: null },    // canonical METRIC values behind the Plan form
  today: null,                                  // last /api/today payload (to re-render targets without a refetch)
  userName: "",                                 // for the avatar initial
  firstTodayRender: true,                       // no count-up / entry animation on the very first paint
  seenEntryIds: new Set(),                      // entries already on screen (only NEW ones animate in)
  legionIdle: "idle",                           // which idle line fits the real totals
  legionVars: null,                             // {meal, time} for the "next report" line
  clock: null,                                  // the app's own clock: CSSchedule.clockFrom(/api/today `now`)
  schedule: { slots: [], reminders: { enabled: false, lead_min: 15 } },   // the user's chosen eating schedule
  scheduleDraft: null,                          // what the schedule dialog is editing (nothing is saved until Save)
  reminderLocal: null,                          // today's "later" / "skip" answers (kept in localStorage, never sent)
  reminderShown: null,                          // which reminder the centurion is reacting to right now
  addContext: null,                             // {mealType}: the reminder that opened the Add-food panel
  editInitialTime: "",                          // the eaten time the editor opened with (only a change is sent)
  historyDays: [], historyGoal: null, historySelected: null,
};

const $ = (id) => document.getElementById(id);

// Inline SVG icons reused across dynamically-rendered templates below (entries, favorites,
// meal plan, user list) — kept as raw markup strings since template literals can't reference
// <svg> elements directly. Static markup in index.html has its own copies inline.
const ICON = {
  lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>',
  edit: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"></path></svg>',
  star: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>',
  starLg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>',
  zap: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
  note: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line></svg>',
  x: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  sunrise: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 18a5 5 0 0 0-10 0"></path><line x1="12" y1="2" x2="12" y2="9"></line><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"></line><line x1="1" y1="18" x2="3" y2="18"></line><line x1="21" y1="18" x2="23" y2="18"></line><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"></line><line x1="23" y1="22" x2="1" y2="22"></line><polyline points="8 6 12 2 16 6"></polyline></svg>',
  sun: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>',
  moon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>',
  package: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 9.4L7.5 4.21"></path><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>',
  chevLeft: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>',
  chev: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>',
  clock: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
  plate: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3"></circle></svg>',
};

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// All network access goes through api.js. `apiFetch` keeps the old Response-style shape for read calls;
// every write goes through `write()` below (single-flight, checks the outcome, never retries by itself).
const api = CSApi.createApi({ onUnauthorized: () => handleUnauthorized() });
const guard = CSApi.createGuard();
function apiFetch(url, options = {}) {
  return api.raw(url, options);
}

const FIELD_LABEL_KEY = {
  height_cm: "height_cm", weight_kg: "weight_kg", age: "age", calories: "calories", protein_g: "protein_g",
  carbs_g: "carbs_g", fat_g: "fat_g", total_calories: "calories", water_ml: "field_water_ml", ml: "field_ml",
  description: "description", name: "your_name", fat_mass_kg: "fat_mass_kg_label",
  muscle_mass_kg: "muscle_mass_kg_label", water_pct: "water_pct_label", eaten_time: "field_eaten_time",
};
function fieldLabel(field) {
  if (/^items\[\d+\]/.test(field)) return t("field_grams");
  if (/^slots\[\d+\]\.time$/.test(field)) return t("field_time");
  if (/^slots\[\d+\]\.meal_type$/.test(field)) return t("schedule_row_meal");
  return FIELD_LABEL_KEY[field] ? t(FIELD_LABEL_KEY[field]) : field;
}
function failureMessage(result) {
  return CSApi.describeError(result, t, fieldLabel);
}
function numOrNull(id) {
  const v = $(id).value.trim();
  return v === "" ? null : Number(v);
}

// One write, no guard of its own: disables the button while it runs, shows why on failure and returns the
// api result. Callers that already hold a guard (a read-then-write handler) call this directly.
async function sendWrite(btn, method, path, body, { form, quiet } = {}) {
  const wasDisabled = btn ? btn.disabled : false;
  if (btn) btn.disabled = true;
  try {
    const result = await api.request(path, { method, json: body === null ? undefined : body, form, quiet });
    if (!result.ok && !quiet) toast(failureMessage(result));
    return result;
  } finally {
    if (btn) btn.disabled = wasDisabled;
  }
}

// Runs one write behind a single-flight guard (keyed by `key`, else the button, else method+path) and
// checks the outcome. Returns the api result, or undefined if an identical write is already in flight.
// On failure it shows why and returns the failed result; callers leave their sheet open and their fields
// untouched, so nothing the user typed is lost. Nothing is ever retried automatically.
function write(btn, method, path, body, opts = {}) {
  return guard(opts.key || btn || `${method} ${path}`, () => sendWrite(btn, method, path, body, opts));
}
// Every change to the targets (apply, apply a suggestion, save) shares this key, so two of them can never
// interleave — a suggestion is a delta on the CURRENT targets and must not be read twice before being written.
const GOALS_WRITE = "goals-write";
const wrote = (result) => !!(result && result.ok);

// ---------- Appearance: theme (light/dark/system) and style (Normal / Roman Legion) are independent ----------
const THEME_COLOR = {
  "normal-light": "#FBF6EF", "normal-dark": "#111214", "roman-light": "#EFE3CF", "roman-dark": "#170B0C",
};
const reduceMotionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
const reduceMotion = () => !!reduceMotionQuery.matches;

function refreshAppearanceControls() {
  if (typeof look === "undefined") return;
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === look.theme)));
  document.querySelectorAll("[data-mode-choice]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.modeChoice === look.mode)));
  const meta = $("themeColorMeta");
  if (meta) meta.setAttribute("content", THEME_COLOR[`${look.mode}-${look.effectiveTheme()}`]);
}
document.querySelectorAll("[data-theme-choice]").forEach((b) => b.addEventListener("click", () => look.setTheme(b.dataset.themeChoice)));
document.querySelectorAll("[data-mode-choice]").forEach((b) => b.addEventListener("click", () => look.setMode(b.dataset.modeChoice)));

// ---------- Language ----------
function refreshLangBtn() {
  const label = currentLang() === "bg" ? "BG" : "EN";
  $("langValue").textContent = label;
  $("langBtnGate").textContent = label;
}
function toggleLanguage() {
  localStorage.setItem("lang", currentLang() === "bg" ? "en" : "bg");
  applyStaticTranslations();
  refreshLangBtn();
  updateScreenHeader();
  legion.reset();
  previewLegion.reset();
  state.reminderShown = null;
  renderScheduleViews();
  refreshGate();
  if (!$("appRoot").classList.contains("hidden")) {
    loadToday();
    if (document.getElementById("tab-history").classList.contains("active")) loadHistory();
    if (document.getElementById("tab-plan").classList.contains("active")) loadPlanTab();
  } else {
    renderUserList();
  }
}
$("langBtn").addEventListener("click", toggleLanguage);
$("langBtnGate").addEventListener("click", toggleLanguage);
applyStaticTranslations();
refreshLangBtn();

// ---------- Tabs ----------
function switchTab(name) {
  const changed = document.body.dataset.tab !== name;
  document.body.dataset.tab = name;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
    if (b.dataset.tab === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  updateScreenHeader();
  if (changed && typeof window.scrollTo === "function") window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
  if (name === "history") loadHistory();
  if (name === "plan") loadPlanTab();
}
const TAB_TITLE_KEY = { today: "tab_today", history: "tab_history", plan: "tab_plan" };
function activeTab() { return document.body.dataset.tab || "today"; }
function updateScreenHeader() {
  const tab = activeTab();
  $("screenTitle").textContent = t(TAB_TITLE_KEY[tab]);
  const sub = $("screenSub");
  if (tab === "today") {
    const day = state.today && state.today.date ? new Date(state.today.date + "T00:00:00") : new Date();
    sub.textContent = day.toLocaleDateString(currentLang() === "bg" ? "bg-BG" : undefined, { day: "numeric", month: "long" });
  } else {
    sub.textContent = t(tab === "history" ? "sub_history" : "sub_plan");
  }
  const initial = (state.userName || "").trim().charAt(0).toUpperCase();
  $("avatarInitial").textContent = initial || "•";
}
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ---------- iOS install hint ----------
(function iosHint() {
  const isIos = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
  const isStandalone = window.navigator.standalone === true;
  const dismissed = localStorage.getItem("iosHintDismissed");
  if (isIos && !isStandalone && !dismissed) {
    $("iosHint").style.display = "flex";
  }
  $("iosHintClose").addEventListener("click", () => {
    $("iosHint").style.display = "none";
    localStorage.setItem("iosHintDismissed", "1");
  });
})();

// ---------- Android install prompt ----------
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $("installBtn").style.display = "inline-flex";
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("installBtn").style.display = "none";
});

// ================== USER GATE & SESSION ==================
// "Who is signed in" is decided by the server from an HttpOnly session cookie. The numeric id on a
// profile button only picks which profile to sign in to; it proves nothing and is never stored here.

async function initUserGate() {
  localStorage.removeItem("userId");   // the old claimed-id login: ignored from now on
  let res = null;
  try { res = await api.raw("/api/session", { quiet: true }); } catch (e) { /* offline: show the gate */ }
  if (res && res.ok) {
    const data = await res.json();
    api.setCsrf(data.csrf_token);
    state.sessionUserId = data.user.id;
    showApp();
    return;
  }
  await showGate();
}

async function showGate(notice) {
  $("appRoot").classList.add("hidden");   // hidden, not cleared: unsaved input survives a session expiry
  $("userGate").classList.remove("hidden");
  $("newPersonForm").classList.add("hidden");
  $("pinForm").classList.add("hidden");
  const note = $("gateNotice");
  note.textContent = notice || "";
  note.classList.toggle("hidden", !notice);
  applyStaticTranslations();
  refreshGate();
  await renderUserList();
}

// In Roman style the sign-in screen shows the centurion and speaks to the legionary; otherwise it is the plain screen.
function refreshGate() {
  const roman = isRoman();
  if (roman) setPortraitMood($("gatePortrait"), "idle");
  const title = document.querySelector("#userGate h1");
  if (title) title.textContent = t(roman ? "gate_title_roman" : "who_is_this");
}

// The server said 401 (session ended / replaced). Show the sign-in screen over the app without throwing
// anything away; signing back in as the SAME profile resumes where the user was, signing in as a
// DIFFERENT one reloads the page so none of the previous profile's data, photos or drafts remain.
function handleUnauthorized() {
  api.setCsrf(null);
  showGate(t("session_expired_notice"));
}

async function renderUserList() {
  const res = await fetch("/api/users");
  const users = await res.json();
  const list = $("userList");
  list.innerHTML = users
    .map(
      (u) => `<button class="pick-user-btn" type="button" data-id="${u.id}" data-haspin="${u.has_pin}">
        <span class="pu-avatar" aria-hidden="true">${escapeHtml((u.name || "").trim().charAt(0).toUpperCase() || "•")}</span>
        <span class="pu-name">${escapeHtml(u.name)}</span>${u.has_pin ? `<span class="pin-lock" title="PIN">${ICON.lock}</span>` : `<span class="pu-go" aria-hidden="true">${ICON.chev}</span>`}
      </button>`
    )
    .join("");
  list.querySelectorAll(".pick-user-btn").forEach((btn) =>
    btn.addEventListener("click", () => selectUser(Number(btn.dataset.id), btn.dataset.haspin === "1", btn.querySelector(".pu-name").textContent))
  );
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function selectUser(id, hasPin, name) {
  if (!hasPin) {
    signIn(id);   // a profile without a PIN opens on an explicit tap, no password
    return;
  }
  state.pendingPinUserId = id;
  $("pinForLabel").textContent = t("pin_for", { name });
  $("pinInput").value = "";
  $("newPersonForm").classList.add("hidden");
  $("pinForm").classList.remove("hidden");
  $("pinInput").focus();
}

async function signIn(userId, pin) {
  const result = await guard("sign-in", () =>
    api.request("/api/session", { method: "POST", json: pin ? { user_id: userId, pin } : { user_id: userId } }));
  if (!result) return false;
  if (!result.ok) {
    const e = result.error || {};
    toast(e.code === "wrong_pin" ? t("err_pin_attempts_left", { n: e.attempts_left }) : failureMessage(result));
    $("pinInput").value = "";
    return false;
  }
  api.setCsrf(result.data.csrf_token);
  if (state.sessionUserId !== null && state.sessionUserId !== result.data.user.id) {
    location.reload();   // a different profile: start from a clean page
    return true;
  }
  state.sessionUserId = result.data.user.id;
  showApp();
  return true;
}

$("newPersonBtn").addEventListener("click", () => {
  $("pinForm").classList.add("hidden");
  $("newPersonForm").classList.toggle("hidden");
});

$("pinBackBtn").addEventListener("click", () => {
  $("pinForm").classList.add("hidden");
  state.pendingPinUserId = null;
});

$("pinUnlockBtn").addEventListener("click", () => {
  signIn(state.pendingPinUserId, $("pinInput").value.trim());
});

$("createUserBtn").addEventListener("click", async () => {
  const name = $("newUserName").value.trim();
  if (!name) {
    toast(t("name_required"));
    return;
  }
  const pin = $("newUserPin").value.trim();
  if (pin && !/^\d{4}$/.test(pin)) {
    toast(t("pin_must_be_4_digits"));
    return;
  }
  const created = await write($("createUserBtn"), "POST", "/api/users", { name, pin: pin || null });
  if (!wrote(created)) return;
  await signIn(created.data.id, pin || undefined);
});

function showApp() {
  $("userGate").classList.add("hidden");
  $("appRoot").classList.remove("hidden");
  applyStaticTranslations();
  refreshLangBtn();
  switchTab(activeTab());
  loadMe();
  loadToday();
  maybeShowWelcome();
  maybeShowWhatsNew();
}

async function loadMe() {
  try {
    const res = await apiFetch("/api/users/me");
    if (!res.ok) return;
    state.userName = (await res.json()).name || "";
    updateScreenHeader();
  } catch (e) { /* the avatar just keeps its placeholder */ }
}

$("switchUserBtn").addEventListener("click", async () => {
  if (!confirm(t("switch_user_confirm"))) return;
  const result = await write($("switchUserBtn"), "DELETE", "/api/session");
  if (!wrote(result)) return;   // still signed in; the reason was shown
  location.reload();            // fresh page: nothing of the previous profile survives in memory or on screen
});

// ---------- Welcome modal ----------
function maybeShowWelcome() {
  if (localStorage.getItem("welcomeSeen")) return;
  $("welcomeBody").textContent = t("welcome_body");
  $("welcomeModal").classList.remove("hidden");
}
$("welcomeDismissBtn").addEventListener("click", () => {
  localStorage.setItem("welcomeSeen", "1");
  $("welcomeModal").classList.add("hidden");
});

// ---------- What's New ----------
function maybeShowWhatsNew() {
  const seenVersion = Number(localStorage.getItem("whatsNewSeenVersion") || 0);
  if (!localStorage.getItem("welcomeSeen")) {
    // brand new device — nothing to announce, they're starting on the latest version already
    localStorage.setItem("whatsNewSeenVersion", CURRENT_APP_VERSION);
    return;
  }
  if (seenVersion < CURRENT_APP_VERSION) openWhatsNew();
}

function renderWhatsNewContent() {
  const lang = currentLang();
  $("whatsNewContent").innerHTML = WHATS_NEW
    .map((entry) => `<div class="whats-new-version"><ul>${entry[lang].map((line) => `<li>${line}</li>`).join("")}</ul></div>`)
    .join("");
}

function openWhatsNew() {
  renderWhatsNewContent();
  $("whatsNewModal").classList.remove("hidden");
}
$("whatsNewBtn").addEventListener("click", () => openFromSettings("whatsNewModal", openWhatsNew));
$("whatsNewCloseBtn").addEventListener("click", () => {
  localStorage.setItem("whatsNewSeenVersion", CURRENT_APP_VERSION);
  $("whatsNewModal").classList.add("hidden");
});

// ---------- Settings modal ----------
$("settingsBtn").addEventListener("click", openSettings);
$("settingsCloseBtn").addEventListener("click", () => $("settingsModal").classList.add("hidden"));

async function openSettings() {
  const [meRes, goalsRes] = await Promise.all([apiFetch("/api/users/me"), apiFetch("/api/goals")]);
  const me = await meRes.json();
  const goals = await goalsRes.json();
  $("settingsName").value = me.name;
  state.userName = me.name;
  updateScreenHeader();
  $("settingsOldPinField").classList.toggle("hidden", !me.has_pin);
  $("settingsOldPin").value = "";
  $("settingsNewPin").value = "";
  $("autoApplyToggle").checked = !goals || goals.auto_apply_targets !== 0;
  renderScheduleViews();
  $("settingsModal").classList.remove("hidden");
}

$("autoApplyToggle").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  const result = await write(e.target, "PUT", "/api/settings/auto-apply-targets", { enabled });
  if (!wrote(result)) {
    e.target.checked = !enabled;
    return;
  }
  toast(enabled ? t("auto_apply_enabled_toast") : t("auto_apply_disabled_toast"));
});

$("settingsSaveNameBtn").addEventListener("click", async () => {
  const name = $("settingsName").value.trim();
  if (!name) {
    toast(t("name_required"));
    return;
  }
  const result = await write($("settingsSaveNameBtn"), "PUT", "/api/users/me", { name });
  if (wrote(result)) {
    state.userName = name;
    updateScreenHeader();
    toast(t("name_updated"));
  }
});

$("settingsSavePinBtn").addEventListener("click", async () => {
  const oldPin = $("settingsOldPin").value.trim();
  const newPin = $("settingsNewPin").value.trim();
  if (newPin && !/^\d{4}$/.test(newPin)) {
    toast(t("pin_must_be_4_digits"));
    return;
  }
  const result = await write($("settingsSavePinBtn"), "PUT", "/api/users/me/pin",
    { old_pin: oldPin || null, new_pin: newPin || null }, { quiet: true });
  if (!result) return;
  if (!result.ok) {
    if (result.status === 400 && !oldPin) toast(t("needs_old_pin"));
    else if (result.status === 403 && result.error.code !== "csrf") toast(t("wrong_old_pin"));
    else toast(failureMessage(result));
    return;
  }
  toast(result.data.has_pin ? t("pin_updated") : t("pin_removed"));
  $("settingsOldPinField").classList.toggle("hidden", !result.data.has_pin);
  $("settingsOldPin").value = "";
  $("settingsNewPin").value = "";
});

$("resetTodayBtn").addEventListener("click", async () => {
  if (!confirm(t("reset_today_confirm"))) return;
  const result = await write($("resetTodayBtn"), "DELETE", "/api/today");
  if (!wrote(result)) return;
  toast(t("today_reset"));
  $("settingsModal").classList.add("hidden");
  loadToday();
});

$("deleteProfileBtn").addEventListener("click", async () => {
  if (!confirm(t("delete_profile_confirm"))) return;
  const result = await write($("deleteProfileBtn"), "DELETE", "/api/users/me");
  if (!wrote(result)) return;
  location.reload();   // the profile and its session are gone; reload lands on the sign-in screen
});

// ================== TODAY ==================
const UNDER_TARGET_THRESHOLD = 0.85; // gain users: flag calories/macros as "needs attention" only below 85% of goal

async function loadToday() {
  const [res, profileRes] = await Promise.all([apiFetch("/api/today"), apiFetch("/api/profile")]);
  if (!res.ok) return;
  const data = await res.json();
  state.today = data;
  state.clock = CSSchedule.clockFrom(data.now, Date.now());
  if (data.schedule) state.schedule = data.schedule;
  if (profileRes.ok) {
    const profile = await profileRes.json();
    state.goalType = profile && profile.goal_type;
  }
  renderTotals(data.totals, data.goals);
  renderEntries(data.entries);
  renderWater(data.water_ml, data.goals.water_ml);
  renderGapRecommender(data.totals.calories, data.goals.calories);
  renderDayMark(data);
  $("diaryCount").textContent = data.entries.length === 1 ? t("entries_one") : t("entries_many", { n: data.entries.length });
  updateScreenHeader();
  renderScheduleViews();
  refreshIdleLine(state.nextMeal);
  state.firstTodayRender = false;
  loadCachedTip();
  reminderTick();
}

// The calm line under the centurion comes from today's real totals; with a planned meal still ahead it names that meal.
function refreshIdleLine(next) {
  const d = state.today;
  if (!d) return;
  state.nextMeal = next || null;
  state.legionVars = next ? { meal: mealWord(next.slot.meal_type).toLowerCase(), time: next.slot.time } : null;
  state.legionIdle = CSLegion.idleKind({
    entries: d.entries.length, calories: d.totals.calories, goal: d.goals.calories, goalType: state.goalType, next: state.legionVars,
  });
  // redraw only when the line itself changed (the tick runs every few seconds; the bubble animates on every redraw)
  const sig = `${state.legionIdle}|${JSON.stringify(state.legionVars)}|${currentLang()}|${isRoman()}`;
  if (sig !== state.idleSig) {
    state.idleSig = sig;
    if (!legion.current) renderLegion(null);
  }
}

// ---------- Day completeness ----------
// The analyst only counts a day toward intake averages when it's a full record: 3+ distinct
// meal types, or the user explicitly confirmed it. A day with one snack is *unknown*, not
// "ate 700 kcal" — this row is how the user tells the app "that was everything".
async function setDayMark(day, status) {
  const result = await write(null, "PUT", `/api/days/${day}/mark`, { status });
  return wrote(result);
}

function renderDayMark(data) {
  const row = $("dayMarkRow");
  if (!data.entries.length) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  if (data.day_mark === "complete") {
    row.innerHTML = `<div class="day-mark-state"><button id="dayMarkUndoBtn">✓ ${t("day_mark_confirmed")}</button></div>`;
    $("dayMarkUndoBtn").addEventListener("click", async () => {
      if (await setDayMark(data.date, null)) loadToday();
    });
  } else if (data.day_status === "complete") {
    row.innerHTML = `<div class="day-mark-state">✓ ${t("day_mark_inferred")}</div>`;
  } else {
    row.innerHTML = `
      <p class="day-mark-hint">${t("day_mark_hint_partial")}</p>
      <button class="btn btn-secondary" id="dayMarkBtn" style="width:100%">${t("day_mark_btn")}</button>`;
    $("dayMarkBtn").addEventListener("click", async () => {
      if (await setDayMark(data.date, "complete")) loadToday();
    });
  }
}

// ---------- Target Gap Recommender (evening, gain-goal only) ----------
// Calorie-dense, minimal-volume options for closing a big gap late in the day — hardgainer
// framing only. Gated to goal_type "gain": telling a "lose"/"maintain" user to eat 600+ kcal
// because they're "under target" would actively undermine their goal (see CLAUDE.md's
// goal-aware visual language rule — this is the same principle applied to a recommendation,
// not just styling).
const GAP_RECOMMENDER_MIN_HOUR = 18;
const GAP_RECOMMENDER_MIN_REMAINING_KCAL = 400;
const GAP_MEAL_OPTIONS = [
  { key: "gap_meal_liquid_bulk", kcal: 620, protein_g: 42 },
  { key: "gap_meal_yogurt_bowl", kcal: 650, protein_g: 30 },
  { key: "gap_meal_pb_toast", kcal: 550, protein_g: 18 },
];

function renderGapRecommender(loggedCalories, dailyGoal) {
  const card = $("gapRecommenderCard");
  const remaining = dailyGoal - loggedCalories;
  const hour = new Date().getHours();
  const isGainGoal = state.goalType === "gain";

  if (!isGainGoal || hour < GAP_RECOMMENDER_MIN_HOUR || remaining < GAP_RECOMMENDER_MIN_REMAINING_KCAL) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("gapRecommenderExplain").textContent = t("gap_recommender_explain", { remaining: Math.round(remaining) });
  $("gapRecommenderList").innerHTML = GAP_MEAL_OPTIONS.map(
    (opt) => `
      <div class="gap-meal-option">
        <div class="gap-meal-name">${t(opt.key)}</div>
        <div class="gap-meal-macros">${opt.kcal} kcal · ${opt.protein_g}g ${t("protein")}</div>
      </div>`
  ).join("");
}

function applyGoalAwareClass(el, value, goal) {
  el.classList.remove("over", "over-good", "under-warning");
  const isGainGoal = state.goalType === "gain";
  if (value > goal) {
    el.classList.add(isGainGoal ? "over-good" : "over");
  } else if (isGainGoal && goal && value < goal * UNDER_TARGET_THRESHOLD) {
    el.classList.add("under-warning");
  }
}

// A number that changes after a save counts up to its new value (instant with reduced motion / first paint).
// Every call starts a new "run" for that element; frames of an older run see they are stale and stop, so a late
// frame can never overwrite the value a newer call has already set.
const counterRuns = new Map();
function setCounter(el, to, animate) {
  const run = (counterRuns.get(el) || 0) + 1;
  counterRuns.set(el, run);
  const shown = Number(el.textContent);
  const from = Number.isFinite(shown) && el.textContent !== "" ? shown : Number(el.dataset.v);
  el.dataset.v = String(to);
  if (!animate || reduceMotion() || !Number.isFinite(from) || from === to || typeof requestAnimationFrame !== "function") {
    el.textContent = to;
    return;
  }
  const start = performance.now();
  const ms = 700;
  const tick = (now) => {
    if (counterRuns.get(el) !== run) return;                 // a newer call took over
    const k = Math.min(1, (now - start) / ms);
    el.textContent = k >= 1 ? to : Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  el.classList.remove("pulse");
  void el.offsetWidth;
  el.classList.add("pulse");
}

function renderTotals(totals, goals) {
  const remaining = Math.max(0, goals.calories - totals.calories);
  const pct = goals.calories ? Math.min(1, totals.calories / goals.calories) : 0;
  const animate = !state.firstTodayRender;

  setCounter($("ringCalsLeft"), remaining, animate);
  $("totalCals").textContent = totals.calories;
  $("calGoalDisplay").textContent = goals.calories;

  const fill = $("calBarFill");
  fill.style.width = Math.round(pct * 100) + "%";
  applyGoalAwareClass(fill, totals.calories, goals.calories);
  const bar = $("calBar");
  bar.setAttribute("aria-valuenow", String(Math.round(pct * 100)));
  bar.setAttribute("aria-valuetext", t("kcal_progress_text", { eaten: totals.calories, goal: goals.calories }));

  setMacro("protein", totals.protein_g, goals.protein_g);
  setMacro("carbs", totals.carbs_g, goals.carbs_g);
  setMacro("fat", totals.fat_g, goals.fat_g);
  renderEnergy(totals.energy_avg);
}

function renderEnergy(avg) {
  const dots = document.querySelectorAll("#energyDots .energy-dot");
  const filled = avg == null ? 0 : Math.round(avg);
  dots.forEach((dot, i) => dot.classList.toggle("filled", i < filled));
  $("energyVal").textContent = avg == null ? t("energy_no_data_short") : `${avg}/5`;
  const hint = $("energyHint");
  hint.hidden = avg != null;
  hint.textContent = avg == null ? t("energy_no_data") : "";
}

// ---------- Water ----------
function litres(ml) {
  return (ml / 1000).toLocaleString(currentLang() === "bg" ? "bg-BG" : "en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function renderWater(ml, goalMl) {
  $("waterVal").textContent = `${litres(ml)} / ${litres(goalMl)} ${t("litre_unit")}`;
  const pct = goalMl ? Math.min(100, Math.round((ml / goalMl) * 100)) : 0;
  $("waterFill").style.width = pct + "%";
  $("waterBar").setAttribute("aria-valuenow", String(pct));
  $("waterBar").setAttribute("aria-valuetext", `${litres(ml)} / ${litres(goalMl)} ${t("litre_unit")}`);
}

async function addWater(ml) {
  const result = await write(null, "POST", "/api/water", { ml });
  if (wrote(result)) loadToday();
}
$("waterMoreBtn").addEventListener("click", () => {
  const open = $("waterMoreBtn").getAttribute("aria-expanded") !== "true";
  $("waterMoreBtn").setAttribute("aria-expanded", String(open));
  $("waterMore").hidden = !open;
});
$("removeWater250").addEventListener("click", () => addWater(-250));
$("addWater250").addEventListener("click", () => addWater(250));
$("addWater500").addEventListener("click", () => addWater(500));

// ---------- Coach tip ----------
function renderTip(tipText) {
  $("tipContent").innerHTML = `
    <div class="tip-text">${escapeHtml(tipText)}</div>
    <div class="tip-meta"><button id="refreshTipBtn">${t("refresh_tip_btn")}</button></div>
  `;
  $("refreshTipBtn").addEventListener("click", generateTip);
}

async function loadCachedTip() {
  const res = await apiFetch("/api/coach-tip");
  if (!res.ok) return;
  const data = await res.json();
  if (data.tip) renderTip(data.tip);
}

async function generateTip() {
  const container = $("tipContent");
  container.innerHTML = `<div class="tip-text"><span class="spinner dark"></span> ${t("generating_tip")}</div>`;
  try {
    const result = await guard("coach-tip", () => api.request(`/api/coach-tip?lang=${currentLang()}`, { method: "POST" }));
    if (!result) return;
    if (!result.ok) throw new Error(t("could_not_get_tip"));
    renderTip(result.data.tip);
    $("tipCard").open = true;
  } catch (err) {
    container.innerHTML = `<button class="btn btn-secondary" id="getTipBtn" style="width:100%">${t("get_tip_btn")}</button>`;
    $("getTipBtn").addEventListener("click", generateTip);
    toast(err.message);
  }
}
$("getTipBtn").addEventListener("click", generateTip);

function setMacro(name, value, goal) {
  $(`${name}Val`).textContent = `${value} / ${goal} ${t("gram_unit")}`;
  const pct = goal ? Math.min(100, Math.round((value / goal) * 100)) : 0;
  const fill = $(`${name}Fill`);
  fill.style.width = pct + "%";
  applyGoalAwareClass(fill, value, goal);
  const bar = $(`${name}Bar`);
  bar.setAttribute("aria-valuenow", String(pct));
  bar.setAttribute("aria-valuetext", `${value} / ${goal} ${t("gram_unit")}`);
}

const MEAL_LABEL_KEY = { breakfast: "meal_breakfast", lunch: "meal_lunch", dinner: "meal_dinner", snack: "meal_snack" };

function entryTitle(e) {
  const names = e.items.map((i) => i.name).filter(Boolean).join(", ");
  return names || t(MEAL_LABEL_KEY[e.meal_type] || "meal_snack");
}

// Order on the Today list: when it was eaten (confirmed time) or, lacking one, when it was logged.
const mealClock = (e) => e.eaten_time || e.created_at.slice(11, 16);
const byMealTime = (a, b) => (mealClock(a) < mealClock(b) ? -1 : mealClock(a) > mealClock(b) ? 1 : a.id - b.id);

function renderEntries(entries) {
  const list = $("entriesList");
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state">${t("no_entries_line1")}<br>${t("no_entries_line2")}</div>`;
    state.seenEntryIds = new Set();
    return;
  }
  const animateNew = !state.firstTodayRender && !reduceMotion();
  const fresh = new Set(entries.filter((e) => !state.seenEntryIds.has(e.id)).map((e) => e.id));
  list.innerHTML = entries
    .slice()
    .sort(byMealTime)
    .map((e) => {
      const thumb = e.image_path
        ? `<img class="thumb" src="/uploads/${e.image_path}" alt="" loading="lazy">`
        : `<div class="thumb-placeholder">${ICON.plate}</div>`;
      const lowConf = e.confidence === "low" ? `<span class="badge low-confidence">${t("low_confidence")}</span>` : "";
      const energyBadge = e.energy_score != null ? `<span class="badge energy-badge">${ICON.zap}${e.energy_score}/5</span>` : "";
      // The time the user SAID they ate is shown as such; an entry without one only shows when it was logged
      // (old entries and entries added without a time: an upload time is not proof of when something was eaten).
      const timeHtml = e.eaten_time
        ? `<span class="entry-time confirmed">${ICON.clock}${t("eaten_at_row", { time: e.eaten_time })}</span>`
        : `<span class="entry-time">${t("logged_at_row", { time: e.created_at.slice(11, 16) })}</span>`;
      const noteLine = e.notes ? `<div class="entry-note">${ICON.note} ${escapeHtml(e.notes)}</div>` : "";
      const title = escapeHtml(entryTitle(e));
      return `
        <div class="entry${animateNew && fresh.has(e.id) ? " in" : ""}" data-id="${e.id}">
          ${thumb}
          <div class="entry-body">
            <div class="entry-title">${title}</div>
            <div class="entry-kcal">${e.total_calories} ${t("kcal_unit")}</div>
            <div class="entry-meta"><span class="badge">${t(MEAL_LABEL_KEY[e.meal_type] || "meal_snack")}</span>${timeHtml}<span>${t("protein_short")} ${e.protein_g} · ${t("carbs_short")} ${e.carbs_g} · ${t("fat_short")} ${e.fat_g}</span>${energyBadge}${lowConf}</div>
            ${noteLine}
          </div>
          <div class="entry-actions">
            <button class="edit-btn" type="button" aria-label="${t("edit")}: ${title}" title="${t("edit")}">${ICON.edit}</button>
          </div>
        </div>`;
    })
    .join("");
  state.seenEntryIds = new Set(entries.map((e) => e.id));

  list.querySelectorAll(".entry").forEach((row) =>
    row.addEventListener("click", () => openEdit(row.dataset.id))
  );
  list.querySelectorAll(".edit-btn").forEach((btn) =>
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); openEdit(ev.target.closest(".entry").dataset.id); })
  );
}

async function deleteEntry(id) {
  if (!confirm(t("delete_confirm"))) return;
  const result = await write(null, "DELETE", `/api/entries/${id}`);
  if (wrote(result)) loadToday();
}

// ---------- Favorites ----------
async function saveAsFavorite(entryId) {
  const result = await write(null, "POST", "/api/favorites", { entry_id: Number(entryId) });
  if (wrote(result)) toast(t("favorite_saved_toast"));
}

async function renderFavorites() {
  const res = await apiFetch("/api/favorites");
  if (!res.ok) return;
  const { favorites } = await res.json();
  const list = $("favoritesList");

  if (!favorites.length) {
    list.innerHTML = `<div class="empty-state">${t("no_favorites_line1")}<br>${t("no_favorites_line2")}</div>`;
    return;
  }

  list.innerHTML = favorites
    .map(
      (f) => `
      <div class="entry" data-id="${f.id}">
        <div class="thumb-placeholder">${ICON.starLg}</div>
        <div class="entry-body">
          <div class="entry-title">${escapeHtml(f.name)}</div>
          <div class="entry-kcal">${f.total_calories} ${t("kcal_unit")}</div>
          <div class="entry-meta"><span class="badge">${t(MEAL_LABEL_KEY[f.meal_type] || "meal_snack")}</span><span>${t("protein_short")} ${f.protein_g} · ${t("carbs_short")} ${f.carbs_g} · ${t("fat_short")} ${f.fat_g}</span></div>
        </div>
        <div class="entry-actions">
          <button class="log-favorite-btn btn btn-primary" type="button">${t("log_this_meal_btn")}</button>
          <button class="delete-favorite-btn" type="button" aria-label="${t("delete")}: ${escapeHtml(f.name)}" title="${t("delete")}">${ICON.trash}</button>
        </div>
      </div>`
    )
    .join("");

  list.querySelectorAll(".log-favorite-btn").forEach((btn) =>
    btn.addEventListener("click", (ev) => logFavorite(ev.target.closest(".entry").dataset.id))
  );
  list.querySelectorAll(".delete-favorite-btn").forEach((btn) =>
    btn.addEventListener("click", async (ev) => {
      if (!confirm(t("delete_favorite_confirm"))) return;
      const id = ev.target.closest(".entry").dataset.id;
      const result = await write(null, "DELETE", `/api/favorites/${id}`);
      if (wrote(result)) renderFavorites();
    })
  );
}

async function logFavorite(favoriteId) {
  const when = readWhen("fav");
  const result = await write(null, "POST", `/api/favorites/${favoriteId}/log`, { meal_type: when.meal_type, eaten_time: when.eaten_time || null });
  if (!wrote(result)) return;
  toast(t("logged_from_favorite_toast"));
  $("favoritesModal").classList.add("hidden");
  afterMealLogged();
  loadToday();
}

$("quickAddBtn").addEventListener("click", () => {
  seedWhen("fav");
  $("favoritesModal").classList.remove("hidden");
  renderFavorites();
});
$("favoritesCloseBtn").addEventListener("click", () => $("favoritesModal").classList.add("hidden"));

async function openEdit(id) {
  const res = await apiFetch(`/api/entries/${id}`);
  if (!res.ok) return;
  const e = await res.json();
  state.entryBeingEdited = id;
  $("editMealType").value = e.meal_type;
  state.editInitialTime = e.eaten_time || "";
  $("editMealTime").value = state.editInitialTime;
  $("editTimeNote").textContent = e.eaten_time
    ? t("edit_time_confirmed", { time: e.created_at.slice(11, 16), eaten: e.eaten_time })
    : t("edit_time_logged_only", { time: e.created_at.slice(11, 16) });
  $("editCals").value = e.total_calories;
  $("editProtein").value = e.protein_g;
  $("editCarbs").value = e.carbs_g;
  $("editFat").value = e.fat_g;

  const hasGrams = e.items.some((i) => i.est_grams != null);
  // No grams to correct (manual entry) -> the manual numbers ARE the primary edit path, show them open.
  $("editAdvancedDetails").open = !hasGrams;
  if (hasGrams) {
    $("editItemsList").innerHTML = e.items
      .map(
        (item, i) => `
        <div class="edit-item-row">
          <span class="item-name">${escapeHtml(item.name)}</span>
          <input type="number" class="edit-item-grams" data-idx="${i}" value="${item.est_grams ?? ""}" aria-label="${escapeHtml(item.name)} — ${t("field_grams")}">
        </div>`
      )
      .join("");
    $("editItemsSection").classList.remove("hidden");
  } else {
    $("editItemsSection").classList.add("hidden");
  }

  $("editModal").classList.remove("hidden");
}
$("editCancelBtn").addEventListener("click", () => $("editModal").classList.add("hidden"));
$("editFavoriteBtn").addEventListener("click", () => saveAsFavorite(state.entryBeingEdited));
$("editDeleteBtn").addEventListener("click", async () => {
  const id = state.entryBeingEdited;
  if (!confirm(t("delete_confirm"))) return;
  const result = await write($("editDeleteBtn"), "DELETE", `/api/entries/${id}`);
  if (!wrote(result)) return;   // the editor stays open
  $("editModal").classList.add("hidden");
  loadToday();
});

$("editSaveBtn").addEventListener("click", async () => {
  const id = state.entryBeingEdited;
  // ONE request: per-item grams (recalculate calories/macros from them) and the details together, so
  // either everything is saved or nothing is.
  const payload = { meal_type: $("editMealType").value };
  // The eaten time is sent only when the user changed it (an empty field clears it). Leaving it alone never
  // "confirms" the time of an old entry.
  const eatenNow = $("editMealTime").value.trim();
  if (eatenNow !== state.editInitialTime) payload.eaten_time = eatenNow || null;
  const gramsInputs = document.querySelectorAll(".edit-item-grams");
  if (gramsInputs.length) {
    payload.items = Array.from(gramsInputs)
      .sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx))
      .map((input) => ({ est_grams: input.value === "" ? null : Number(input.value) }));
  }
  // Advanced section open -> those manual numbers take precedence over the grams recalculation.
  if ($("editAdvancedDetails").open) {
    Object.assign(payload, {
      total_calories: numOrNull("editCals"),
      protein_g: numOrNull("editProtein"),
      carbs_g: numOrNull("editCarbs"),
      fat_g: numOrNull("editFat"),
    });
  }
  const result = await write($("editSaveBtn"), "PUT", `/api/entries/${id}`, payload);
  if (!wrote(result)) return;   // the sheet stays open with everything the user entered
  $("editModal").classList.add("hidden");
  loadToday();
});

// ---------- Photo capture (with optional second angle before analyzing) ----------
$("takePhotoBtn").addEventListener("click", () => $("photoInput").click());

$("photoInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  state.pendingPhotos = [file];
  openPhotoReview();
});

$("photoInput2").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  state.pendingPhotos.push(file);
  renderPhotoPreview();
});

$("addAngleBtn").addEventListener("click", () => $("photoInput2").click());

function renderPhotoPreview() {
  $("photoPreviewRow").innerHTML = state.pendingPhotos
    .map(
      (file, i) => `
      <div class="photo-preview-thumb">
        <img src="${URL.createObjectURL(file)}" alt="">
        <button data-idx="${i}" title="${t("remove_photo")}">${ICON.x}</button>
      </div>`
    )
    .join("");
  $("photoPreviewRow").querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.pendingPhotos.splice(Number(btn.dataset.idx), 1);
      if (state.pendingPhotos.length === 0) closePhotoReview();
      else renderPhotoPreview();
    })
  );
  $("addAngleBtn").classList.toggle("hidden", state.pendingPhotos.length >= 2);
}

function openPhotoReview() {
  seedWhen("photo");
  renderPhotoPreview();
  $("photoReviewModal").classList.remove("hidden");
}
function closePhotoReview() {
  $("photoReviewModal").classList.add("hidden");
  state.pendingPhotos = [];
  $("photoDescInput").value = "";
}
$("photoCancelBtn").addEventListener("click", closePhotoReview);

$("photoAnalyzeBtn").addEventListener("click", () => guard("photo-analyze", async () => {
  if (!state.pendingPhotos.length) return;
  const btn = $("photoAnalyzeBtn");
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span> ${t("analyzing")}`;
  btn.disabled = true;

  const formData = new FormData();
  formData.append("image", state.pendingPhotos[0]);
  if (state.pendingPhotos[1]) formData.append("image2", state.pendingPhotos[1]);
  const when = readWhen("photo");
  formData.append("meal_type", when.meal_type);
  if (when.eaten_time) formData.append("eaten_time", when.eaten_time);
  formData.append("lang", currentLang());
  const desc = $("photoDescInput").value.trim();
  if (desc) formData.append("description", desc);

  try {
    const result = await api.request("/api/log-meal", { method: "POST", form: formData });
    if (!result.ok) {
      toast(failureMessage(result));   // the review sheet stays open: photos and note are kept
      return;
    }
    toast(t("logged_kcal", { kcal: result.data.total_calories, confidence: result.data.confidence }));
    closePhotoReview();
    afterMealLogged();
    loadToday();
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}));

// ---------- Manual entry ----------
$("manualEntryBtn").addEventListener("click", () => {
  seedWhen("manual");
  $("manualModal").classList.remove("hidden");
});
$("manualCancelBtn").addEventListener("click", () => $("manualModal").classList.add("hidden"));
$("manualSaveBtn").addEventListener("click", async () => {
  const desc = $("manualDesc").value.trim();
  if (!desc || $("manualCals").value.trim() === "") {
    toast(t("fill_desc_cals"));
    return;
  }
  const formData = new FormData();
  const when = readWhen("manual");
  formData.append("meal_type", when.meal_type);
  if (when.eaten_time) formData.append("eaten_time", when.eaten_time);
  formData.append("description", desc);
  formData.append("total_calories", $("manualCals").value.trim());
  formData.append("protein_g", $("manualProtein").value.trim() || "0");
  formData.append("carbs_g", $("manualCarbs").value.trim() || "0");
  formData.append("fat_g", $("manualFat").value.trim() || "0");

  const result = await write($("manualSaveBtn"), "POST", "/api/log-manual", null, { form: formData });
  if (!wrote(result)) return;   // keep the sheet and the fields: a failed save must not eat the entry
  $("manualModal").classList.add("hidden");
  ["manualDesc", "manualCals", "manualProtein", "manualCarbs", "manualFat"].forEach((id) => ($(id).value = ""));
  afterMealLogged();
  loadToday();
});

// ================== PROGRESS ==================
const HISTORY_DAYS = 14;
const dateLocale = () => (currentLang() === "bg" ? "bg-BG" : undefined);
const shortDate = (dateStr) => new Date(dateStr + "T00:00:00").toLocaleDateString(dateLocale(), { month: "short", day: "numeric" });
const longDate = (dateStr) => new Date(dateStr + "T00:00:00").toLocaleDateString(dateLocale(), { weekday: "long", month: "long", day: "numeric" });

async function loadHistory() {
  const [res, goalsRes] = await Promise.all([apiFetch(`/api/history?days=${HISTORY_DAYS}`), apiFetch("/api/goals")]);
  if (!res.ok) return;
  const data = await res.json();
  state.historyDays = data.days;
  state.historyGoal = goalsRes.ok ? (await goalsRes.json()).calories : null;
  if (!state.historySelected || !data.days.some((d) => d.date === state.historySelected)) {
    const logged = data.days.filter((d) => d.status !== "empty");
    state.historySelected = (logged.length ? logged[logged.length - 1] : data.days[data.days.length - 1]).date;
  }
  renderHistory();
  loadWeightLog();
}

// What the analysis does with a day, in words (a day with nothing logged is unknown, not zero).
function dayStatusText(d) {
  if (d.status === "empty") return t("day_nothing");
  if (d.status === "skipped") return t("day_status_skipped_long");
  if (d.status === "partial") return t("day_state_partial");
  return d.mark === "complete" ? t("day_status_complete_marked") : t("day_status_complete_inferred");
}

// Last 14 days as one chart: a column per day (tap to see that day), a dashed line at the calorie target, days the
// analysis ignores drawn dim. The selected day is described underneath, with the same "count this day" control as before.
function renderHistory() {
  const days = state.historyDays;
  const goal = state.historyGoal;
  const top = Math.max(1, goal || 0, ...days.map((d) => d.totals.calories));
  const today = days.length ? days[days.length - 1].date : "";
  const cols = days.map((d) => {
    const pct = d.status === "empty" ? 0 : Math.max(3, Math.round((d.totals.calories / top) * 100));
    const cls = ["hc-col", d.status !== "complete" ? "is-unknown" : "", d.status === "empty" ? "is-empty" : "", d.date === today ? "is-today" : "",
      d.date === state.historySelected ? "is-selected" : ""].filter(Boolean).join(" ");
    const label = t("day_bar_label", { date: shortDate(d.date), kcal: d.status === "empty" ? "0" : d.totals.calories, status: dayStatusText(d) });
    return `<button type="button" class="${cls}" data-day="${d.date}" aria-pressed="${d.date === state.historySelected}" aria-label="${escapeHtml(label)}"><span class="hc-fill" style="height:${pct}%"></span></button>`;
  }).join("");
  const labels = days.map((d) => `<span class="hc-lab${d.date === state.historySelected ? " is-selected" : ""}">${Number(d.date.slice(8, 10))}</span>`).join("");
  const goalLine = goal ? `<div class="hc-goal" style="bottom:${Math.min(100, (goal / top) * 100)}%"></div>` : "";
  $("historyChart").innerHTML = `<div class="hc-area">${goalLine}<div class="hc-cols">${cols}</div></div><div class="hc-labels">${labels}</div>`;

  const full = days.filter((d) => d.status === "complete");
  $("historyLegend").innerHTML = goal ? `<i class="hc-swatch" aria-hidden="true"></i>${t("history_goal_line", { kcal: goal })}` : "";
  const avg = $("historyAvg");
  avg.textContent = full.length
    ? t("history_avg", { kcal: Math.round(full.reduce((n, d) => n + d.totals.calories, 0) / full.length), n: full.length, total: days.length })
    : t("history_avg_none");
  const hint = $("historyHint");
  hint.hidden = !days.some((d) => d.status === "partial");
  hint.textContent = hint.hidden ? "" : t("history_partial_hint");

  $("historyChart").querySelectorAll(".hc-col").forEach((btn) =>
    btn.addEventListener("click", () => selectHistoryDay(btn.dataset.day)));
  renderHistoryDay();
}

function selectHistoryDay(day) {
  if (!state.historyDays.some((d) => d.date === day)) return;
  state.historySelected = day;
  renderHistory();
}

function renderHistoryDay() {
  const days = state.historyDays;
  const i = days.findIndex((d) => d.date === state.historySelected);
  const box = $("historyDay");
  if (i < 0) { box.innerHTML = ""; return; }
  const d = days[i];
  const meals = d.entry_count === 1 ? t("day_meals_one") : t("day_meals_many", { n: d.entry_count });
  // Tap: partial -> counted (confirmed); confirmed/skipped -> back to inferred.
  let chip = "";
  if (d.status === "partial") {
    chip = `<button type="button" class="day-status-chip include" data-day="${d.date}" data-next="complete" title="${t("day_status_tap_hint")}">${t("day_status_include")}</button>`;
  } else if (d.status === "skipped") {
    chip = `<button type="button" class="day-status-chip" data-day="${d.date}" data-next="clear" title="${t("day_status_tap_hint")}">${t("day_status_skipped")}</button>`;
  } else if (d.status === "complete" && d.mark === "complete") {
    chip = `<button type="button" class="day-status-chip confirmed" data-day="${d.date}" data-next="clear" title="${t("day_status_tap_hint")}">${t("day_status_confirmed")}</button>`;
  }
  const macros = d.status === "empty" ? "" : `<div class="hd-macros">${t("protein_short")} ${d.totals.protein_g} · ${t("carbs_short")} ${d.totals.carbs_g} · ${t("fat_short")} ${d.totals.fat_g}</div>`;
  box.innerHTML = `
    <div class="hd-top">
      <button type="button" class="hd-step" data-step="-1" aria-label="${t("day_prev")}" ${i === 0 ? "disabled" : ""}>${ICON.chevLeft}</button>
      <div class="hd-head">
        <div class="hd-date">${longDate(d.date)}${i === days.length - 1 ? ` · ${t("day_today")}` : ""}</div>
        <div class="hd-kcal">${d.status === "empty" ? "—" : `${d.totals.calories} ${t("kcal_unit")}`}</div>
      </div>
      <button type="button" class="hd-step" data-step="1" aria-label="${t("day_next")}" ${i === days.length - 1 ? "disabled" : ""}>${ICON.chev}</button>
    </div>
    <div class="hd-meta">${meals} · ${dayStatusText(d)}</div>
    ${macros}
    ${chip ? `<div class="hd-action">${chip}</div>` : ""}`;
  box.querySelectorAll(".hd-step").forEach((btn) =>
    btn.addEventListener("click", () => {
      const next = days[i + Number(btn.dataset.step)];
      if (next) selectHistoryDay(next.date);
    }));
  box.querySelectorAll("button.day-status-chip").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const status = btn.dataset.next === "clear" ? null : btn.dataset.next;
      if (await setDayMark(btn.dataset.day, status)) loadHistory();
    }));
}

// ---------- Weight ----------
const parseLogged = (stamp) => new Date(stamp.replace(" ", "T"));
const round1 = (n) => Math.round(n * 10) / 10;

// Big current weight, how it moved (compared with ~2 weeks earlier, or the first weigh-in), and a small line of the
// recent weigh-ins. The colour of the change follows the goal (down is good only when losing, up only when gaining).
function renderWeightHero(entries, goalType) {
  const locale = dateLocale();
  const spark = $("weightSpark");
  if (!entries.length) {
    $("weightNow").textContent = "–";
    $("weightDelta").textContent = "";
    $("weightDelta").className = "wh-delta";
    spark.innerHTML = "";
    return;
  }
  const latest = entries[0];
  $("weightNow").textContent = latest.weight_kg.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const older = entries.slice(1);
  const latestAt = parseLogged(latest.logged_at).getTime();
  const base = older.find((e) => latestAt - parseLogged(e.logged_at).getTime() >= 10 * 86400000) || older[older.length - 1];
  const delta = $("weightDelta");
  if (!base) {
    delta.className = "wh-delta";
    delta.textContent = t("weight_first");
  } else {
    const diff = round1(latest.weight_kg - base.weight_kg);
    const date = parseLogged(base.logged_at).toLocaleDateString(locale, { month: "long", day: "numeric" });
    const good = (goalType === "lose" && diff < 0) || (goalType === "gain" && diff > 0);
    delta.className = `wh-delta ${diff === 0 ? "" : good ? "good" : "neutral"}`;
    delta.textContent = diff === 0 ? t("weight_delta_flat", { date })
      : t("weight_delta_since", { delta: `${diff > 0 ? "+" : "−"}${Math.abs(diff).toLocaleString(locale, { maximumFractionDigits: 1 })}`, date });
  }
  const points = entries.slice(0, 12).reverse().map((e) => e.weight_kg);
  if (points.length < 2) { spark.innerHTML = ""; return; }
  const lo = Math.min(...points), hi = Math.max(...points), W = 160, H = 56, pad = 7;
  const xy = points.map((v, i) => [pad + (i / (points.length - 1)) * (W - 2 * pad), hi === lo ? H / 2 : pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad)]);
  const last = xy[xy.length - 1];
  spark.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-hidden="true" focusable="false">
    <path d="${xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4.5" fill="currentColor"></circle></svg>`;
}

async function loadWeightLog() {
  const [weightRes, profileRes] = await Promise.all([
    apiFetch("/api/weight?limit=30"),
    apiFetch("/api/profile"),
  ]);
  if (!weightRes.ok) return;
  const { entries } = await weightRes.json();
  const profile = profileRes.ok ? await profileRes.json() : null;
  const goalType = profile && profile.goal_type;
  const list = $("weightLogList");

  if ($("weightLogInput") && entries.length && !$("weightLogInput").value) {
    $("weightLogInput").value = entries[0].weight_kg;
  }
  renderWeightHero(entries, goalType);

  if (!entries.length) {
    list.innerHTML = `<div class="empty-state">${t("no_weight_data")}</div>`;
    return;
  }

  const locale = dateLocale();
  list.innerHTML = entries
    .map((entry, i) => {
      const prev = entries[i + 1];
      let deltaHtml = "";
      if (prev) {
        const diff = round1(entry.weight_kg - prev.weight_kg);
        const sign = diff > 0 ? "+" : "";
        const wantsDown = goalType === "lose";
        const wantsUp = goalType === "gain";
        const isGood = (wantsDown && diff < 0) || (wantsUp && diff > 0);
        const cls = diff === 0 ? "neutral" : isGood ? "good" : "neutral";
        deltaHtml = `<span class="delta ${cls}">${sign}${diff} ${t("kg_unit")}</span>`;
      }
      const label = parseLogged(entry.logged_at).toLocaleDateString(locale, { month: "short", day: "numeric" });
      const compositionParts = [];
      if (entry.fat_mass_kg != null) compositionParts.push(`${t("fat_mass_kg_label")}: ${entry.fat_mass_kg}${t("kg_unit")}`);
      if (entry.muscle_mass_kg != null) compositionParts.push(`${t("muscle_mass_kg_label")}: ${entry.muscle_mass_kg}${t("kg_unit")}`);
      if (entry.water_pct != null) compositionParts.push(`${t("water_pct_label")}: ${entry.water_pct}%`);
      const compositionHtml = compositionParts.length
        ? `<div class="weight-row-composition">${compositionParts.join(" · ")}</div>`
        : "";
      return `
        <div class="weight-row" data-id="${entry.id}">
          <div class="weight-row-main">
            <div class="date">${label}</div>
            <div class="kg">${entry.weight_kg} ${t("kg_unit")}</div>
            ${deltaHtml}
            <button class="delete-weight-btn" type="button" aria-label="${t("delete")}: ${label}" title="${t("delete")}">${ICON.trash}</button>
          </div>
          ${compositionHtml}
        </div>`;
    })
    .join("");

  list.querySelectorAll(".delete-weight-btn").forEach((btn) =>
    btn.addEventListener("click", async (ev) => {
      const id = ev.target.closest(".weight-row").dataset.id;
      const result = await write(null, "DELETE", `/api/weight/${id}`);
      if (wrote(result)) loadWeightLog();
    })
  );
}

// The analyst may have changed the targets while saving a weigh-in. The response carries the current
// ones, so Today shows them straight away whether they changed or not (no stale ring until a refresh).
function applyWeighInGoals(data) {
  if (!data || !data.goals) return;
  if (state.today) {
    state.today.goals = data.goals;
    renderTotals(state.today.totals, data.goals);
    renderWater(state.today.water_ml, data.goals.water_ml);
    renderGapRecommender(state.today.totals.calories, data.goals.calories);
  } else {
    loadToday();
  }
  if (data.goals_changed) toast(t("goals_updated_after_weigh_in", { calories: data.goals.calories }));
}

$("logWeightBtn").addEventListener("click", async () => {
  const weightKg = numOrNull("weightLogInput");
  if (weightKg === null) {
    toast(t("enter_weight_first"));
    return;
  }
  const payload = { weight_kg: weightKg, lang: currentLang() };
  for (const [field, id] of [["fat_mass_kg", "scaleFatMass"], ["muscle_mass_kg", "scaleMuscleMass"], ["water_pct", "scaleWaterPct"]]) {
    const v = numOrNull(id);
    if (v !== null) payload[field] = v;
  }

  const result = await write($("logWeightBtn"), "POST", "/api/weight", payload);
  if (!wrote(result)) return;
  toast(t("weight_logged_toast"));
  ["scaleFatMass", "scaleMuscleMass", "scaleWaterPct"].forEach((id) => ($(id).value = ""));
  loadWeightLog();
  applyWeighInGoals(result.data);
});

// ---------- Scale screenshot scan ----------
$("scanScaleBtn").addEventListener("click", () => $("scaleScanInput").click());

$("scaleScanInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  const btn = $("scanScaleBtn");
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span> ${t("scale_scanning")}`;
  btn.disabled = true;
  $("scaleScanInfo").hidden = true;

  const formData = new FormData();
  formData.append("image", file);

  try {
    const result = await guard("scale-scan", () => api.request("/api/weight/scan", { method: "POST", form: formData }));
    if (!result) return;
    if (!result.ok) throw new Error(failureMessage(result));
    const data = result.data;
    $("weightLogInput").value = data.weight_kg;
    if (data.fat_mass_kg != null) $("scaleFatMass").value = data.fat_mass_kg;
    if (data.skeletal_muscle_kg != null) $("scaleMuscleMass").value = data.skeletal_muscle_kg;
    if (data.body_water_pct != null) $("scaleWaterPct").value = data.body_water_pct;
    if (data.fat_mass_kg != null || data.skeletal_muscle_kg != null || data.body_water_pct != null) {
      $("scaleCompositionDetails").open = true;
    }

    const extras = [];
    if (data.body_fat_pct != null) extras.push(`${t("scale_body_fat_pct_label")}: ${data.body_fat_pct}%`);
    if (data.bmr_kcal != null) extras.push(`${t("scale_bmr_kcal_label")}: ${data.bmr_kcal}`);
    if (data.protein_pct != null) extras.push(`${t("scale_protein_pct_label")}: ${data.protein_pct}%`);
    if (extras.length) {
      $("scaleScanInfo").textContent = extras.join(" · ");
      $("scaleScanInfo").hidden = false;
    }
    toast(t("scale_scan_success"));
  } catch (err) {
    toast(err.message || t("something_wrong"));
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
});

// ================== PLAN TAB ==================
// Metric is the only stored/sent unit. Imperial is a view: what the fields show is always derived from the
// canonical metric values in state.canon (units.js), which only change when the user types a new number.
function renderUnitFields() {
  const { heightCm, weightKg } = state.canon;
  if (state.units === "metric") {
    $("heightCm").value = heightCm ?? "";
    $("heightIn").value = "";
    $("weightKg").value = weightKg ?? "";
    return;
  }
  if (heightCm != null) {
    const { feet, inches } = CSUnits.cmToFeetInches(heightCm);
    $("heightCm").value = feet;
    $("heightIn").value = inches;
  } else {
    $("heightCm").value = "";
    $("heightIn").value = "";
  }
  $("weightKg").value = weightKg != null ? CSUnits.kgToLb(weightKg) : "";
}

// Only the canonical value behind the field the user just edited is replaced; the other one is left exactly
// as it was (re-deriving it from its rounded imperial display would nudge it: 80 kg shows as 176.4 lb, which
// is 80.01 kg when converted back).
function syncCanonFromField(edited) {
  state.canon = CSUnits.canonAfterEdit(state.canon, state.units, edited, {
    heightMain: numOrNull("heightCm"), heightIn: numOrNull("heightIn"), weight: numOrNull("weightKg"),
  });
}
[["heightCm", "height"], ["heightIn", "height"], ["weightKg", "weight"]].forEach(([id, edited]) =>
  $(id).addEventListener("input", () => syncCanonFromField(edited)));

document.querySelectorAll(".unit-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".unit-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.units = btn.dataset.units;
    const imperial = state.units === "imperial";
    document.querySelectorAll(".imperial-only").forEach((el) => (el.style.display = imperial ? "block" : "none"));
    $("heightLabel").textContent = imperial ? t("height_ft") : t("height_cm");
    $("weightLabel").textContent = imperial ? t("weight_lb") : t("weight_kg");
    renderUnitFields();
  });
});

function getHeightCm() {
  return state.canon.heightCm;
}
function getWeightKg() {
  return state.canon.weightKg;
}

function renderGoalsHero(g) {
  $("ghCalories").textContent = g.calories;
  $("ghProtein").textContent = `${g.protein_g} ${t("gram_unit")}`;
  $("ghCarbs").textContent = `${g.carbs_g} ${t("gram_unit")}`;
  $("ghFat").textContent = `${g.fat_g} ${t("gram_unit")}`;
  $("ghWater").textContent = `${litres(g.water_ml)} ${t("litre_unit")}`;
}

function renderGoalTag(goalType) {
  const tag = $("ghGoalType");
  tag.hidden = !goalType;
  tag.textContent = goalType ? t(`goal_tag_${goalType}`) : "";
}

async function loadSchedule() {
  const res = await apiFetch("/api/schedule");
  if (!res.ok) return;
  state.schedule = await res.json();
  renderScheduleViews();
}

async function loadPlanTab() {
  const res = await apiFetch("/api/profile");
  if (!res.ok) return;
  const p = await res.json();
  renderGoalTag(p.goal_type);
  if (!p.age || !p.height_cm || !p.weight_kg) $("profileFold").open = true;     // nothing to calculate from yet: show the form
  loadSchedule();
  state.canon.heightCm = p.height_cm || null;
  state.canon.weightKg = p.weight_kg || null;
  renderUnitFields();
  if (p.age) $("age").value = p.age;
  if (p.sex) $("sex").value = p.sex;
  if (p.activity_level) $("activityLevel").value = p.activity_level;
  if (p.goal_type) $("goalType").value = p.goal_type;
  if (p.dietary_notes) $("dietaryNotes").value = p.dietary_notes;
  loadGoalsForm();
  loadSavedMealPlan();
  loadAnalystFeed();
}

// ---------- Analyst Feed (autonomous auto-adjustment log) ----------
function _formatLogTime(createdAt) {
  const locale = currentLang() === "bg" ? "bg-BG" : undefined;
  return new Date(createdAt.replace(" ", "T")).toLocaleString(locale, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

async function loadAnalystFeed() {
  const res = await apiFetch("/api/analyst/logs?limit=20");
  if (!res.ok) return;
  const { logs } = await res.json();
  const card = $("analystFeedCard");
  if (!logs.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const [latest, ...rest] = logs;
  const changed = latest.new_calories !== latest.old_calories;
  const deltaBadge = changed
    ? `<span class="analyst-feed-delta ${latest.new_calories > latest.old_calories ? "up" : "down"}">${latest.old_calories} → ${latest.new_calories} kcal</span>`
    : "";
  // The AI coach_note (what/why/how, forgiving of imperfect adherence) is the primary
  // message when present; reason_text is the always-available, localized technical fallback.
  const latestMessage = latest.coach_note || latest.reason_text;
  $("analystFeedLatest").innerHTML = `
    <div class="analyst-feed-entry">
      <div class="analyst-feed-icon">${ICON.zap}</div>
      <div class="analyst-feed-body">
        <div class="analyst-feed-reason">${escapeHtml(latestMessage)}</div>
        ${deltaBadge}
        <div class="analyst-feed-meta">${_formatLogTime(latest.created_at)}</div>
      </div>
    </div>`;

  $("analystFeedHistory").innerHTML = rest.length
    ? rest
        .map((log) => {
          const rowChanged = log.new_calories !== log.old_calories;
          const rowDelta = rowChanged ? ` — ${log.old_calories} → ${log.new_calories} kcal` : "";
          const message = log.coach_note || log.reason_text;
          return `<div class="analyst-feed-history-row">${_formatLogTime(log.created_at)}: ${escapeHtml(message)}${rowDelta}</div>`;
        })
        .join("")
    : `<div class="analyst-feed-history-row">${t("analyst_feed_no_history")}</div>`;
}

$("calcGoalsBtn").addEventListener("click", async () => {
  const heightCm = getHeightCm();
  const weightKg = getWeightKg();
  const age = Number($("age").value);
  if (!heightCm || !weightKg || !age) {
    toast(t("fill_height_weight_age"));
    return;
  }
  const profile = {
    height_cm: heightCm,
    weight_kg: weightKg,
    age,
    sex: $("sex").value,
    activity_level: $("activityLevel").value,
    goal_type: $("goalType").value,
    dietary_notes: $("dietaryNotes").value,
  };

  const btn = $("calcGoalsBtn");
  const original = btn.textContent;
  btn.innerHTML = `<span class="spinner dark"></span> ${t("calculating")}`;
  btn.disabled = true;
  try {
    const result = await guard("calc-goals", () => api.request("/api/goals/suggested", { method: "POST", json: profile }));
    if (!result) return;
    if (!result.ok) throw new Error(failureMessage(result));
    const targets = result.data;
    state.lastTargets = targets;
    state.lastProfile = profile;

    $("sugCalories").textContent = targets.target_calories;
    $("sugProtein").textContent = targets.protein_g + "g";
    $("sugCarbs").textContent = targets.carbs_g + "g";
    $("sugFat").textContent = targets.fat_g + "g";
    $("sugWater").textContent = targets.water_ml + "ml";
    $("sugExplain").textContent = t("goals_explain", {
      bmr: targets.bmr,
      tdee: targets.tdee,
      direction: targets.rate_kg_per_week >= 0 ? t("direction_up") : t("direction_down"),
      rate: Math.abs(targets.rate_kg_per_week).toFixed(2),
    });
    $("suggestedGoalsCard").style.display = "block";
    $("suggestedGoalsCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    toast(err.message);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

$("applyGoalsBtn").addEventListener("click", async () => {
  if (!state.lastTargets || !state.lastProfile) return;
  // Profile + targets in ONE request / one transaction: a failure can't leave a new profile with old targets.
  const result = await write($("applyGoalsBtn"), "POST", "/api/goals/apply", {
    profile: state.lastProfile,
    goals: {
      calories: state.lastTargets.target_calories,
      protein_g: state.lastTargets.protein_g,
      carbs_g: state.lastTargets.carbs_g,
      fat_g: state.lastTargets.fat_g,
      water_ml: state.lastTargets.water_ml,
    },
  }, { key: GOALS_WRITE });
  if (!wrote(result)) return;
  toast(t("goals_applied"));
  loadGoalsForm();
  loadToday();
});

// ---------- Adaptive TDEE ----------
$("calcAdaptiveTdeeBtn").addEventListener("click", async () => {
  const btn = $("calcAdaptiveTdeeBtn");
  const original = btn.textContent;
  btn.innerHTML = `<span class="spinner"></span> ${t("calculating")}`;
  btn.disabled = true;
  try {
    const res = await apiFetch("/api/tdee/adaptive");
    const data = await res.json();
    renderAdaptiveTdee(data);
  } catch (err) {
    toast(t("something_wrong"));
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

const SUGGESTION_MESSAGE_KEY = {
  under_fueled: "suggestion_under_fueled",
  fat_spike: "suggestion_fat_spike",
  on_track: "suggestion_on_track",
  lose_stalled: "suggestion_lose_stalled",
  lose_too_fast: "suggestion_lose_too_fast",
  maintain_drift_up: "suggestion_maintain_drift_up",
  maintain_drift_down: "suggestion_maintain_drift_down",
};

function trackingNoteHtml(data) {
  const tr = data.tracking;
  if (!tr || !tr.partial_days) return "";
  return `<p class="explain-text">${t("tdee_tracking_note", {
    complete: tr.complete_days, total: tr.window_days, partial: tr.partial_days,
  })}</p>`;
}

function renderAdaptiveTdee(data) {
  const el = $("adaptiveTdeeResult");
  if (data.insufficient_data) {
    const reasonKey = `tdee_insufficient_reason_${data.reason}`;
    el.innerHTML = `
      <p class="explain-text">${t("tdee_insufficient_data", { min_days: data.min_days_required })}</p>
      <p class="explain-text">${t(reasonKey, { days: data.elapsed_days, min_days: data.min_days_required, logged_days: data.days_with_intake_logged })}</p>
      ${trackingNoteHtml(data)}`;
    return;
  }
  state.lastAdaptiveTdee = data;

  const suggestionsHtml = (data.suggestions || [])
    .map((s, i) => {
      const msgKey = SUGGESTION_MESSAGE_KEY[s.type];
      const message = t(msgKey, { delta: Math.abs(s.calorie_delta), weight_delta: s.weight_delta_kg, days: data.elapsed_days });
      if (s.type === "on_track") {
        // Nothing to apply — the "no change needed" case is informational only.
        return `<div class="suggestion-card" data-idx="${i}"><p class="explain-text" style="margin:0">${message}</p></div>`;
      }
      return `
        <div class="suggestion-card" data-idx="${i}">
          <p class="explain-text" style="margin:0 0 10px">${message}</p>
          <div class="modal-actions" style="margin-top:0">
            <button class="btn btn-secondary ignore-suggestion-btn" data-delta="${s.calorie_delta}">${t("ignore_suggestion_btn")}</button>
            <button class="btn btn-primary apply-suggestion-btn" data-delta="${s.calorie_delta}" data-prioritize-carbs="${!!s.prioritize_carbs}" data-protein-floor="${s.protein_floor_g || 0}">${t("apply_suggestion_btn")}</button>
          </div>
        </div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="target-grid">
      <div class="target-cell"><div class="target-value">${data.suggested_calories}</div><div class="target-label">${t("calories")}</div></div>
      <div class="target-cell"><div class="target-value">${data.protein_g}g</div><div class="target-label">${t("protein")}</div></div>
      <div class="target-cell"><div class="target-value">${data.carbs_g}g</div><div class="target-label">${t("carbs")}</div></div>
      <div class="target-cell"><div class="target-value">${data.fat_g}g</div><div class="target-label">${t("fat")}</div></div>
    </div>
    <p class="explain-text">${t(
      data.surplus_buffer_kcal > 0 ? "tdee_adaptive_explain"
        : data.surplus_buffer_kcal < 0 ? "tdee_adaptive_explain_deficit"
        : "tdee_adaptive_explain_maintain", {
      days: data.elapsed_days,
      real_tdee: data.real_tdee,
      direction: data.weight_velocity_kg_week >= 0 ? t("direction_up") : t("direction_down"),
      velocity: Math.abs(data.weight_velocity_kg_week).toFixed(2),
      buffer: Math.abs(data.surplus_buffer_kcal),
      suggested_calories: data.suggested_calories,
    })}</p>
    ${trackingNoteHtml(data)}
    <button class="btn btn-primary" id="applyAdaptiveTdeeBtn" style="width:100%">${t("tdee_adaptive_apply_btn")}</button>
    ${suggestionsHtml}`;

  $("applyAdaptiveTdeeBtn").addEventListener("click", async () => {
    const result = await write($("applyAdaptiveTdeeBtn"), "PUT", "/api/goals", {
      calories: state.lastAdaptiveTdee.suggested_calories,
      protein_g: state.lastAdaptiveTdee.protein_g,
      carbs_g: state.lastAdaptiveTdee.carbs_g,
      fat_g: state.lastAdaptiveTdee.fat_g,
    }, { key: GOALS_WRITE });
    if (!wrote(result)) return;
    toast(t("tdee_adaptive_applied_toast"));
    loadGoalsForm();
    loadToday();
  });

  el.querySelectorAll(".ignore-suggestion-btn").forEach((btn) =>
    btn.addEventListener("click", (ev) => ev.target.closest(".suggestion-card").remove())
  );
  el.querySelectorAll(".apply-suggestion-btn").forEach((btn) =>
    btn.addEventListener("click", (ev) => {
      const card = ev.target.closest(".suggestion-card");
      const delta = Number(btn.dataset.delta);
      const prioritizeCarbs = btn.dataset.prioritizeCarbs === "true";
      const proteinFloor = Number(btn.dataset.proteinFloor) || 0;
      // The guard covers the whole read-modify-write. A suggestion is a delta on the targets as they are
      // NOW, so the read must not be repeatable by a second tap while the first is still on its way.
      return guard(GOALS_WRITE, async () => {
        const wasDisabled = btn.disabled;
        btn.disabled = true;
        try {
          const goalsRes = await apiFetch("/api/goals");
          if (!goalsRes.ok) { toast(t("something_wrong")); return; }
          const goals = await goalsRes.json();
          const newCalories = goals.calories + delta;

          // Mirrors nutrition.apply_calorie_adjustment() on the backend: fat_spike suggestions
          // hold protein at its floor and take the cut out of fat (floored at 40g) instead of
          // carbs; every other suggestion keeps protein/fat fixed and lets carbs absorb the delta.
          let proteinG = goals.protein_g;
          let fatG = goals.fat_g;
          if (prioritizeCarbs) {
            proteinG = Math.max(proteinG, proteinFloor);
            fatG = Math.max(fatG + delta / 9, 40);
          }
          const carbsG = Math.round(Math.max(newCalories - proteinG * 4 - fatG * 9, 0) / 4);

          const result = await sendWrite(btn, "PUT", "/api/goals", {
            calories: Math.round(newCalories),
            protein_g: Math.round(proteinG),
            carbs_g: carbsG,
            fat_g: Math.round(fatG),
          });
          if (!wrote(result)) return;
          toast(t("suggestion_applied_toast"));
          card.remove();
          loadGoalsForm();
          loadToday();
        } catch (err) {
          toast(t("something_wrong"));      // the read never answered; nothing was written, the card stays
        } finally {
          btn.disabled = wasDisabled;
        }
      });
    })
  );
}

// ---------- AI meal plan ----------
function renderMealPlan(plan) {
  state.lastPlan = plan;
  const mealIcons = { breakfast: ICON.sunrise, lunch: ICON.sun, dinner: ICON.moon, snack: ICON.package };
  const mealsHtml = plan.meals
    .map(
      (m, i) => `
      <div class="meal-card">
        <div class="meal-header">
          <span class="meal-name">${mealIcons[m.meal_type] || ICON.plate} ${escapeHtml(m.name)}</span>
          <span class="meal-kcal">${m.calories} kcal</span>
        </div>
        <div class="meal-desc">${escapeHtml(m.description)}</div>
        <div class="meal-rationale">${escapeHtml(m.rationale)}</div>
        <div class="meal-macros">P ${m.protein_g}g · C ${m.carbs_g}g · F ${m.fat_g}g</div>
        <button class="btn btn-secondary log-plan-meal-btn" data-idx="${i}" style="width:100%;margin-top:8px">${t("log_this_meal_btn")}</button>
      </div>`
    )
    .join("");

  const locale = currentLang() === "bg" ? "bg-BG" : undefined;
  const generatedLabel = plan.generated_at
    ? `Generated ${new Date(plan.generated_at.replace(" ", "T")).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : "";

  $("mealPlanResult").innerHTML = `
    <div class="plan-day-summary">
      <div class="target-cell"><div class="target-value">${plan.daily_totals.calories}</div><div class="target-label">kcal</div></div>
      <div class="target-cell"><div class="target-value">${plan.daily_totals.protein_g}g</div><div class="target-label">${t("protein")}</div></div>
      <div class="target-cell"><div class="target-value">${plan.daily_totals.carbs_g}g</div><div class="target-label">${t("carbs")}</div></div>
      <div class="target-cell"><div class="target-value">${plan.daily_totals.fat_g}g</div><div class="target-label">${t("fat")}</div></div>
    </div>
    ${mealsHtml}
    <div class="plan-notes">${escapeHtml(plan.notes)}</div>
    ${generatedLabel ? `<div class="plan-meta">${generatedLabel}</div>` : ""}
  `;

  $("mealPlanResult").querySelectorAll(".log-plan-meal-btn").forEach((btn) =>
    btn.addEventListener("click", () => logPlanMeal(Number(btn.dataset.idx)))
  );
}

async function logPlanMeal(idx) {
  const meal = state.lastPlan.meals[idx];
  const formData = new FormData();
  formData.append("meal_type", meal.meal_type);
  formData.append("description", meal.name);
  formData.append("total_calories", meal.calories);
  formData.append("protein_g", meal.protein_g);
  formData.append("carbs_g", meal.carbs_g);
  formData.append("fat_g", meal.fat_g);

  const result = await write(null, "POST", "/api/log-manual", null, { form: formData });
  if (!wrote(result)) return;
  toast(t("logged_from_plan_toast"));
  switchTab("today");
  afterMealLogged();
  loadToday();
}

async function loadSavedMealPlan() {
  const res = await apiFetch("/api/meal-plan");
  if (!res.ok) return;
  const data = await res.json();
  if (data.plan === null) return;
  renderMealPlan(data);
  $("genPlanBtn").textContent = t("regen_plan_btn");
}

$("genPlanBtn").addEventListener("click", async () => {
  const btn = $("genPlanBtn");
  const original = btn.textContent;
  btn.innerHTML = `<span class="spinner dark"></span> ${t("building_plan")}`;
  btn.disabled = true;
  try {
    const result = await guard("gen-plan", () => api.request(`/api/meal-plan?lang=${currentLang()}`, { method: "POST" }));
    if (!result) return;
    if (!result.ok) throw new Error(failureMessage(result));
    renderMealPlan(result.data);
    btn.textContent = t("regen_plan_btn");
    toast(t("plan_ready"));
  } catch (err) {
    toast(err.message);
    btn.textContent = original;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Manual goal override ----------
async function loadGoalsForm() {
  const res = await apiFetch("/api/goals");
  if (!res.ok) return;
  const g = await res.json();
  $("goalCalories").value = g.calories;
  $("goalProtein").value = g.protein_g;
  $("goalCarbs").value = g.carbs_g;
  $("goalFat").value = g.fat_g;
  $("goalWater").value = g.water_ml;
  renderGoalsHero(g);
}
$("saveGoalsBtn").addEventListener("click", async () => {
  const result = await write($("saveGoalsBtn"), "PUT", "/api/goals", {
    calories: numOrNull("goalCalories"),
    protein_g: numOrNull("goalProtein"),
    carbs_g: numOrNull("goalCarbs"),
    fat_g: numOrNull("goalFat"),
    water_ml: numOrNull("goalWater"),
  }, { key: GOALS_WRITE });
  if (!wrote(result)) return;
  toast(t("goals_saved"));
  loadToday();
});

// ================== ADD FOOD (one sheet for photo / manual / favourites) ==================
// The three actions keep their own handlers above; this only opens the sheet and gets it out of the way once
// one of them has been chosen (the chosen action then opens its own sheet or the file picker).
const closeAddFood = () => $("addFoodModal").classList.add("hidden");
$("addFoodBtn").addEventListener("click", () => {
  state.addContext = null;                       // opened by the button, not by a reminder: suggest from the schedule
  $("addFoodModal").classList.remove("hidden");
});
$("addFoodCloseBtn").addEventListener("click", closeAddFood);
["takePhotoBtn", "manualEntryBtn", "quickAddBtn"].forEach((id) => $(id).addEventListener("click", closeAddFood));
$("diaryLink").addEventListener("click", () => switchTab("history"));

// ================== MEAL SCHEDULE & IN-APP REMINDERS ==================
// The schedule is the user's own plan (stored per profile on the server). Reminders exist only while the app is
// open and only when the user switched them on; schedule.js decides WHEN (pure, tested), this block draws it. No AI,
// no background notifications. The time a meal was eaten is separate from when it was logged (see seedWhen below).
const REMINDER_TICK_MS = 15000;
const MEAL_TYPES = CSSchedule.MEAL_TYPES;

function appNow() { return CSSchedule.clockNow(state.clock, Date.now()); }
function nowHHMM() {
  const n = appNow();
  if (n) return CSSchedule.formatTime(n.min);
  const d = new Date();
  return CSSchedule.formatTime(d.getHours() * 60 + d.getMinutes());
}
function mealWord(type) { return t(MEAL_LABEL_KEY[type] || "meal_snack"); }

function suggestedMealType() {
  if (state.addContext && state.addContext.mealType) return state.addContext.mealType;
  const now = appNow();
  if (!now || !state.today) return "snack";
  return CSSchedule.suggestMealType({ slots: state.schedule.slots, entries: state.today.entries, now });
}
// Every sheet that logs a meal asks for the meal type AND the time the user ate. It starts at the planned meal (or
// Snack) and the current time; the user can change both, and what the sheet shows is what is saved.
function seedWhen(prefix) {
  $(`${prefix}MealType`).value = suggestedMealType();
  $(`${prefix}MealTime`).value = nowHHMM();
}
function readWhen(prefix) {
  return { meal_type: $(`${prefix}MealType`).value, eaten_time: $(`${prefix}MealTime`).value.trim() };
}

function leadLabel(n) { return n === 0 ? t("lead_short_0") : t("lead_short_n", { n }); }

// Plan card, Settings row, "next meal" - all from state.schedule.
function renderScheduleViews() {
  const { slots, reminders } = state.schedule;
  $("scheduleValue").textContent = slots.length ? t("schedule_value_n", { n: slots.length }) : t("schedule_value_none");
  const reminderText = reminders.enabled ? t("reminders_state_on", { lead: leadLabel(reminders.lead_min) }) : t("reminders_state_off");
  $("scheduleSummary").innerHTML = slots.length
    ? `${slots.length === 1 ? t("schedule_n_one") : t("schedule_n_many", { n: slots.length })}<span class="sc-sub-line">${reminderText}</span>`
    : t("schedule_empty");
  $("scheduleChips").innerHTML = slots.length
    ? slots.map((s) => `<span class="sc-chip"><b>${s.time}</b>${mealWord(s.meal_type)}</span>`).join("")
    : `<p class="sc-empty">${t("schedule_empty_hint")}</p>`;
}

function renderNextMeal(next) {
  const el = $("nextMeal");
  el.hidden = !next;
  el.textContent = next ? t("next_meal_note", { meal: mealWord(next.slot.meal_type), time: next.slot.time }) : "";
}

// Today's answers to the reminders ("later" / "skip today"): this device only, never sent anywhere.
function reminderStore() {
  const now = appNow();
  const day = now ? now.date : "";
  if (!state.reminderLocal || state.reminderLocal.day !== day) state.reminderLocal = CSSchedule.loadLocal(localStorage, day);
  return state.reminderLocal;
}
function saveReminderLocal(local) {
  state.reminderLocal = local;
  CSSchedule.saveLocal(localStorage, local);
}

function reminderTick() {
  const now = appNow();
  if (!now || !state.today || $("appRoot").classList.contains("hidden")) { renderReminder(null); return; }
  if (now.date !== state.today.date) { loadToday(); return; }          // midnight passed while the page stayed open
  const result = CSSchedule.evaluate({
    slots: state.schedule.slots, reminders: state.schedule.reminders, entries: state.today.entries, now, local: reminderStore(),
  });
  renderNextMeal(result.next);
  refreshIdleLine(result.next);
  renderReminder(result.notice);
}

function renderReminder(notice) {
  const bar = $("reminderBar");
  state.notice = notice;
  if (!notice) {
    bar.hidden = true;
    state.noticeKey = null;
    if (state.reminderShown) {
      state.reminderShown = null;
      if (legion.current && (legion.current.kind === "remind" || legion.current.kind === "demand")) legion.reset();
    }
    return;
  }
  const ask = notice.phase === "ask";
  const key = `${notice.key}|${notice.phase}|${currentLang()}`;
  if (state.noticeKey !== key) {              // only rewrite the text when it is a different reminder (a live region re-reads changes)
    state.noticeKey = key;
    $("reminderTitle").textContent = t(ask ? "reminder_title_ask" : "reminder_title_upcoming", { meal: mealWord(notice.slot.meal_type), time: notice.slot.time });
    $("reminderSub").textContent = ask ? t("reminder_sub_ask") : "";
    $("reminderSub").hidden = !ask;
    $("reminderAte").textContent = t(ask ? "reminder_ate" : "reminder_log");
    $("reminderLater").textContent = t(ask ? "reminder_not_yet" : "reminder_later");
    $("reminderSkip").textContent = t(ask ? "reminder_not_eating" : "reminder_skip");
  }
  bar.classList.toggle("is-ask", ask);
  bar.hidden = false;
  // The centurion reacts too (Roman style), unless he is in the middle of approving a meal that was just logged.
  if (isRoman() && state.reminderShown !== key && !(legion.current && legion.current.kind === "approve")) {
    state.reminderShown = key;
    legion.show(ask ? "demand" : "remind", { lang: currentLang(), vars: { time: notice.slot.time }, hold: true });
  }
}

function answerReminder(kind) {
  const n = state.notice;
  const now = appNow();
  if (!n || !now) return;
  let local = reminderStore();
  if (kind === "snooze") {
    local = CSSchedule.snooze(local, n.key, now.min + CSSchedule.SNOOZE_MIN);
    toast(t("reminder_snoozed_toast", { n: CSSchedule.SNOOZE_MIN }));
  } else {
    local = CSSchedule.skip(local, n.key);
    toast(t("reminder_skipped_toast"));
  }
  saveReminderLocal(local);
  reminderTick();
}
$("reminderAte").addEventListener("click", () => {
  if (!state.notice) return;
  state.addContext = { mealType: state.notice.slot.meal_type };      // the panel's next step starts at this meal
  $("addFoodModal").classList.remove("hidden");
});
$("reminderLater").addEventListener("click", () => answerReminder("snooze"));
$("reminderSkip").addEventListener("click", () => answerReminder("skip"));
setInterval(reminderTick, REMINDER_TICK_MS);
if (typeof document.addEventListener === "function") document.addEventListener("visibilitychange", () => { if (!document.hidden) reminderTick(); });

// ---------- the schedule dialog ----------
// The dialog edits a COPY (state.scheduleDraft); nothing is stored until Save, and Cancel / Esc / drag throw it away.
function openSchedule() {
  state.scheduleDraft = JSON.parse(JSON.stringify(state.schedule));
  renderScheduleDraft();
  $("scheduleModal").classList.remove("hidden");
}

function scheduleDraftSet(i, field, value) {
  const slot = state.scheduleDraft.slots[i];
  if (slot) slot[field] = value;
}
function scheduleDraftRemove(i) {
  state.scheduleDraft.slots.splice(i, 1);
  renderScheduleDraft();
}
function scheduleDraftAdd() {
  const d = state.scheduleDraft;
  if (d.slots.length >= CSSchedule.MAX_SLOTS) return;
  const used = new Set(d.slots.map((s) => s.time));
  const time = ["12:00", "08:00", "13:00", "16:00", "19:00", "21:00", "10:30", "15:00", "17:30", "20:00"].find((x) => !used.has(x)) || "12:00";
  d.slots.push({ meal_type: d.slots.length ? "snack" : "breakfast", time });
  renderScheduleDraft();
}

function renderScheduleDraft() {
  const d = state.scheduleDraft;
  $("scheduleRows").innerHTML = d.slots.map((s, i) => `
    <div class="schedule-row" data-i="${i}">
      <select class="sr-type" data-i="${i}" aria-label="${t("schedule_row_meal")} ${i + 1}">${MEAL_TYPES.map((m) => `<option value="${m}"${m === s.meal_type ? " selected" : ""}>${mealWord(m)}</option>`).join("")}</select>
      <input type="time" class="sr-time time-input" data-i="${i}" value="${s.time}" aria-label="${t("schedule_row_time")} ${i + 1}">
      <button type="button" class="sr-remove" data-i="${i}" aria-label="${t("schedule_remove")} ${i + 1}">${ICON.x}</button>
    </div>`).join("");
  $("scheduleRows").querySelectorAll(".sr-type").forEach((el) => el.addEventListener("change", () => scheduleDraftSet(Number(el.dataset.i), "meal_type", el.value)));
  $("scheduleRows").querySelectorAll(".sr-time").forEach((el) => el.addEventListener("input", () => scheduleDraftSet(Number(el.dataset.i), "time", el.value)));
  $("scheduleRows").querySelectorAll(".sr-remove").forEach((el) => el.addEventListener("click", () => scheduleDraftRemove(Number(el.dataset.i))));
  $("scheduleAddBtn").disabled = d.slots.length >= CSSchedule.MAX_SLOTS;
  $("schedulePresetBtn").hidden = d.slots.length > 0;
  $("remindersToggle").checked = d.reminders.enabled;
  $("leadSelect").value = String(d.reminders.lead_min);
  $("leadField").hidden = !d.reminders.enabled;
}

$("scheduleAddBtn").addEventListener("click", scheduleDraftAdd);
$("schedulePresetBtn").addEventListener("click", () => { state.scheduleDraft.slots = CSSchedule.presetSlots(); renderScheduleDraft(); });
$("remindersToggle").addEventListener("change", (e) => {
  state.scheduleDraft.reminders.enabled = e.target.checked;
  $("leadField").hidden = !e.target.checked;
});
$("leadSelect").addEventListener("change", (e) => { state.scheduleDraft.reminders.lead_min = Number(e.target.value); });
$("scheduleCancelBtn").addEventListener("click", () => { state.scheduleDraft = null; $("scheduleModal").classList.add("hidden"); });
$("scheduleSaveBtn").addEventListener("click", async () => {
  const d = state.scheduleDraft;
  if (!d) return;
  const body = {
    slots: d.slots.map((s) => ({ meal_type: s.meal_type, time: s.time })),
    reminders: { enabled: d.reminders.enabled, lead_min: d.reminders.lead_min },
  };
  const result = await write($("scheduleSaveBtn"), "PUT", "/api/schedule", body);
  if (!wrote(result)) return;                     // the dialog stays open with everything as it was typed
  state.schedule = result.data;
  state.scheduleDraft = null;
  state.reminderShown = null;
  state.noticeKey = null;
  renderScheduleViews();
  $("scheduleModal").classList.add("hidden");
  toast(t("schedule_saved_toast"));
  reminderTick();
});
$("scheduleEditBtn").addEventListener("click", openSchedule);
$("scheduleOpenBtn").addEventListener("click", () => openFromSettings("scheduleModal", openSchedule));

// ================== ROMAN LEGION (presentation only) ==================
// Local lines and reactions: no network, no AI, nothing is stored or written to the user's data. The hero shows the
// centurion only in Roman style, and only what is real: a calm line from today's totals (naming the next planned meal
// when there is one), his approval right after a meal was actually logged, and - only when the user switched
// reminders on and only while the app is open - a reminder before a planned meal and a question when it has no
// record (schedule.js decides when). The separate, clearly-labelled reaction preview (Settings -> preview) still plays
// every reaction with made-up times and writes nothing.
const legion = CSLegion.createController({ render: (r) => renderLegion(r) });
const previewLegion = CSLegion.createController({ render: (r) => renderPreview(r), idleDelayMs: 60 * 60 * 1000 });
const isRoman = () => typeof look !== "undefined" && look.mode === "roman";
const PREVIEW_CHIPS = { remind: { nextMeal: "18:30" }, demand: { nextMeal: "18:30", lastLog: "15:40" } };

// All four portraits live in the holder; the active one is shown (a cross-fade).
function setPortraitMood(holder, mood) {
  if (!holder.innerHTML) holder.innerHTML = CSLegion.portraitHtml(mood);
  holder.querySelectorAll(".lg-img").forEach((img) => img.classList.toggle("is-active", img.dataset.mood === mood));
}

function renderLegion(r) {
  const roman = isRoman();
  $("legionStage").hidden = !roman;
  $("legionBubble").hidden = !roman;
  $("legionPreviewBtn").hidden = !roman;
  if (!roman) return;
  const reaction = r || CSLegion.reaction(state.legionIdle, currentLang(), 0, state.legionVars);
  setPortraitMood($("legionPortrait"), reaction.mood);
  const bubble = $("legionBubble");
  $("legionText").textContent = reaction.text;
  bubble.classList.remove("swap");
  void bubble.offsetWidth;                       // restart the entrance animation
  bubble.classList.add("swap");
}

function renderPreview(r) {
  const reaction = r || CSLegion.reaction("idle", currentLang(), 0);
  setPortraitMood($("legionPreviewPortrait"), reaction.mood);
  $("legionPreviewText").textContent = reaction.text;
  const word = t("legion_demo_word");
  const chips = r ? PREVIEW_CHIPS[r.kind] : null;
  $("legionPreviewChips").innerHTML = chips
    ? CSLegion.chipsHtml(
        { nextMeal: chips.nextMeal && `${chips.nextMeal} · ${word}`, lastLog: chips.lastLog && `${chips.lastLog} · ${word}` },
        { next: t("legion_next_meal"), last: t("legion_last_record") }, escapeHtml)
    : "";
}

function afterMealLogged() {
  state.addContext = null;
  if (isRoman()) legion.show("approve", { lang: currentLang() });
}

function previewReaction(kind, vars) {
  previewLegion.show(kind, { lang: currentLang(), demo: true, vars, hold: true });
}
$("demoApprove").addEventListener("click", () => previewReaction("approve"));
$("demoRemind").addEventListener("click", () => previewReaction("remind", { time: "18:30" }));
$("demoDemand").addEventListener("click", () => previewReaction("demand"));
$("legionPreviewBtn").addEventListener("click", () => openFromSettings("legionPreviewModal", () => {
  previewLegion.reset();
  $("legionPreviewModal").classList.remove("hidden");
}));
$("legionPreviewCloseBtn").addEventListener("click", () => $("legionPreviewModal").classList.add("hidden"));
if (typeof look !== "undefined") {
  look.onChange(() => { refreshAppearanceControls(); legion.reset(); state.reminderShown = null; refreshGate(); reminderTick(); });
  refreshAppearanceControls();
}
renderLegion(null);

// ================== ACCESSIBILITY: labels, dialogs, on-screen keyboard ==================
// Every visible field gets a programmatic label (the markup pairs <label> and control inside .field).
function labelFields() {
  document.querySelectorAll(".field").forEach((f) => {
    const label = f.querySelector("label");
    const control = f.querySelector("input, select, textarea");
    if (label && control && control.id && !label.htmlFor) label.htmlFor = control.id;
  });
}
labelFields();

// Dialogs are opened/closed all over the file by toggling the `hidden` class. Rather than touch every call, one
// observer gives every sheet the same behaviour: role/aria; focus moves into the sheet and comes back to what
// opened it; Tab stays inside the TOPMOST dialog; Esc closes it (through its own Close/Cancel button, so any cleanup
// that button does still runs); everything underneath is inert. "Topmost" means the most recently OPENED (tracked by
// CSDialogs.createStack, tested on its own), never the last one in the page, and every open dialog gets a higher
// z-index than the one below it. A dialog opened FROM Settings (What's New, the reaction preview) replaces Settings
// and brings it back when it closes, however it closes.
const DIALOG_CLOSE_BUTTON = {
  addFoodModal: "addFoodCloseBtn", welcomeModal: "welcomeDismissBtn", photoReviewModal: "photoCancelBtn",
  whatsNewModal: "whatsNewCloseBtn", manualModal: "manualCancelBtn", favoritesModal: "favoritesCloseBtn",
  editModal: "editCancelBtn", settingsModal: "settingsCloseBtn", legionPreviewModal: "legionPreviewCloseBtn",
  scheduleModal: "scheduleCancelBtn",
};
const dialogs = Array.from(document.querySelectorAll(".modal-backdrop"));
const dialogStack = CSDialogs.createStack();
const isOpen = (m) => !m.classList.contains("hidden");
const isShown = (el) => !!el && (el.getClientRects ? el.getClientRects().length > 0 : true);
const wasOpen = new Map();
const openerOf = new Map();             // dialog id -> the control that opened it
const keepOpener = new Set();           // dialogs that will come back: remember what originally opened them
let lastTrigger = null;                 // the control last clicked (Safari does not focus buttons on click)
let focusOnOpen = null;                 // set when a dialog comes back: focus this control, not the sheet
document.addEventListener("click", (e) => {
  const el = e.target && e.target.closest ? e.target.closest("button, a, summary, input, select") : null;
  if (el) lastTrigger = el;
}, true);

function openFromSettings(modalId, open) {
  dialogStack.returnTo(modalId, "settingsModal");
  keepOpener.add("settingsModal");
  $("settingsModal").classList.add("hidden");
  open();
}

function focusables(root) {
  return Array.from(root.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.disabled && !el.hidden && isShown(el));
}

function layoutDialogs() {
  const order = dialogStack.order;
  dialogs.forEach((m) => {
    const at = order.indexOf(m.id);
    m.style.zIndex = at >= 0 ? String(CSDialogs.zIndexAt(at)) : "";
    const covered = at >= 0 && at < order.length - 1;
    m.inert = covered;
    if (covered) m.setAttribute("aria-hidden", "true"); else m.removeAttribute("aria-hidden");
  });
  const root = $("appRoot");
  root.inert = order.length > 0;
  if (order.length) root.setAttribute("aria-hidden", "true"); else root.removeAttribute("aria-hidden");
}

function onDialogOpen(modal) {
  dialogStack.open(modal.id);
  layoutDialogs();
  if (!openerOf.has(modal.id)) openerOf.set(modal.id, lastTrigger || document.activeElement);
  keepOpener.delete(modal.id);
  const sheet = modal.querySelector(".modal-sheet");
  const target = focusOnOpen && isShown(focusOnOpen) ? focusOnOpen : sheet;   // the sheet itself raises no keyboard
  focusOnOpen = null;
  if (sheet) sheet.setAttribute("tabindex", "-1");
  if (target && target.focus) target.focus({ preventScroll: true });
}

function onDialogClose(modal) {
  const { reopen } = dialogStack.close(modal.id);
  layoutDialogs();
  const opener = openerOf.get(modal.id);
  if (!keepOpener.has(modal.id)) openerOf.delete(modal.id);
  if (reopen) {                                       // opened from Settings: bring it back, focus on its opener
    focusOnOpen = opener;
    $(reopen).classList.remove("hidden");
    return;
  }
  if (dialogs.some((m) => m !== modal && isOpen(m))) return;     // another sheet is (about to be) up: it keeps focus
  const target = isShown(opener) ? opener : (isShown($("addFoodBtn")) ? $("addFoodBtn") : null);
  if (target && target.focus) target.focus({ preventScroll: true });
}

function initDialogs() {
  dialogs.forEach((modal) => {
    const title = modal.querySelector("h2");
    if (title && !title.id) title.id = `${modal.id}Title`;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    if (title) modal.setAttribute("aria-labelledby", title.id);
    wasOpen.set(modal, isOpen(modal));
  });
  if (typeof MutationObserver === "function") {
    const observer = new MutationObserver((records) => {
      new Set(records.map((r) => r.target)).forEach((modal) => {
        const now = isOpen(modal);
        if (now === wasOpen.get(modal)) return;
        wasOpen.set(modal, now);
        if (now) onDialogOpen(modal); else onDialogClose(modal);
      });
    });
    dialogs.forEach((modal) => observer.observe(modal, { attributes: true, attributeFilter: ["class"] }));
  }
  document.addEventListener("keydown", (e) => {
    const topId = dialogStack.top;
    if (!topId) return;
    const top = $(topId);
    if (e.key === "Escape") {
      const close = $(DIALOG_CLOSE_BUTTON[topId]);
      if (close) { e.preventDefault(); close.click(); }
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables(top);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === top.querySelector(".modal-sheet"))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  });
}
initDialogs();

// On-screen keyboard: keep the sheet inside the VISIBLE viewport, bring the focused field into view, and hide the
// floating Add-food button while typing so it can't sit on top of a field.
(function initKeyboardAwareness() {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  const root = document.documentElement;
  if (vv && root && root.style && root.style.setProperty) {
    const update = () => {
      root.style.setProperty("--vvh", `${vv.height}px`);
      root.style.setProperty("--vvt", `${vv.offsetTop}px`);
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "");
      document.body.classList.toggle("kb-open", typing && window.innerHeight - vv.height > 120);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
  }
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (!el || !el.closest || !el.closest(".modal-sheet") || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    setTimeout(() => el.scrollIntoView && el.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" }), 250);
  });
})();

// ---------- Bottom-sheet drag-to-dismiss ----------
function attachSheetDrag(sheetEl, closeFn) {
  const handle = sheetEl.querySelector(".sheet-handle");
  if (!handle) return;
  let startY = 0, dragging = false, lastY = 0, lastT = 0, velocity = 0;
  const onMove = (e) => {
    if (!dragging) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = Math.max(0, y - startY);
    const now = Date.now();
    if (now > lastT) velocity = (y - lastY) / (now - lastT);
    lastY = y; lastT = now;
    sheetEl.style.transition = "none";
    sheetEl.style.transform = `translateY(${dy}px)`;
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    const dy = Math.max(0, lastY - startY);
    sheetEl.style.transition = "";
    if (dy > sheetEl.offsetHeight * 0.25 || velocity > 0.5) {
      sheetEl.style.transform = "translateY(100%)";
      setTimeout(() => {
        sheetEl.style.transform = "";
        closeFn();
      }, 200);
    } else {
      sheetEl.style.transform = "";
    }
  };
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = lastY = e.clientY;
    lastT = Date.now();
    velocity = 0;
  });
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onEnd);
}

attachSheetDrag($("addFoodModal"), closeAddFood);
attachSheetDrag($("legionPreviewModal"), () => $("legionPreviewModal").classList.add("hidden"));
attachSheetDrag($("scheduleModal"), () => $("scheduleCancelBtn").click());
attachSheetDrag($("welcomeModal"), () => $("welcomeModal").classList.add("hidden"));
attachSheetDrag($("photoReviewModal"), closePhotoReview);
attachSheetDrag($("whatsNewModal"), () => $("whatsNewModal").classList.add("hidden"));
attachSheetDrag($("manualModal"), () => $("manualModal").classList.add("hidden"));
attachSheetDrag($("favoritesModal"), () => $("favoritesModal").classList.add("hidden"));
attachSheetDrag($("editModal"), () => $("editModal").classList.add("hidden"));
attachSheetDrag($("settingsModal"), () => $("settingsModal").classList.add("hidden"));

// ---------- Service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}

initUserGate();
