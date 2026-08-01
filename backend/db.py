import hashlib
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

import tzutil

BACKEND_DIR = Path(__file__).parent
DB_PATH = Path(os.environ.get("CALORIE_DB_PATH", BACKEND_DIR / "calorie_scanner.db"))
SCHEMA_PATH = BACKEND_DIR / "schema.sql"

DEFAULT_LEGACY_USER_NAME = "Aleks"
DEFAULT_GOALS = {"calories": 2200, "protein_g": 120, "carbs_g": 220, "fat_g": 70}


def init_db() -> None:
    with get_conn() as conn:
        _migrate(conn)


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# ---------- schema migration (singleton tables -> per-user tables) ----------

def _table_exists(conn, table: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def _table_columns(conn, table: str) -> set:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def _migrate(conn) -> None:
    # entries: pre-existing installs lack user_id — add it as a plain nullable column
    if _table_exists(conn, "entries") and "user_id" not in _table_columns(conn, "entries"):
        conn.execute("ALTER TABLE entries ADD COLUMN user_id INTEGER")

    if _table_exists(conn, "entries"):
        entry_cols = _table_columns(conn, "entries")
        if "image_path2" not in entry_cols:
            conn.execute("ALTER TABLE entries ADD COLUMN image_path2 TEXT")
        if "energy_score" not in entry_cols:
            conn.execute("ALTER TABLE entries ADD COLUMN energy_score REAL")

    if _table_exists(conn, "goals") and "water_ml" not in _table_columns(conn, "goals"):
        conn.execute("ALTER TABLE goals ADD COLUMN water_ml INTEGER NOT NULL DEFAULT 2000")

    # goals/profile/meal_plan changed primary key from a hardcoded id=1 to user_id —
    # that's a PK shape change SQLite can't ALTER in place, so move the old table
    # aside and let schema.sql create the new shape fresh.
    for table in ("goals", "profile", "meal_plan"):
        if _table_exists(conn, table) and "user_id" not in _table_columns(conn, table):
            conn.execute(f"ALTER TABLE {table} RENAME TO {table}_legacy")

    conn.executescript(SCHEMA_PATH.read_text())

    has_orphaned_entries = conn.execute(
        "SELECT COUNT(*) c FROM entries WHERE user_id IS NULL"
    ).fetchone()["c"] > 0
    legacy_tables = [t for t in ("goals", "profile", "meal_plan") if _table_exists(conn, f"{t}_legacy")]

    if not (has_orphaned_entries or legacy_tables):
        return

    default_user = conn.execute(
        "SELECT id FROM users WHERE name = ?", (DEFAULT_LEGACY_USER_NAME,)
    ).fetchone()
    if default_user:
        default_id = default_user["id"]
    else:
        default_id = create_user(conn, DEFAULT_LEGACY_USER_NAME, pin=None)["id"]

    if has_orphaned_entries:
        conn.execute("UPDATE entries SET user_id = ? WHERE user_id IS NULL", (default_id,))

    for table in legacy_tables:
        legacy = f"{table}_legacy"
        cols = sorted(_table_columns(conn, legacy) - {"id"})
        row = conn.execute(f"SELECT * FROM {legacy} WHERE id = 1").fetchone()
        if row:
            col_list = ", ".join(cols)
            placeholders = ", ".join("?" for _ in cols)
            values = [row[c] for c in cols]
            conn.execute(
                f"INSERT OR REPLACE INTO {table} (user_id, {col_list}) VALUES (?, {placeholders})",
                [default_id, *values],
            )
        conn.execute(f"DROP TABLE {legacy}")


# ---------- users ----------

def _hash_pin(pin: str) -> str:
    return hashlib.sha256(f"calorie-scanner:{pin}".encode()).hexdigest()


def create_user(conn, name: str, pin: str | None = None) -> dict:
    cur = conn.execute(
        "INSERT INTO users (name, pin_hash, created_at) VALUES (?, ?, ?)",
        (name, _hash_pin(pin) if pin else None, tzutil.now_local_naive().isoformat(timespec="seconds")),
    )
    user_id = cur.lastrowid
    conn.execute(
        "INSERT INTO goals (user_id, calories, protein_g, carbs_g, fat_g) VALUES (?, ?, ?, ?, ?)",
        (user_id, DEFAULT_GOALS["calories"], DEFAULT_GOALS["protein_g"],
         DEFAULT_GOALS["carbs_g"], DEFAULT_GOALS["fat_g"]),
    )
    conn.execute("INSERT INTO profile (user_id) VALUES (?)", (user_id,))
    conn.execute("INSERT INTO meal_plan (user_id) VALUES (?)", (user_id,))
    return get_user(conn, user_id)


def get_user(conn, user_id: int) -> dict | None:
    row = conn.execute("SELECT id, name, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def list_users(conn) -> list:
    rows = conn.execute(
        "SELECT id, name, (pin_hash IS NOT NULL) AS has_pin FROM users ORDER BY name COLLATE NOCASE"
    ).fetchall()
    return [dict(r) for r in rows]


def verify_pin(conn, user_id: int, pin: str) -> bool:
    row = conn.execute("SELECT pin_hash FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return False
    if row["pin_hash"] is None:
        return True  # no PIN set — open access
    return row["pin_hash"] == _hash_pin(pin)


def user_has_pin(conn, user_id: int) -> bool:
    row = conn.execute("SELECT pin_hash FROM users WHERE id = ?", (user_id,)).fetchone()
    return bool(row and row["pin_hash"] is not None)


def rename_user(conn, user_id: int, name: str) -> dict:
    conn.execute("UPDATE users SET name = ? WHERE id = ?", (name, user_id))
    return get_user(conn, user_id)


def set_pin(conn, user_id: int, new_pin: str | None) -> None:
    conn.execute(
        "UPDATE users SET pin_hash = ? WHERE id = ?",
        (_hash_pin(new_pin) if new_pin else None, user_id),
    )


def delete_user(conn, user_id: int) -> None:
    conn.execute("DELETE FROM entries WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM goals WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM profile WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM meal_plan WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM water_log WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM daily_tip WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


def get_image_paths_for_user(conn, user_id: int) -> list:
    rows = conn.execute("SELECT image_path, image_path2 FROM entries WHERE user_id = ?", (user_id,)).fetchall()
    paths = []
    for r in rows:
        if r["image_path"]:
            paths.append(r["image_path"])
        if r["image_path2"]:
            paths.append(r["image_path2"])
    return paths


def delete_entries_for_date(conn, user_id: int, date_str: str) -> list:
    rows = conn.execute(
        "SELECT image_path, image_path2 FROM entries WHERE user_id = ? AND substr(created_at, 1, 10) = ?",
        (user_id, date_str),
    ).fetchall()
    conn.execute(
        "DELETE FROM entries WHERE user_id = ? AND substr(created_at, 1, 10) = ?",
        (user_id, date_str),
    )
    delete_water_for_date(conn, user_id, date_str)
    conn.execute("DELETE FROM daily_tip WHERE user_id = ? AND tip_date = ?", (user_id, date_str))
    paths = []
    for r in rows:
        if r["image_path"]:
            paths.append(r["image_path"])
        if r["image_path2"]:
            paths.append(r["image_path2"])
    return paths


# ---------- entries ----------

def insert_entry(conn, *, user_id, created_at, meal_type, source, items_json,
                  total_calories, protein_g, carbs_g, fat_g, confidence,
                  notes=None, image_path=None, image_path2=None, energy_score=None):
    cur = conn.execute(
        """INSERT INTO entries
           (user_id, created_at, meal_type, source, items_json, total_calories,
            protein_g, carbs_g, fat_g, confidence, notes, image_path, image_path2, energy_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (user_id, created_at, meal_type, source, items_json, total_calories,
         protein_g, carbs_g, fat_g, confidence, notes, image_path, image_path2, energy_score),
    )
    return get_entry(conn, user_id, cur.lastrowid)


def get_entry(conn, user_id: int, entry_id: int):
    row = conn.execute(
        "SELECT * FROM entries WHERE id = ? AND user_id = ?", (entry_id, user_id)
    ).fetchone()
    return dict(row) if row else None


def get_entries_for_date(conn, user_id: int, date_str: str):
    rows = conn.execute(
        """SELECT * FROM entries WHERE user_id = ? AND substr(created_at, 1, 10) = ?
           ORDER BY created_at ASC""",
        (user_id, date_str),
    ).fetchall()
    return [dict(r) for r in rows]


def get_entries_between(conn, user_id: int, start_date: str, end_date: str):
    rows = conn.execute(
        """SELECT * FROM entries
           WHERE user_id = ? AND substr(created_at, 1, 10) BETWEEN ? AND ?
           ORDER BY created_at ASC""",
        (user_id, start_date, end_date),
    ).fetchall()
    return [dict(r) for r in rows]


def update_entry(conn, user_id: int, entry_id: int, fields: dict):
    if not fields:
        return get_entry(conn, user_id, entry_id)
    columns = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [entry_id, user_id]
    conn.execute(f"UPDATE entries SET {columns} WHERE id = ? AND user_id = ?", values)
    return get_entry(conn, user_id, entry_id)


def delete_entry(conn, user_id: int, entry_id: int):
    conn.execute("DELETE FROM entries WHERE id = ? AND user_id = ?", (entry_id, user_id))


# ---------- goals ----------

def get_goals(conn, user_id: int):
    row = conn.execute("SELECT * FROM goals WHERE user_id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def set_goals(conn, user_id: int, *, calories, protein_g, carbs_g, fat_g, water_ml=None):
    if water_ml is None:
        existing = get_goals(conn, user_id)
        water_ml = existing["water_ml"] if existing else 2000
    conn.execute(
        """INSERT INTO goals (user_id, calories, protein_g, carbs_g, fat_g, water_ml) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET calories = excluded.calories,
               protein_g = excluded.protein_g, carbs_g = excluded.carbs_g, fat_g = excluded.fat_g,
               water_ml = excluded.water_ml""",
        (user_id, calories, protein_g, carbs_g, fat_g, water_ml),
    )
    return get_goals(conn, user_id)


# ---------- water ----------

def add_water(conn, user_id: int, ml: int, logged_at: str) -> int:
    conn.execute(
        "INSERT INTO water_log (user_id, logged_at, ml) VALUES (?, ?, ?)",
        (user_id, logged_at, ml),
    )
    return get_water_total_for_date(conn, user_id, logged_at[:10])


def get_water_total_for_date(conn, user_id: int, date_str: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(ml), 0) AS total FROM water_log WHERE user_id = ? AND substr(logged_at, 1, 10) = ?",
        (user_id, date_str),
    ).fetchone()
    return row["total"]


def delete_water_for_date(conn, user_id: int, date_str: str) -> None:
    conn.execute(
        "DELETE FROM water_log WHERE user_id = ? AND substr(logged_at, 1, 10) = ?",
        (user_id, date_str),
    )


# ---------- daily tip ----------

def get_daily_tip(conn, user_id: int, date_str: str):
    row = conn.execute(
        "SELECT * FROM daily_tip WHERE user_id = ? AND tip_date = ?", (user_id, date_str)
    ).fetchone()
    return dict(row) if row else None


def set_daily_tip(conn, user_id: int, date_str: str, tip_text: str, generated_at: str) -> dict:
    conn.execute(
        """INSERT INTO daily_tip (user_id, tip_date, tip_text, generated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, tip_date) DO UPDATE SET tip_text = excluded.tip_text,
                                                          generated_at = excluded.generated_at""",
        (user_id, date_str, tip_text, generated_at),
    )
    return get_daily_tip(conn, user_id, date_str)


# ---------- profile ----------

def get_profile(conn, user_id: int):
    row = conn.execute("SELECT * FROM profile WHERE user_id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def set_profile(conn, user_id: int, fields: dict):
    conn.execute("INSERT OR IGNORE INTO profile (user_id) VALUES (?)", (user_id,))
    if fields:
        columns = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [user_id]
        conn.execute(f"UPDATE profile SET {columns} WHERE user_id = ?", values)
    return get_profile(conn, user_id)


# ---------- meal plan ----------

def get_meal_plan(conn, user_id: int):
    row = conn.execute("SELECT * FROM meal_plan WHERE user_id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def set_meal_plan(conn, user_id: int, *, plan_json, generated_at):
    conn.execute(
        """INSERT INTO meal_plan (user_id, plan_json, generated_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET plan_json = excluded.plan_json,
                                               generated_at = excluded.generated_at""",
        (user_id, plan_json, generated_at),
    )
    return get_meal_plan(conn, user_id)
