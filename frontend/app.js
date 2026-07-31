const state = { entryBeingEdited: null, units: "metric", pendingPinUserId: null };

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const userId = localStorage.getItem("userId");
  if (userId) headers["X-User-Id"] = userId;
  return fetch(url, { ...options, headers });
}

// ---------- Theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
}
(function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) applyTheme(saved);
})();
$("themeBtn").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(current === "dark" ? "light" : "dark");
});

// ---------- Language ----------
function refreshLangBtn() {
  $("langBtn").textContent = currentLang() === "bg" ? "BG" : "EN";
}
$("langBtn").addEventListener("click", () => {
  localStorage.setItem("lang", currentLang() === "bg" ? "en" : "bg");
  applyStaticTranslations();
  refreshLangBtn();
  loadToday();
  if (document.getElementById("tab-history").classList.contains("active")) loadHistory();
  if (document.getElementById("tab-plan").classList.contains("active")) loadSavedMealPlan();
});
refreshLangBtn();

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "history") loadHistory();
    if (btn.dataset.tab === "plan") loadPlanTab();
  });
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

// ================== USER GATE ==================

async function initUserGate() {
  const storedId = localStorage.getItem("userId");
  if (storedId) {
    showApp();
    return;
  }
  await renderUserList();
}

async function renderUserList() {
  const res = await fetch("/api/users");
  const users = await res.json();
  const list = $("userList");
  list.innerHTML = users
    .map(
      (u) => `<button class="pick-user-btn" data-id="${u.id}" data-haspin="${u.has_pin}">
        <span>${escapeHtml(u.name)}</span>${u.has_pin ? '<span class="pin-lock">🔒</span>' : ""}
      </button>`
    )
    .join("");
  list.querySelectorAll(".pick-user-btn").forEach((btn) =>
    btn.addEventListener("click", () => selectUser(Number(btn.dataset.id), btn.dataset.haspin === "1", btn.querySelector("span").textContent))
  );
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function selectUser(id, hasPin, name) {
  if (!hasPin) {
    localStorage.setItem("userId", id);
    showApp();
    return;
  }
  state.pendingPinUserId = id;
  $("pinForLabel").textContent = t("pin_for", { name });
  $("pinInput").value = "";
  $("newPersonForm").classList.add("hidden");
  $("pinForm").classList.remove("hidden");
  $("pinInput").focus();
}

$("newPersonBtn").addEventListener("click", () => {
  $("pinForm").classList.add("hidden");
  $("newPersonForm").classList.toggle("hidden");
});

$("pinBackBtn").addEventListener("click", () => {
  $("pinForm").classList.add("hidden");
  state.pendingPinUserId = null;
});

$("pinUnlockBtn").addEventListener("click", async () => {
  const pin = $("pinInput").value.trim();
  const res = await fetch(`/api/users/${state.pendingPinUserId}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  const data = await res.json();
  if (data.ok) {
    localStorage.setItem("userId", state.pendingPinUserId);
    showApp();
  } else {
    toast(t("wrong_pin"));
  }
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
  const res = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, pin: pin || null }),
  });
  if (!res.ok) {
    toast(t("something_wrong"));
    return;
  }
  const user = await res.json();
  localStorage.setItem("userId", user.id);
  showApp();
});

function showApp() {
  $("userGate").classList.add("hidden");
  $("appRoot").classList.remove("hidden");
  applyStaticTranslations();
  refreshLangBtn();
  loadToday();
  maybeShowWelcome();
}

$("switchUserBtn").addEventListener("click", () => {
  localStorage.removeItem("userId");
  $("appRoot").classList.add("hidden");
  $("userGate").classList.remove("hidden");
  $("newPersonForm").classList.add("hidden");
  $("pinForm").classList.add("hidden");
  applyStaticTranslations();
  renderUserList();
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

// ================== TODAY ==================
const RING_CIRCUMFERENCE = 2 * Math.PI * 62;

async function loadToday() {
  const res = await apiFetch("/api/today");
  if (!res.ok) return;
  const data = await res.json();
  renderTotals(data.totals, data.goals);
  renderEntries(data.entries);
}

function renderTotals(totals, goals) {
  const remaining = Math.max(0, goals.calories - totals.calories);
  const pct = goals.calories ? Math.min(1, totals.calories / goals.calories) : 0;

  $("ringCalsLeft").textContent = remaining;
  $("totalCals").textContent = totals.calories;
  $("calGoalDisplay").textContent = goals.calories;

  const ring = $("calRingFill");
  ring.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - pct);
  ring.classList.toggle("over", totals.calories > goals.calories);

  setMacro("protein", totals.protein_g, goals.protein_g);
  setMacro("carbs", totals.carbs_g, goals.carbs_g);
  setMacro("fat", totals.fat_g, goals.fat_g);
}

function setMacro(name, value, goal) {
  $(`${name}Val`).textContent = `${value}g`;
  const pct = goal ? Math.min(100, Math.round((value / goal) * 100)) : 0;
  $(`${name}Fill`).style.width = pct + "%";
}

const MEAL_LABEL_KEY = { breakfast: "meal_breakfast", lunch: "meal_lunch", dinner: "meal_dinner", snack: "meal_snack" };

function renderEntries(entries) {
  const list = $("entriesList");
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state">${t("no_entries_line1")}<br>${t("no_entries_line2")}</div>`;
    return;
  }
  list.innerHTML = entries
    .slice()
    .reverse()
    .map((e) => {
      const thumb = e.image_path
        ? `<img class="thumb" src="/uploads/${e.image_path}" alt="">`
        : `<div class="thumb-placeholder">✏️</div>`;
      const itemNames = e.items.map((i) => i.name).join(", ");
      const lowConf = e.confidence === "low" ? `<span class="badge low-confidence">${t("low_confidence")}</span>` : "";
      const time = e.created_at.slice(11, 16);
      return `
        <div class="entry" data-id="${e.id}">
          ${thumb}
          <div class="entry-body">
            <div class="entry-title">${e.total_calories} kcal <span class="badge">${t(MEAL_LABEL_KEY[e.meal_type] || "meal_snack")}</span> ${lowConf}</div>
            <div class="entry-items">${escapeHtml(itemNames)} · ${time}</div>
            <div class="entry-macros">P ${e.protein_g}g · C ${e.carbs_g}g · F ${e.fat_g}g</div>
          </div>
          <div class="entry-actions">
            <button class="edit-btn" title="${t("edit")}">✎</button>
            <button class="delete-btn" title="${t("delete")}">🗑</button>
          </div>
        </div>`;
    })
    .join("");

  list.querySelectorAll(".edit-btn").forEach((btn) =>
    btn.addEventListener("click", (ev) => openEdit(ev.target.closest(".entry").dataset.id))
  );
  list.querySelectorAll(".delete-btn").forEach((btn) =>
    btn.addEventListener("click", (ev) => deleteEntry(ev.target.closest(".entry").dataset.id))
  );
}

async function deleteEntry(id) {
  if (!confirm(t("delete_confirm"))) return;
  await apiFetch(`/api/entries/${id}`, { method: "DELETE" });
  loadToday();
}

async function openEdit(id) {
  const res = await apiFetch(`/api/entries/${id}`);
  const e = await res.json();
  state.entryBeingEdited = id;
  $("editMealType").value = e.meal_type;
  $("editCals").value = e.total_calories;
  $("editProtein").value = e.protein_g;
  $("editCarbs").value = e.carbs_g;
  $("editFat").value = e.fat_g;
  $("editModal").classList.remove("hidden");
}
$("editCancelBtn").addEventListener("click", () => $("editModal").classList.add("hidden"));
$("editSaveBtn").addEventListener("click", async () => {
  const id = state.entryBeingEdited;
  await apiFetch(`/api/entries/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      meal_type: $("editMealType").value,
      total_calories: Number($("editCals").value),
      protein_g: Number($("editProtein").value),
      carbs_g: Number($("editCarbs").value),
      fat_g: Number($("editFat").value),
    }),
  });
  $("editModal").classList.add("hidden");
  loadToday();
});

// ---------- Photo capture ----------
$("takePhotoBtn").addEventListener("click", () => $("photoInput").click());
$("photoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const btn = $("takePhotoBtn");
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span> ${t("analyzing")}`;
  btn.disabled = true;

  const formData = new FormData();
  formData.append("image", file);
  formData.append("meal_type", $("mealTypeSelect").value);
  formData.append("lang", currentLang());

  try {
    const res = await apiFetch("/api/log-meal", { method: "POST", body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || t("something_wrong"));
    }
    const entry = await res.json();
    toast(t("logged_kcal", { kcal: entry.total_calories, confidence: entry.confidence }));
    loadToday();
  } catch (err) {
    toast(err.message || t("something_wrong"));
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
    e.target.value = "";
  }
});

// ---------- Manual entry ----------
$("manualEntryBtn").addEventListener("click", () => $("manualModal").classList.remove("hidden"));
$("manualCancelBtn").addEventListener("click", () => $("manualModal").classList.add("hidden"));
$("manualSaveBtn").addEventListener("click", async () => {
  const desc = $("manualDesc").value.trim();
  const cals = Number($("manualCals").value);
  if (!desc || !cals) {
    toast(t("fill_desc_cals"));
    return;
  }
  const formData = new FormData();
  formData.append("meal_type", $("mealTypeSelect").value);
  formData.append("description", desc);
  formData.append("total_calories", cals);
  formData.append("protein_g", Number($("manualProtein").value) || 0);
  formData.append("carbs_g", Number($("manualCarbs").value) || 0);
  formData.append("fat_g", Number($("manualFat").value) || 0);

  await apiFetch("/api/log-manual", { method: "POST", body: formData });
  $("manualModal").classList.add("hidden");
  ["manualDesc", "manualCals", "manualProtein", "manualCarbs", "manualFat"].forEach((id) => ($(id).value = ""));
  loadToday();
});

// ================== HISTORY ==================
async function loadHistory() {
  const res = await apiFetch("/api/history?days=14");
  const data = await res.json();
  const max = Math.max(1, ...data.days.map((d) => d.totals.calories));
  $("historyList").innerHTML = data.days
    .slice()
    .reverse()
    .map((d) => {
      const pct = Math.round((d.totals.calories / max) * 100);
      const locale = currentLang() === "bg" ? "bg-BG" : undefined;
      const label = new Date(d.date + "T00:00:00").toLocaleDateString(locale, { month: "short", day: "numeric" });
      return `
        <div class="history-day">
          <div class="date">${label}</div>
          <div class="bar-track"><div class="fill" style="width:${pct}%"></div></div>
          <div class="kcal">${d.totals.calories}</div>
        </div>`;
    })
    .join("");
}

// ================== PLAN TAB ==================
document.querySelectorAll(".unit-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".unit-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.units = btn.dataset.units;
    const imperial = state.units === "imperial";
    document.querySelectorAll(".imperial-only").forEach((el) => (el.style.display = imperial ? "block" : "none"));
    $("heightLabel").textContent = imperial ? t("height_ft") : t("height_cm");
    $("weightLabel").textContent = imperial ? t("weight_lb") : t("weight_kg");
  });
});

function getHeightCm() {
  if (state.units === "metric") return Number($("heightCm").value) || 0;
  const ft = Number($("heightCm").value) || 0;
  const inch = Number($("heightIn").value) || 0;
  return Math.round((ft * 12 + inch) * 2.54);
}
function getWeightKg() {
  const raw = Number($("weightKg").value) || 0;
  return state.units === "metric" ? raw : Math.round(raw * 0.453592 * 10) / 10;
}

async function loadPlanTab() {
  const res = await apiFetch("/api/profile");
  const p = await res.json();
  if (p.height_cm) $("heightCm").value = p.height_cm;
  if (p.weight_kg) $("weightKg").value = p.weight_kg;
  if (p.age) $("age").value = p.age;
  if (p.sex) $("sex").value = p.sex;
  if (p.activity_level) $("activityLevel").value = p.activity_level;
  if (p.goal_type) $("goalType").value = p.goal_type;
  if (p.dietary_notes) $("dietaryNotes").value = p.dietary_notes;
  loadGoalsForm();
  loadSavedMealPlan();
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
    const res = await apiFetch("/api/goals/suggested", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    if (!res.ok) throw new Error(t("could_not_calc"));
    const targets = await res.json();
    state.lastTargets = targets;
    state.lastProfile = profile;

    $("sugCalories").textContent = targets.target_calories;
    $("sugProtein").textContent = targets.protein_g + "g";
    $("sugCarbs").textContent = targets.carbs_g + "g";
    $("sugFat").textContent = targets.fat_g + "g";
    $("sugExplain").textContent =
      `Based on your BMR (${targets.bmr} kcal) via the Mifflin-St Jeor equation, scaled by your activity level ` +
      `to a maintenance TDEE of ${targets.tdee} kcal, then adjusted ${targets.rate_kg_per_week >= 0 ? "up" : "down"} ` +
      `by about ${Math.abs(targets.rate_kg_per_week).toFixed(2)}kg/week toward your goal. Protein is set high ` +
      `(within the ISSN's recommended 1.6-2.2g/kg range) to preserve lean mass.`;
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
  await apiFetch("/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.lastProfile),
  });
  await apiFetch("/api/goals", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      calories: state.lastTargets.target_calories,
      protein_g: state.lastTargets.protein_g,
      carbs_g: state.lastTargets.carbs_g,
      fat_g: state.lastTargets.fat_g,
    }),
  });
  toast(t("goals_applied"));
  loadGoalsForm();
  loadToday();
});

// ---------- AI meal plan ----------
function renderMealPlan(plan) {
  const mealIcons = { breakfast: "🌅", lunch: "☀️", dinner: "🌙", snack: "🍎" };
  const mealsHtml = plan.meals
    .map(
      (m) => `
      <div class="meal-card">
        <div class="meal-header">
          <span class="meal-name">${mealIcons[m.meal_type] || "🍽"} ${escapeHtml(m.name)}</span>
          <span class="meal-kcal">${m.calories} kcal</span>
        </div>
        <div class="meal-desc">${escapeHtml(m.description)}</div>
        <div class="meal-rationale">${escapeHtml(m.rationale)}</div>
        <div class="meal-macros">P ${m.protein_g}g · C ${m.carbs_g}g · F ${m.fat_g}g</div>
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
}

async function loadSavedMealPlan() {
  const res = await apiFetch("/api/meal-plan");
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
    const res = await apiFetch(`/api/meal-plan?lang=${currentLang()}`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || t("could_not_gen_plan"));
    }
    const plan = await res.json();
    renderMealPlan(plan);
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
  const g = await res.json();
  $("goalCalories").value = g.calories;
  $("goalProtein").value = g.protein_g;
  $("goalCarbs").value = g.carbs_g;
  $("goalFat").value = g.fat_g;
}
$("saveGoalsBtn").addEventListener("click", async () => {
  await apiFetch("/api/goals", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      calories: Number($("goalCalories").value),
      protein_g: Number($("goalProtein").value),
      carbs_g: Number($("goalCarbs").value),
      fat_g: Number($("goalFat").value),
    }),
  });
  toast(t("goals_saved"));
  loadToday();
});

// ---------- Service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}

initUserGate();
