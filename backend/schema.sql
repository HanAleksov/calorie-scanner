CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    image_path TEXT
);

CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    calories INTEGER NOT NULL DEFAULT 2200,
    protein_g REAL NOT NULL DEFAULT 120,
    carbs_g REAL NOT NULL DEFAULT 220,
    fat_g REAL NOT NULL DEFAULT 70
);

INSERT OR IGNORE INTO goals (id, calories, protein_g, carbs_g, fat_g)
VALUES (1, 2200, 120, 220, 70);

CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    height_cm REAL,
    weight_kg REAL,
    age INTEGER,
    sex TEXT,                    -- male|female|other
    activity_level TEXT,         -- sedentary|light|moderate|active|very_active
    goal_type TEXT,              -- lose|maintain|gain
    target_rate_kg_week REAL,
    dietary_notes TEXT
);

INSERT OR IGNORE INTO profile (id) VALUES (1);

CREATE TABLE IF NOT EXISTS meal_plan (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    plan_json TEXT,
    generated_at TEXT
);
