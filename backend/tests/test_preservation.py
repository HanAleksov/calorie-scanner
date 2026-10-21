"""Upgrading an existing database must keep every existing profile and historical record.

The "before" database is built from the schema as it was before this work
(fixtures/schema_pre_stage1.sql, taken from git history) and filled with invented data of every kind.
Snapshots (per-row SHA-256) are taken BEFORE any behavioural test creates records, then again after the
migration, then after a legacy-PIN login — the only thing allowed to change an existing row.
"""

import hashlib
import json
import sqlite3
from pathlib import Path

import db
from tests.base import AppTestCase
from tools import db_snapshot

LEGACY_SCHEMA = (Path(__file__).parent / "fixtures" / "schema_pre_stage1.sql").read_text(encoding="utf-8")


def legacy_hash(pin):
    return hashlib.sha256(f"calorie-scanner:{pin}".encode()).hexdigest()


class PreservationTests(AppTestCase):
    def build_pre_stage1_database(self) -> Path:
        path = self.tmp / "pre.db"
        conn = sqlite3.connect(path)
        conn.executescript(LEGACY_SCHEMA)
        conn.executemany("INSERT INTO users (id, name, pin_hash, created_at) VALUES (?,?,?,?)", [
            (1, "Ана", legacy_hash("1234"), "2026-07-31T09:00:00"),
            (2, "Боян", None, "2026-08-02T10:00:00"),
            (3, "Вили", legacy_hash("0000"), "2026-09-09T12:37:46"),
        ])
        conn.executemany("INSERT INTO goals (user_id, calories, protein_g, carbs_g, fat_g, water_ml, auto_apply_targets) VALUES (?,?,?,?,?,?,?)", [
            (1, 2780, 140, 410, 62, 2500, 1), (2, 2200, 120, 220, 70, 2000, 0), (3, 1800, 110, 150, 55, 2200, 1)])
        conn.executemany("INSERT INTO profile (user_id, height_cm, weight_kg, age, sex, activity_level, goal_type, target_rate_kg_week, dietary_notes) VALUES (?,?,?,?,?,?,?,?,?)", [
            (1, 178.0, 65.0, 24, "male", "moderate", "gain", None, ""),
            (2, 170, 80, 40, "other", "light", "maintain", 0, "без глутен"),
            (3, 165, 70, 33, "female", "sedentary", "lose", -0.45, None)])
        for i in range(12):
            conn.execute("INSERT INTO entries (user_id, created_at, meal_type, source, items_json, total_calories, protein_g, carbs_g, fat_g, confidence, notes, image_path, image_path2, energy_score) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         (1 + i % 3, f"2026-10-{1 + i:02d}T12:00:00", ("breakfast", "lunch", "dinner", "snack")[i % 4], "photo" if i % 2 else "manual",
                          json.dumps([{"name": f"ястие {i}", "est_grams": 100 + i, "calories": 300 + i}], ensure_ascii=False),
                          300 + i * 11, 10 + i, 30 + i, 5 + i, "high", "бележка" if i % 5 == 0 else None,
                          f"photo{i}.jpg" if i % 2 else None, f"photo{i}b.jpg" if i % 4 == 1 else None, 3.5 if i % 2 else None))
        conn.executemany("INSERT INTO water_log (user_id, logged_at, ml) VALUES (?,?,?)", [(1, "2026-10-01T09:00:00", 250), (1, "2026-10-01T15:00:00", 500), (2, "2026-10-02T09:00:00", 300)])
        conn.execute("INSERT INTO daily_tip (user_id, tip_date, tip_text, generated_at) VALUES (1, '2026-10-01', 'пий вода', '2026-10-01T08:00:00')")
        conn.execute("INSERT INTO meal_plan (user_id, plan_json, generated_at) VALUES (1, ?, '2026-09-10T10:53:25')", (json.dumps({"meals": [{"name": "каша"}]}, ensure_ascii=False),))
        for i, (w, fat) in enumerate([(68.0, 11.2), (69.1, 11.7), (69.8, 11.9), (70.4, 12.1)]):
            conn.execute("INSERT INTO weight_log (user_id, logged_at, weight_kg, fat_mass_kg, muscle_mass_kg, water_pct) VALUES (1,?,?,?,?,?)",
                         (f"2026-09-{9 + i * 4:02d}T12:00:00", w, fat, 29.1 + i * 0.3, 54.6 - i * 0.2))
        conn.execute("INSERT INTO favorites (user_id, name, meal_type, items_json, total_calories, protein_g, carbs_g, fat_g, energy_score, created_at) VALUES (1,'Овесени ядки','breakfast','[]',420,15,70,8,4.0,'2026-09-12T08:00:00')")
        conn.executemany("INSERT INTO analyst_logs (user_id, created_at, old_calories, new_calories, reason_text, coach_note) VALUES (?,?,?,?,?,?)", [
            (1, "2026-03-12T10:05:00", 2880, 2780, "причина", "бележка от треньора"), (1, "2026-03-12T10:05:31", 2780, 2780, "без промяна", None)])
        conn.executemany("INSERT INTO day_marks (user_id, day, status) VALUES (?,?,?)", [(1, "2026-10-08", "complete"), (1, "2026-10-03", "skip")])
        conn.commit()
        conn.close()
        return path

    def setUp(self):
        super().setUp()
        self.pre = self.build_pre_stage1_database()
        self.before = db_snapshot.snapshot(self.pre, with_rows=True)     # taken before anything else touches it
        db.DB_PATH = self.pre
        db.init_db()                                                     # the startup migration, on the old file
        self.after_migration = db_snapshot.snapshot(self.pre, with_rows=True)

    def test_the_before_snapshot_really_is_the_old_shape(self):
        self.assertNotIn("sessions", self.before["tables"])
        self.assertNotIn("pin_failed_count", self.before["tables"]["users"]["columns"])
        self.assertEqual(self.before["tables"]["entries"]["count"], 12)

    def test_migration_keeps_every_existing_row_unchanged(self):
        report = db_snapshot.compare(self.before, self.after_migration, allow_new_tables={"sessions"})
        self.assertTrue(report["identical"], report)
        self.assertTrue(any("users: new columns" in n for n in report["notes"]))
        self.assertEqual(self.after_migration["tables"]["sessions"]["count"], 0)

    def test_the_only_schema_changes_are_the_allowed_ones(self):
        added_tables = set(self.after_migration["tables"]) - set(self.before["tables"])
        self.assertEqual(added_tables, {"sessions"})
        for table, entry in self.before["tables"].items():
            new_cols = [c for c in self.after_migration["tables"][table]["columns"] if c not in entry["columns"]]
            self.assertEqual(new_cols, ["pin_failed_count", "pin_locked_until"] if table == "users" else [], table)

    def test_current_targets_and_flags_survive(self):
        g = self.rows("SELECT * FROM goals WHERE user_id=1")[0]
        self.assertEqual((g["calories"], g["protein_g"], g["carbs_g"], g["fat_g"], g["water_ml"], g["auto_apply_targets"]),
                         (2780, 140, 410, 62, 2500, 1))
        self.assertEqual(self.rows("SELECT auto_apply_targets FROM goals WHERE user_id=2")[0]["auto_apply_targets"], 0)

    def test_running_the_migration_again_is_a_no_op(self):
        db.init_db()
        report = db_snapshot.compare(self.after_migration, db_snapshot.snapshot(self.pre, with_rows=True))
        self.assertTrue(report["identical"], report)

    def test_legacy_pin_login_rewrites_only_that_users_hash_and_nothing_else(self):
        c = self.new_client()
        for uid, pin in ((1, "1234"), (2, None)):                         # Ана has a legacy PIN, Боян has none
            body = {"user_id": uid, **({"pin": pin} if pin else {})}
            self.assertEqual(c.post("/api/session", json=body).status_code, 200)
        after_login = db_snapshot.snapshot(self.pre, with_rows=True)
        # without allowing the hash to change, the comparison must notice the upgrade ...
        self.assertFalse(db_snapshot.compare(self.before, after_login, allow_new_tables={"sessions"})["identical"])
        # ... and with exactly that one column allowed, everything else is identical (sessions are new rows)
        report = db_snapshot.compare(self.before, after_login, allow_new_tables={"sessions"},
                                     allow_changed=["users.pin_hash"])
        self.assertTrue(report["identical"], report)
        hashes = {r["id"]: r["pin_hash"] for r in self.rows("SELECT id, pin_hash FROM users")}
        self.assertTrue(hashes[1].startswith("pbkdf2_sha256$"))
        self.assertEqual(hashes[3], legacy_hash("0000"))                  # never logged in: untouched
        self.assertIsNone(hashes[2])
        # Ана's same PIN still opens her profile afterwards
        self.assertEqual(self.new_client().post("/api/session", json={"user_id": 1, "pin": "1234"}).status_code, 200)

    def test_a_failed_login_changes_no_existing_data(self):
        self.new_client().post("/api/session", json={"user_id": 1, "pin": "9999"})
        report = db_snapshot.compare(self.before, db_snapshot.snapshot(self.pre, with_rows=True),
                                     allow_new_tables={"sessions"}, allow_changed=["users.pin_failed_count"])
        self.assertTrue(report["identical"], report)

    def test_the_comparison_tool_does_catch_changes(self):
        with db.get_conn() as conn:
            conn.execute("UPDATE goals SET calories = 2924 WHERE user_id = 1")
            conn.execute("DELETE FROM weight_log WHERE id = 2")
        report = db_snapshot.compare(self.before, db_snapshot.snapshot(self.pre, with_rows=True), allow_new_tables={"sessions"})
        self.assertFalse(report["identical"])
        self.assertTrue(any(p.startswith("goals:") for p in report["problems"]))
        self.assertTrue(any(p.startswith("weight_log:") for p in report["problems"]))

    def test_behaviour_after_the_migration_is_ordinary(self):
        """Only now do tests create records (after all comparisons above had their own snapshots)."""
        c = self.signed_in_client(1, "1234")
        self.assertEqual(c.get("/api/goals").json()["calories"], 2780)
        self.assertEqual(len(c.get("/api/weight").json()["entries"]), 4)
        self.assertEqual(c.get("/api/analyst/logs").json()["logs"][0]["new_calories"], 2780)
        self.assertEqual(c.get("/api/favorites").json()["favorites"][0]["name"], "Овесени ядки")
        self.assertEqual(c.get("/api/meal-plan").json()["meals"][0]["name"], "каша")
