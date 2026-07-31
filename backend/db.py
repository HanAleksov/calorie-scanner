import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

BACKEND_DIR = Path(__file__).parent
DB_PATH = Path(os.environ.get("CALORIE_DB_PATH", BACKEND_DIR / "calorie_scanner.db"))
SCHEMA_PATH = BACKEND_DIR / "schema.sql"


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA_PATH.read_text())


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


def insert_entry(conn, *, created_at, meal_type, source, items_json,
                  total_calories, protein_g, carbs_g, fat_g, confidence,
                  notes=None, image_path=None):
    cur = conn.execute(
        """INSERT INTO entries
           (created_at, meal_type, source, items_json, total_calories,
            protein_g, carbs_g, fat_g, confidence, notes, image_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (created_at, meal_type, source, items_json, total_calories,
         protein_g, carbs_g, fat_g, confidence, notes, image_path),
    )
    return get_entry(conn, cur.lastrowid)


def get_entry(conn, entry_id: int):
    row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    return dict(row) if row else None


def get_entries_for_date(conn, date_str: str):
    rows = conn.execute(
        "SELECT * FROM entries WHERE substr(created_at, 1, 10) = ? ORDER BY created_at ASC",
        (date_str,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_entries_between(conn, start_date: str, end_date: str):
    rows = conn.execute(
        """SELECT * FROM entries
           WHERE substr(created_at, 1, 10) BETWEEN ? AND ?
           ORDER BY created_at ASC""",
        (start_date, end_date),
    ).fetchall()
    return [dict(r) for r in rows]


def update_entry(conn, entry_id: int, fields: dict):
    if not fields:
        return get_entry(conn, entry_id)
    columns = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [entry_id]
    conn.execute(f"UPDATE entries SET {columns} WHERE id = ?", values)
    return get_entry(conn, entry_id)


def delete_entry(conn, entry_id: int):
    conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))


def get_goals(conn):
    row = conn.execute("SELECT * FROM goals WHERE id = 1").fetchone()
    return dict(row) if row else None


def set_goals(conn, *, calories, protein_g, carbs_g, fat_g):
    conn.execute(
        """UPDATE goals SET calories = ?, protein_g = ?, carbs_g = ?, fat_g = ?
           WHERE id = 1""",
        (calories, protein_g, carbs_g, fat_g),
    )
    return get_goals(conn)


def get_profile(conn):
    row = conn.execute("SELECT * FROM profile WHERE id = 1").fetchone()
    return dict(row) if row else None


def set_profile(conn, fields: dict):
    if not fields:
        return get_profile(conn)
    columns = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values())
    conn.execute(f"UPDATE profile SET {columns} WHERE id = 1", values)
    return get_profile(conn)


def get_meal_plan(conn):
    row = conn.execute("SELECT * FROM meal_plan WHERE id = 1").fetchone()
    return dict(row) if row else None


def set_meal_plan(conn, *, plan_json, generated_at):
    conn.execute(
        """INSERT INTO meal_plan (id, plan_json, generated_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET plan_json = excluded.plan_json,
                                          generated_at = excluded.generated_at""",
        (plan_json, generated_at),
    )
    return get_meal_plan(conn)
