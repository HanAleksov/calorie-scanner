const state = { entryBeingEdited: null };

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
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

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "history") loadHistory();
    if (btn.dataset.tab === "goals") loadGoalsForm();
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

// ---------- Today ----------
async function loadToday() {
  const res = await fetch("/api/today");
  const data = await res.json();
  renderTotals(data.totals, data.goals);
  renderEntries(data.entries);
}

function renderTotals(totals, goals) {
  const calPct = goals.calories ? Math.min(100, Math.round((totals.calories / goals.calories) * 100)) : 0;
  $("totalCals").textContent = totals.calories;
  $("calGoalLabel").textContent = `/ ${goals.calories} kcal`;
  const fill = $("calProgressFill");
  fill.style.width = calPct + "%";
  fill.classList.toggle("over", totals.calories > goals.calories);

  setMacro("protein", totals.protein_g, goals.protein_g);
  setMacro("carbs", totals.carbs_g, goals.carbs_g);
  setMacro("fat", totals.fat_g, goals.fat_g);
}

function setMacro(name, value, goal) {
  $(`${name}Val`).textContent = `${value}g`;
  const pct = goal ? Math.min(100, Math.round((value / goal) * 100)) : 0;
  $(`${name}Fill`).style.width = pct + "%";
}

function renderEntries(entries) {
  const list = $("entriesList");
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state">No meals logged yet today. Add a photo to get started.</div>`;
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
      const lowConf = e.confidence === "low" ? `<span class="badge low-confidence">low confidence</span>` : "";
      const time = e.created_at.slice(11, 16);
      return `
        <div class="entry" data-id="${e.id}">
          ${thumb}
          <div class="entry-body">
            <div class="entry-title">${e.total_calories} kcal <span class="badge">${e.meal_type}</span> ${lowConf}</div>
            <div class="entry-items">${itemNames} · ${time}</div>
            <div class="entry-macros">P ${e.protein_g}g · C ${e.carbs_g}g · F ${e.fat_g}g</div>
          </div>
          <div class="entry-actions">
            <button class="edit-btn" title="Edit">✎</button>
            <button class="delete-btn" title="Delete">🗑</button>
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
  if (!confirm("Delete this entry?")) return;
  await fetch(`/api/entries/${id}`, { method: "DELETE" });
  loadToday();
}

async function openEdit(id) {
  const res = await fetch(`/api/entries/${id}`);
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
  await fetch(`/api/entries/${id}`, {
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
  const originalText = btn.textContent;
  btn.innerHTML = `<span class="spinner"></span> Analyzing…`;
  btn.disabled = true;

  const formData = new FormData();
  formData.append("image", file);
  formData.append("meal_type", $("mealTypeSelect").value);

  try {
    const res = await fetch("/api/log-meal", { method: "POST", body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to analyze photo");
    }
    const entry = await res.json();
    toast(`Logged ${entry.total_calories} kcal (${entry.confidence} confidence)`);
    loadToday();
  } catch (err) {
    toast(err.message || "Something went wrong");
  } finally {
    btn.textContent = originalText;
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
    toast("Enter a description and calories");
    return;
  }
  const formData = new FormData();
  formData.append("meal_type", $("mealTypeSelect").value);
  formData.append("description", desc);
  formData.append("total_calories", cals);
  formData.append("protein_g", Number($("manualProtein").value) || 0);
  formData.append("carbs_g", Number($("manualCarbs").value) || 0);
  formData.append("fat_g", Number($("manualFat").value) || 0);

  await fetch("/api/log-manual", { method: "POST", body: formData });
  $("manualModal").classList.add("hidden");
  ["manualDesc", "manualCals", "manualProtein", "manualCarbs", "manualFat"].forEach((id) => ($(id).value = ""));
  loadToday();
});

// ---------- History ----------
async function loadHistory() {
  const res = await fetch("/api/history?days=14");
  const data = await res.json();
  const max = Math.max(1, ...data.days.map((d) => d.totals.calories));
  $("historyList").innerHTML = data.days
    .slice()
    .reverse()
    .map((d) => {
      const pct = Math.round((d.totals.calories / max) * 100);
      const label = new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return `
        <div class="history-day">
          <div class="date">${label}</div>
          <div class="bar-track"><div class="fill" style="width:${pct}%"></div></div>
          <div class="kcal">${d.totals.calories}</div>
        </div>`;
    })
    .join("");
}

// ---------- Goals ----------
async function loadGoalsForm() {
  const res = await fetch("/api/goals");
  const g = await res.json();
  $("goalCalories").value = g.calories;
  $("goalProtein").value = g.protein_g;
  $("goalCarbs").value = g.carbs_g;
  $("goalFat").value = g.fat_g;
}
$("saveGoalsBtn").addEventListener("click", async () => {
  await fetch("/api/goals", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      calories: Number($("goalCalories").value),
      protein_g: Number($("goalProtein").value),
      carbs_g: Number($("goalCarbs").value),
      fat_g: Number($("goalFat").value),
    }),
  });
  toast("Goals saved");
  loadToday();
});

// ---------- Service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}

loadToday();
