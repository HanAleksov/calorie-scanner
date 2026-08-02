const CURRENT_APP_VERSION = 5;

const WHATS_NEW = [
  {
    version: 5,
    en: [
      "⚖️ Weight tracking — log your weight on the History tab and watch your trend over time.",
      "⭐ Favorites — save any meal with a tap, then quick-add it again later without re-photographing or re-typing anything.",
      "📋 Log straight from your AI meal plan — tap \"Log this\" on any planned meal to add it to today with one tap.",
    ],
    bg: [
      "⚖️ Проследяване на тегло — запиши теглото си в раздел История и следи тенденцията си във времето.",
      "⭐ Любими — запази кое да е хранене с едно докосване, после го добави отново само с едно докосване, без нова снимка или писане.",
      "📋 Записвай директно от твоя AI хранителен план — докосни „Запиши“ на кое да е планирано хранене, за да го добавиш към деня с едно докосване.",
    ],
  },
  {
    version: 4,
    en: [
      "💧 Remove water — a -250ml button, for when you tap +250 by mistake.",
      "🌡️ Smarter water goal — your suggested daily water now factors in your activity level and Sofia's summer heat, not just bodyweight.",
      "📝 Photo notes — add a quick note (e.g. \"no sugar\", \"half portion\") before analyzing a photo, to help the AI estimate more accurately.",
    ],
    bg: [
      "💧 Премахване на вода — бутон -250мл, за когато натиснеш +250 по грешка.",
      "🌡️ По-умна цел за вода — препоръчаната дневна вода вече взима предвид активността ти и лятната жега в София, не само теглото.",
      "📝 Бележки към снимка — добави кратка бележка (напр. \"без захар\", \"половин порция\") преди анализ на снимка, за по-точна оценка от AI.",
    ],
  },
  {
    version: 3,
    en: [
      "⚡ Energy score — every photo-logged meal now gets a 0-5 rating for how sustained vs. spike-and-crash its energy is, plus a running average for today.",
      "💧 Water tracking — quick +250ml/+500ml buttons on the Today tab.",
      "📷 Second photo angle — add a second photo of the same meal for a more accurate estimate.",
      "💡 Daily tip — a short, time-aware AI tip based on how your day's going so far.",
      "🕐 Fixed the clock — the app now uses Sofia time, not the server's.",
    ],
    bg: [
      "⚡ Енергийна оценка — всяко хранене от снимка вече получава оценка 0-5 доколко е \"добра\" (устойчива) енергия, плюс среден резултат за деня.",
      "💧 Проследяване на вода — бързи бутони +250мл/+500мл в раздел Днес.",
      "📷 Втори ъгъл на снимката — добави втора снимка на същото хранене за по-точна оценка.",
      "💡 Съвет за деня — кратък AI съвет, съобразен с часа и напредъка ти през деня.",
      "🕐 Оправен часовник — приложението вече използва часа в София, не на сървъра.",
    ],
  },
  {
    version: 2,
    en: [
      "👤 Multiple profiles — each person gets their own log, goals, and meal plan, with an optional PIN.",
      "🇧🇬 Bulgarian language — switchable anytime, including AI-generated meal plans and photo descriptions.",
      "✏️ Editable portions — correct a photo's estimated grams and calories/macros recalculate automatically.",
      "⚙️ Settings — rename yourself, change your PIN, reset today's log, or delete your profile.",
    ],
    bg: [
      "👤 Множество профили — всеки има свой дневник, цели и хранителен план, с незадължителен ПИН.",
      "🇧🇬 Български език — превключваем по всяко време, включително AI хранителни планове и описания на снимки.",
      "✏️ Редактируем грамаж — коригирай грамажа от снимка и калориите/макросите се преизчисляват автоматично.",
      "⚙️ Настройки — смени си името, ПИН-а, изчисти дневника за деня или изтрий профила си.",
    ],
  },
];
