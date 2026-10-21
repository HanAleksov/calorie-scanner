CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin_hash TEXT,                 -- NULL = no PIN; legacy unsalted sha256 hex or "pbkdf2_sha256$..." (see auth.py)
    created_at TEXT NOT NULL,
    pin_failed_count INTEGER NOT NULL DEFAULT 0,   -- consecutive wrong PINs since the last success
    pin_locked_until REAL                          -- epoch seconds; NULL = not locked
);

CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,       -- ISO timestamp
    meal_type TEXT NOT NULL DEFAULT 'snack',  -- breakfast|lunch|dinner|snack
    source TEXT NOT NULL DEFAULT 'photo',     -- photo|manual
    items_json TEXT NOT NULL,       -- raw model output (or manual entry echo)
    total_calories INTEGER,
    protein_g REAL,
    carbs_g REAL,
    fat_g REAL,
    confidence TEXT,
    notes TEXT,
    image_path TEXT,
    image_path2 TEXT,               -- optional second-angle photo
    energy_score REAL,              -- 0-5, "good energy" quality rating, null for manual entries
    eaten_time TEXT                 -- "HH:MM" the user SAID they ate (same day as created_at); NULL = never confirmed
                                    -- (every entry from before this column existed). created_at is only when it was logged.
);

CREATE TABLE IF NOT EXISTS goals (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    calories INTEGER NOT NULL DEFAULT 2200,
    protein_g REAL NOT NULL DEFAULT 120,
    carbs_g REAL NOT NULL DEFAULT 220,
    fat_g REAL NOT NULL DEFAULT 70,
    water_ml INTEGER NOT NULL DEFAULT 2000,
    auto_apply_targets INTEGER NOT NULL DEFAULT 1  -- autonomous analyst engine may write goals directly
);

CREATE TABLE IF NOT EXISTS water_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    logged_at TEXT NOT NULL,
    ml INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_tip (
    user_id INTEGER NOT NULL REFERENCES users(id),
    tip_date TEXT NOT NULL,
    tip_text TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, tip_date)
);

CREATE TABLE IF NOT EXISTS profile (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    height_cm REAL,
    weight_kg REAL,
    age INTEGER,
    sex TEXT,                    -- male|female|other
    activity_level TEXT,         -- sedentary|light|moderate|active|very_active
    goal_type TEXT,              -- lose|maintain|gain
    target_rate_kg_week REAL,
    dietary_notes TEXT
);

CREATE TABLE IF NOT EXISTS meal_plan (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    plan_json TEXT,
    generated_at TEXT
);

CREATE TABLE IF NOT EXISTS weight_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    logged_at TEXT NOT NULL,
    weight_kg REAL NOT NULL,
    fat_mass_kg REAL,      -- optional smart-scale body composition, manually entered
    muscle_mass_kg REAL,
    water_pct REAL
);

CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    meal_type TEXT NOT NULL DEFAULT 'snack',
    items_json TEXT NOT NULL,
    total_calories INTEGER,
    protein_g REAL,
    carbs_g REAL,
    fat_g REAL,
    energy_score REAL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analyst_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    old_calories INTEGER,   -- NULL-equal-to-new_calories rows are informational (no-op) entries
    new_calories INTEGER,
    reason_text TEXT NOT NULL,  -- deterministic, localized fallback — always present
    coach_note TEXT             -- AI-generated "what/why/how" note, only on noteworthy events
);

-- Explicit "this day is (not) a full record" marks. Without a row, completeness is inferred
-- from the entries themselves (see main._day_is_complete).
CREATE TABLE IF NOT EXISTS day_marks (
    user_id INTEGER NOT NULL REFERENCES users(id),
    day TEXT NOT NULL,             -- YYYY-MM-DD
    status TEXT NOT NULL,          -- complete | skip
    PRIMARY KEY (user_id, day)
);

-- Server-side login sessions. The browser holds the random token in an HttpOnly cookie; only its SHA-256
-- is stored here. csrf_token is returned to the page by GET /api/session and must be echoed in the
-- X-CSRF-Token header on every state-changing request.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    csrf_token TEXT NOT NULL,
    created_at REAL NOT NULL,      -- epoch seconds
    last_used_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- The user's chosen eating schedule: up to 6 slots (a meal type at a clock time), in display order. Purely the
-- user's own plan: it drives the Today screen's "next meal" line and the in-app reminders, nothing else.
CREATE TABLE IF NOT EXISTS meal_schedule (
    user_id INTEGER NOT NULL REFERENCES users(id),
    slot INTEGER NOT NULL,         -- 1..6, sorted by time on every save
    meal_type TEXT NOT NULL,       -- breakfast | lunch | dinner | snack
    at_time TEXT NOT NULL,         -- "HH:MM", local (Europe/Sofia) wall-clock time
    PRIMARY KEY (user_id, slot)
);

-- In-app reminders are OFF until the user turns them on (no row = off). lead_min = how many minutes before a slot the
-- open app starts nudging. Reminders only ever show while the app is open (no push / background notifications).
CREATE TABLE IF NOT EXISTS reminder_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    enabled INTEGER NOT NULL DEFAULT 0,
    lead_min INTEGER NOT NULL DEFAULT 15
);
