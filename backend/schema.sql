CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin_hash TEXT,
    created_at TEXT NOT NULL
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
    energy_score REAL               -- 0-5, "good energy" quality rating, null for manual entries
);

CREATE TABLE IF NOT EXISTS goals (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    calories INTEGER NOT NULL DEFAULT 2200,
    protein_g REAL NOT NULL DEFAULT 120,
    carbs_g REAL NOT NULL DEFAULT 220,
    fat_g REAL NOT NULL DEFAULT 70,
    water_ml INTEGER NOT NULL DEFAULT 2000
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
