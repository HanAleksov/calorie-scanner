const TRANSLATIONS = {
  en: {
    app_name: "Calorie Scanner",
    tab_today: "Today",
    tab_history: "History",
    tab_plan: "Plan",
    ios_hint: 'Install this app: tap Share, then "Add to Home Screen".',

    kcal_left: "kcal left",
    eaten: "eaten",
    goal: "goal",
    protein: "Protein",
    carbs: "Carbs",
    fat: "Fat",

    meal_breakfast: "Breakfast",
    meal_lunch: "Lunch",
    meal_dinner: "Dinner",
    meal_snack: "Snack",

    add_photo: "Add Photo",
    manual: "Manual",
    analyzing: "Analyzing…",
    no_entries_line1: "No meals logged yet today.",
    no_entries_line2: "Add a photo to get started.",
    low_confidence: "low confidence",
    edit: "Edit",
    delete: "Delete",
    delete_confirm: "Delete this entry?",

    manual_entry_title: "Manual Entry",
    description: "Description",
    description_ph: "e.g. Protein shake",
    calories: "Calories",
    protein_g: "Protein (g)",
    carbs_g: "Carbs (g)",
    fat_g: "Fat (g)",
    cancel: "Cancel",
    save: "Save",
    fill_desc_cals: "Enter a description and calories",

    edit_entry_title: "Edit Entry",
    meal_type: "Meal type",

    history_title: "Last 14 days",

    profile_title: "Your Profile",
    metric: "Metric",
    imperial: "Imperial",
    height_cm: "Height (cm)",
    height_ft: "Height (ft)",
    weight_kg: "Weight (kg)",
    weight_lb: "Weight (lb)",
    age: "Age",
    sex: "Sex",
    sex_male: "Male",
    sex_female: "Female",
    sex_other: "Other",
    activity_level: "Activity level",
    activity_sedentary: "Sedentary — desk job, little exercise",
    activity_light: "Light — exercise 1-3 days/week",
    activity_moderate: "Moderate — exercise 3-5 days/week",
    activity_active: "Active — hard exercise 6-7 days/week",
    activity_very_active: "Very active — physical job + training",
    goal_label: "Goal",
    goal_lose: "Lose weight",
    goal_maintain: "Maintain weight",
    goal_gain: "Gain weight / muscle",
    dietary_notes: "Dietary preferences / restrictions (optional)",
    dietary_notes_ph: "e.g. vegetarian, no nuts, high-protein",
    calc_goals_btn: "Calculate My Goals",
    calculating: "Calculating…",
    fill_height_weight_age: "Fill in height, weight, and age first",
    could_not_calc: "Could not calculate goals",

    suggested_targets: "Suggested Daily Targets",
    apply_goals_btn: "Apply These Goals",
    goals_applied: "Goals applied — your Today ring is updated",

    ai_meal_plan: "AI Meal Plan",
    ai_meal_plan_desc: "Generates one full day of meals built around your current goals.",
    gen_plan_btn: "Generate My Meal Plan",
    regen_plan_btn: "Regenerate Meal Plan",
    building_plan: "Building your plan…",
    plan_ready: "Meal plan ready",
    could_not_gen_plan: "Could not generate a meal plan",

    manual_override: "Manual goal override",
    daily_calories: "Daily Calories",
    save_manual_goals: "Save Manual Goals",
    goals_saved: "Goals saved",

    who_is_this: "Who's logging?",
    new_person: "New person",
    your_name: "Your name",
    your_name_ph: "e.g. Aleks",
    pin_optional: "4-digit PIN (optional)",
    pin_ph: "····",
    create_profile: "Create Profile",
    enter_pin: "Enter your PIN",
    pin_for: "PIN for {name}",
    unlock: "Unlock",
    wrong_pin: "Wrong PIN, try again",
    back: "Back",
    switch_user: "Switch",
    logged_in_as: "Logged in as {name}",
    name_required: "Enter a name",
    pin_must_be_4_digits: "PIN must be 4 digits",

    welcome_title: "Welcome 👋",
    welcome_body:
      "Hey, I'm Aleks — I built this app myself to track meals with a photo instead of typing everything in by hand. " +
      "It's brand new and still rough around the edges, so if anything breaks, looks off, or you think of something " +
      "it's missing, please tell me. Any bit of feedback genuinely helps — thank you for trying it out!",
    welcome_dismiss: "Got it, let's go",

    logged_kcal: "Logged {kcal} kcal ({confidence} confidence)",
    something_wrong: "Something went wrong",

    settings_title: "Settings",
    change_pin: "Change PIN",
    old_pin: "Current PIN",
    new_pin_optional: "New 4-digit PIN (leave blank to remove)",
    save_pin: "Save PIN",
    reset_today_btn: "Reset Today's Log",
    reset_today_confirm: "Delete everything logged today? This can't be undone.",
    delete_profile_btn: "Delete My Profile",
    delete_profile_confirm: "Delete your profile and everything you've logged? This can't be undone.",
    close: "Close",
    adjust_portions: "Adjust portions (grams)",
    edit_numbers_manually: "Edit numbers manually",
    name_updated: "Name updated",
    pin_updated: "PIN updated",
    pin_removed: "PIN removed",
    wrong_old_pin: "Current PIN is incorrect",
    needs_old_pin: "Enter your current PIN first",
    today_reset: "Today's log has been cleared",
    profile_deleted: "Profile deleted",
    portions_recalculated: "Recalculated from your corrected portions",

    goals_explain:
      "Based on your BMR ({bmr} kcal) via the Mifflin-St Jeor equation, scaled by your activity level " +
      "to a maintenance TDEE of {tdee} kcal, then adjusted {direction} by about {rate}kg/week toward your goal. " +
      "Protein is set high (within the ISSN's recommended 1.6-2.2g/kg range) to preserve lean mass.",
    direction_up: "up",
    direction_down: "down",

    water_title: "Water",
    energy_title: "Energy today",
    energy_no_data: "Log a photo meal to see this",
    add_water_ml: "+{ml}ml",

    photo_review_title: "Review Photo",
    add_another_angle: "+ Add another angle",
    analyze_btn: "Analyze",
    remove_photo: "Remove",
    photo_desc_label: "Anything the AI should know? (optional)",
    photo_desc_placeholder: "e.g. no sugar, half portion, homemade",

    weight_trend_title: "Weight Trend",
    log_weight_btn: "Log",
    no_weight_data: "Log your weight to start tracking your trend.",
    weight_logged_toast: "Weight logged",
    enter_weight_first: "Enter your weight first",

    favorites_title: "Favorites",
    quick_add_btn: "Quick Add",
    save_favorite: "Save as favorite",
    favorite_saved_toast: "Saved to favorites",
    no_favorites_line1: "No favorites yet.",
    no_favorites_line2: "Tap the ☆ on any meal to save it here.",
    logged_from_favorite_toast: "Logged!",
    delete_favorite_confirm: "Remove this favorite?",

    log_this_meal_btn: "Log this",
    logged_from_plan_toast: "Logged from your plan!",

    tip_card_title: "Today's Tip",
    get_tip_btn: "Get a Tip for Today",
    refresh_tip_btn: "Refresh Tip",
    generating_tip: "Thinking…",
    could_not_get_tip: "Could not get a tip right now",

    whats_new_title: "What's New",
    whats_new_btn: "What's new",

    edit_photo_meal: "Photo meal",
    edit_manual_meal: "Manual entry",
    daily_water_ml: "Daily Water (ml)",
  },

  bg: {
    app_name: "Скенер на калории",
    tab_today: "Днес",
    tab_history: "История",
    tab_plan: "План",
    ios_hint: 'Инсталирай приложението: докосни Share, после "Add to Home Screen".',

    kcal_left: "кал. остават",
    eaten: "изядени",
    goal: "цел",
    protein: "Протеин",
    carbs: "Въглехидрати",
    fat: "Мазнини",

    meal_breakfast: "Закуска",
    meal_lunch: "Обяд",
    meal_dinner: "Вечеря",
    meal_snack: "Междинно",

    add_photo: "Снимай",
    manual: "Ръчно",
    analyzing: "Анализира се…",
    no_entries_line1: "Все още няма нищо записано днес.",
    no_entries_line2: "Добави снимка, за да започнеш.",
    low_confidence: "ниска точност",
    edit: "Редактирай",
    delete: "Изтрий",
    delete_confirm: "Изтриване на този запис?",

    manual_entry_title: "Ръчно въвеждане",
    description: "Описание",
    description_ph: "напр. протеинов шейк",
    calories: "Калории",
    protein_g: "Протеин (г)",
    carbs_g: "Въглехидрати (г)",
    fat_g: "Мазнини (г)",
    cancel: "Отказ",
    save: "Запази",
    fill_desc_cals: "Въведи описание и калории",

    edit_entry_title: "Редакция на запис",
    meal_type: "Тип хранене",

    history_title: "Последните 14 дни",

    profile_title: "Твоят профил",
    metric: "Метрична",
    imperial: "Имперска",
    height_cm: "Ръст (см)",
    height_ft: "Ръст (фута)",
    weight_kg: "Тегло (кг)",
    weight_lb: "Тегло (lb)",
    age: "Възраст",
    sex: "Пол",
    sex_male: "Мъж",
    sex_female: "Жена",
    sex_other: "Друго",
    activity_level: "Ниво на активност",
    activity_sedentary: "Заседнал — офис работа, малко движение",
    activity_light: "Леко — тренировки 1-3 дни/седмица",
    activity_moderate: "Умерено — тренировки 3-5 дни/седмица",
    activity_active: "Активно — тежки тренировки 6-7 дни/седмица",
    activity_very_active: "Много активно — физическа работа + тренировки",
    goal_label: "Цел",
    goal_lose: "Отслабване",
    goal_maintain: "Поддържане на тегло",
    goal_gain: "Качване на тегло / мускули",
    dietary_notes: "Хранителни предпочитания / ограничения (по желание)",
    dietary_notes_ph: "напр. вегетарианец, без ядки, високо съдържание на протеин",
    calc_goals_btn: "Изчисли моите цели",
    calculating: "Изчислява се…",
    fill_height_weight_age: "Първо въведи ръст, тегло и възраст",
    could_not_calc: "Целите не можаха да бъдат изчислени",

    suggested_targets: "Препоръчани дневни цели",
    apply_goals_btn: "Приложи тези цели",
    goals_applied: "Целите са приложени — кръгът за днес е обновен",

    ai_meal_plan: "AI хранителен план",
    ai_meal_plan_desc: "Генерира цял ден с хранения, съобразени с текущите ти цели.",
    gen_plan_btn: "Генерирай моя план",
    regen_plan_btn: "Генерирай отново",
    building_plan: "Изгражда се твоят план…",
    plan_ready: "Планът е готов",
    could_not_gen_plan: "Планът не можа да бъде генериран",

    manual_override: "Ръчна промяна на целите",
    daily_calories: "Дневни калории",
    save_manual_goals: "Запази ръчните цели",
    goals_saved: "Целите са запазени",

    who_is_this: "Кой влиза?",
    new_person: "Нов профил",
    your_name: "Твоето име",
    your_name_ph: "напр. Алекс",
    pin_optional: "4-цифрен ПИН (по желание)",
    pin_ph: "····",
    create_profile: "Създай профил",
    enter_pin: "Въведи своя ПИН",
    pin_for: "ПИН за {name}",
    unlock: "Отключи",
    wrong_pin: "Грешен ПИН, опитай отново",
    back: "Назад",
    switch_user: "Смени",
    logged_in_as: "Влязъл като {name}",
    name_required: "Въведи име",
    pin_must_be_4_digits: "ПИН-ът трябва да е 4 цифри",

    welcome_title: "Добре дошъл 👋",
    welcome_body:
      "Здравей, аз съм Алекс — сам направих това приложение, за да следя храненията си със снимка, " +
      "вместо да въвеждам всичко ръчно. Съвсем ново е и има недомислени неща, така че ако нещо се счупи, " +
      "изглежда странно или се сетиш за нещо, което липсва — кажи ми. Всякаква обратна връзка наистина помага — благодаря, че го пробваш!",
    welcome_dismiss: "Разбрах, да започваме",

    logged_kcal: "Записани {kcal} кал. (точност: {confidence})",
    something_wrong: "Нещо се обърка",

    settings_title: "Настройки",
    change_pin: "Смяна на ПИН",
    old_pin: "Текущ ПИН",
    new_pin_optional: "Нов 4-цифрен ПИН (остави празно за премахване)",
    save_pin: "Запази ПИН",
    reset_today_btn: "Изчисти дневника за днес",
    reset_today_confirm: "Да изтрия ли всичко записано днес? Това не може да се отмени.",
    delete_profile_btn: "Изтрий моя профил",
    delete_profile_confirm: "Да изтрия ли профила ти и всичко записано в него? Това не може да се отмени.",
    close: "Затвори",
    adjust_portions: "Коригирай грамажа",
    edit_numbers_manually: "Редактирай числата ръчно",
    name_updated: "Името е обновено",
    pin_updated: "ПИН-ът е обновен",
    pin_removed: "ПИН-ът е премахнат",
    wrong_old_pin: "Текущият ПИН е грешен",
    needs_old_pin: "Първо въведи текущия си ПИН",
    today_reset: "Дневникът за днес е изчистен",
    profile_deleted: "Профилът е изтрит",
    portions_recalculated: "Преизчислено според коригирания грамаж",

    goals_explain:
      "Изчислено на база твоя базов метаболизъм (БМР: {bmr} кал.) чрез уравнението на Mifflin-St Jeor, " +
      "умножен по нивото на активност до поддържащи {tdee} кал. дневно, след което коригирани {direction} " +
      "с около {rate} кг/седмица към целта ти. Протеинът е зададен високо (в препоръчания от ISSN диапазон " +
      "1.6-2.2г/кг) за запазване на мускулната маса.",
    direction_up: "нагоре",
    direction_down: "надолу",

    water_title: "Вода",
    energy_title: "Енергия днес",
    energy_no_data: "Добави снимка на хранене, за да видиш това",
    add_water_ml: "+{ml}мл",

    photo_review_title: "Преглед на снимката",
    add_another_angle: "+ Добави друг ъгъл",
    analyze_btn: "Анализирай",
    remove_photo: "Премахни",
    photo_desc_label: "Нещо, което AI трябва да знае? (по избор)",
    photo_desc_placeholder: "напр. без захар, половин порция, домашно",

    weight_trend_title: "Тегло във времето",
    log_weight_btn: "Запиши",
    no_weight_data: "Запиши теглото си, за да проследяваш тенденцията.",
    weight_logged_toast: "Теглото е записано",
    enter_weight_first: "Първо въведи тегло",

    favorites_title: "Любими",
    quick_add_btn: "Бързо добавяне",
    save_favorite: "Запази като любимо",
    favorite_saved_toast: "Запазено в любими",
    no_favorites_line1: "Все още няма любими.",
    no_favorites_line2: "Докосни ☆ на кое да е хранене, за да го запазиш тук.",
    logged_from_favorite_toast: "Записано!",
    delete_favorite_confirm: "Да премахна ли това любимо?",

    log_this_meal_btn: "Запиши",
    logged_from_plan_toast: "Записано от плана ти!",

    tip_card_title: "Съвет за деня",
    get_tip_btn: "Вземи съвет за деня",
    refresh_tip_btn: "Обнови съвета",
    generating_tip: "Мисли…",
    could_not_get_tip: "Съветът не можа да бъде получен в момента",

    whats_new_title: "Какво ново",
    whats_new_btn: "Какво ново",

    edit_photo_meal: "Хранене от снимка",
    edit_manual_meal: "Ръчен запис",
    daily_water_ml: "Дневна вода (мл)",
  },
};

function t(key, vars) {
  const lang = currentLang();
  let str = (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS.en[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(`{${k}}`, v);
    }
  }
  return str;
}

function currentLang() {
  return localStorage.getItem("lang") || "bg";
}

function applyStaticTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.documentElement.lang = currentLang();
}
