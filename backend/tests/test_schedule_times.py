"""The time a meal was eaten (separate from when it was logged) and the user's eating schedule + in-app reminder switch.

Rules pinned here:
* upgrading the real (Stage 1) database changes no existing cell; old entries get NO eaten time (never "confirmed");
* an eaten time is only ever what the user said: absent stays NULL, a bad or future time is a 422 and stores nothing;
* editing without sending the key leaves the stored value alone, sending null clears it;
* the schedule is validated completely before anything is written, and belongs to the signed-in profile only;
* reminders are OFF until switched on.
"""

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from unittest import mock

import db
import tzutil
import vision
from tests.base import AppTestCase
from tools import db_snapshot

STAGE1_SCHEMA = (Path(__file__).parent / "fixtures" / "schema_stage1.sql").read_text(encoding="utf-8")


def at(hour, minute=0, day=(2026, 10, 22)):
    """Pins the app's wall clock (Sofia) for the duration of a `with` block."""
    fixed = datetime(*day, hour, minute, tzinfo=tzutil.APP_TZ)
    return mock.patch.object(tzutil, "now_local", lambda: fixed)


class StageOneUpgradeTests(AppTestCase):
    def build_stage1_database(self) -> Path:
        path = self.tmp / "stage1.db"
        conn = sqlite3.connect(path)
        conn.executescript(STAGE1_SCHEMA)
        conn.execute("INSERT INTO users (id, name, pin_hash, created_at) VALUES (1, 'Ана', NULL, '2026-07-31T09:00:00')")
        conn.execute("INSERT INTO users (id, name, pin_hash, created_at) VALUES (2, 'Боян', 'pbkdf2_sha256$1$aa$bb', '2026-08-02T10:00:00')")
        for i in range(6):
            conn.execute(
                "INSERT INTO entries (user_id, created_at, meal_type, source, items_json, total_calories, protein_g, carbs_g, fat_g, confidence, notes, image_path, image_path2, energy_score) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (1 + i % 2, f"2026-10-{10 + i:02d}T13:{i:02d}:00", ("breakfast", "lunch", "dinner")[i % 3], "manual",
                 json.dumps([{"name": f"ястие {i}"}], ensure_ascii=False), 400 + i, 20, 40, 10, "manual", None, None, None, None))
        conn.commit()
        conn.close()
        return path

    def test_upgrade_adds_the_column_and_tables_and_changes_no_existing_cell(self):
        path = self.build_stage1_database()
        before = db_snapshot.snapshot(path)
        self.assertNotIn("eaten_time", before["tables"]["entries"]["columns"])
        db.DB_PATH = path
        db.init_db()
        after = db_snapshot.snapshot(path)
        report = db_snapshot.compare(before, after, allow_new_tables={"meal_schedule", "reminder_settings"},
                                     allow_new_columns=["entries.eaten_time"])
        self.assertTrue(report["identical"], report)
        self.assertEqual({r["eaten_time"] for r in self.rows("SELECT eaten_time FROM entries")}, {None})
        self.assertEqual(after["tables"]["meal_schedule"]["count"], 0)
        again = db_snapshot.compare(after, db_snapshot.snapshot(path))      # a second start is a no-op
        self.assertTrue(again["identical"], again)

    def test_the_comparison_refuses_the_new_column_unless_it_is_named(self):
        path = self.build_stage1_database()
        before = db_snapshot.snapshot(path)
        db.DB_PATH = path
        db.init_db()
        report = db_snapshot.compare(before, db_snapshot.snapshot(path), allow_new_tables={"meal_schedule", "reminder_settings"})
        self.assertFalse(report["identical"])
        self.assertTrue(any("entries.eaten_time" in p for p in report["problems"]))

    def test_old_entries_stay_unconfirmed_in_the_api(self):
        path = self.build_stage1_database()
        db.DB_PATH = path
        db.init_db()
        c = self.signed_in_client(1)
        with db.get_conn() as conn:       # an old entry dated today, like the production data would have
            conn.execute("UPDATE entries SET created_at = ? WHERE id = 1", (tzutil.now_local_naive().isoformat(timespec="seconds"),))
        body = c.get("/api/today").json()
        self.assertEqual([e["eaten_time"] for e in body["entries"]], [None])
        self.assertTrue(body["entries"][0]["created_at"])        # the logged time is still there, untouched


class EatenTimeTests(AppTestCase):
    def setUp(self):
        super().setUp()
        self.uid = self.make_user("Ана")
        self.c = self.signed_in_client(self.uid)

    def manual(self, **extra):
        data = {"meal_type": "lunch", "description": "Салата", "total_calories": "300", "protein_g": "10", "carbs_g": "20", "fat_g": "5", **extra}
        return self.call(self.c, "POST", "/api/log-manual", data=data)

    def test_no_time_given_stays_null(self):
        with at(14, 30):
            r = self.manual()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["eaten_time"])

    def test_a_given_time_is_stored_zero_padded_and_separate_from_the_logged_time(self):
        with at(14, 30):
            r = self.manual(eaten_time="8:05")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["eaten_time"], "08:05")
        self.assertEqual(r.json()["created_at"][11:16], "14:30")

    def test_the_current_minute_is_allowed_a_later_one_is_not_and_stores_nothing(self):
        with at(14, 30):
            self.assertEqual(self.manual(eaten_time="14:30").status_code, 200)
            r = self.manual(eaten_time="14:31")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["detail"]["code"], "in_future")
        self.assertEqual(r.json()["detail"]["field"], "eaten_time")
        self.assertEqual(len(self.rows("SELECT id FROM entries")), 1)

    def test_garbage_times_are_rejected(self):
        with at(23, 0):
            for bad in ("25:00", "12:60", "noon", "12", "12:5", "1230", "12:30:99"):
                r = self.manual(eaten_time=bad)
                self.assertEqual(r.status_code, 422, bad)
                self.assertEqual(r.json()["detail"]["code"], "invalid_time", bad)
        self.assertEqual(self.rows("SELECT id FROM entries"), [])

    def test_a_photo_entry_keeps_the_time_and_a_bad_one_is_refused_before_the_paid_analysis(self):
        calls = []

        def fake(images, lang="en", user_note=None):
            calls.append(1)
            return {"items": [{"name": "Test", "est_grams": 100, "calories": 200, "protein_g": 5, "carbs_g": 20, "fat_g": 4}],
                    "total_calories": 200, "protein_g": 5, "carbs_g": 20, "fat_g": 4, "confidence": "high", "energy_score": 3.0}

        files = {"image": ("a.jpg", self.jpeg_bytes(), "image/jpeg")}
        with mock.patch.object(vision, "analyze_meal_photo", fake), at(12, 0):
            bad = self.call(self.c, "POST", "/api/log-meal", files=files, data={"meal_type": "lunch", "eaten_time": "13:00"})
            self.assertEqual(bad.status_code, 422)
            self.assertEqual(calls, [])                                  # nothing was sent to the model
            ok = self.call(self.c, "POST", "/api/log-meal", files=files, data={"meal_type": "lunch", "eaten_time": "11:40"})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["eaten_time"], "11:40")
        self.assertEqual(calls, [1])

    def jpeg_bytes(self):
        import io
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (40, 30), (120, 90, 40)).save(buf, "JPEG")
        return buf.getvalue()

    def test_logging_a_favorite_takes_a_time_too(self):
        with at(15, 0):
            first = self.manual().json()
            fav = self.call(self.c, "POST", "/api/favorites", json={"entry_id": first["id"]}).json()
            r = self.call(self.c, "POST", f"/api/favorites/{fav['id']}/log", json={"meal_type": "snack", "eaten_time": "10:15"})
            plain = self.call(self.c, "POST", f"/api/favorites/{fav['id']}/log", json={"meal_type": "snack"})
            future = self.call(self.c, "POST", f"/api/favorites/{fav['id']}/log", json={"meal_type": "snack", "eaten_time": "23:00"})
        self.assertEqual(r.json()["eaten_time"], "10:15")
        self.assertIsNone(plain.json()["eaten_time"])
        self.assertEqual(future.status_code, 422)

    def test_editing_sets_clears_and_leaves_alone(self):
        with at(15, 0):
            entry = self.manual().json()
            url = f"/api/entries/{entry['id']}"
            r = self.call(self.c, "PUT", url, json={"eaten_time": "09:30"})
            self.assertEqual(r.json()["eaten_time"], "09:30")
            r = self.call(self.c, "PUT", url, json={"total_calories": 310})              # key absent: untouched
            self.assertEqual((r.json()["eaten_time"], r.json()["total_calories"]), ("09:30", 310))
            r = self.call(self.c, "PUT", url, json={"eaten_time": None})
            self.assertIsNone(r.json()["eaten_time"])
            r = self.call(self.c, "PUT", url, json={"eaten_time": ""})
            self.assertEqual(r.status_code, 200)
            self.assertIsNone(r.json()["eaten_time"])
            bad = self.call(self.c, "PUT", url, json={"eaten_time": "16:00", "total_calories": 999})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(self.rows("SELECT total_calories, eaten_time FROM entries")[0], {"total_calories": 310, "eaten_time": None},
                         "a rejected edit changes nothing (not even the other fields in the same request)")

    def test_an_entry_from_an_earlier_day_can_be_given_any_time(self):
        entry = self.add_entry(self.uid, created_at="2026-10-20T09:00:00", meal_type="dinner")
        with at(8, 0):
            r = self.call(self.c, "PUT", f"/api/entries/{entry['id']}", json={"eaten_time": "21:45"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["eaten_time"], "21:45")

    def test_editing_someone_elses_entry_is_a_404(self):
        other = self.make_user("Боян")
        entry = self.add_entry(other)
        r = self.call(self.c, "PUT", f"/api/entries/{entry['id']}", json={"eaten_time": "08:00"})
        self.assertEqual(r.status_code, 404)
        self.assertIsNone(self.rows("SELECT eaten_time FROM entries")[0]["eaten_time"])

    def test_eaten_time_does_not_change_totals_or_day_status(self):
        with at(20, 0):
            for meal, hhmm in (("breakfast", "08:00"), ("lunch", "13:00"), ("dinner", "19:00")):
                self.assertEqual(self.manual(meal_type=meal, eaten_time=hhmm).status_code, 200)
            body = self.c.get("/api/today").json()
        self.assertEqual(body["totals"]["calories"], 900)
        self.assertEqual(body["day_status"], "complete")        # decided by meal TYPES, as before


class ScheduleTests(AppTestCase):
    def setUp(self):
        super().setUp()
        self.uid = self.make_user("Ана")
        self.c = self.signed_in_client(self.uid)

    def put(self, payload, client=None):
        return self.call(client or self.c, "PUT", "/api/schedule", json=payload)

    def test_default_is_empty_and_reminders_are_off(self):
        body = self.c.get("/api/schedule").json()
        self.assertEqual(body, {"slots": [], "reminders": {"enabled": False, "lead_min": 15}})

    def test_slots_are_stored_sorted_by_time_and_times_are_normalised(self):
        r = self.put({"slots": [{"meal_type": "dinner", "time": "19:00"}, {"meal_type": "breakfast", "time": "8:30"},
                                {"meal_type": "lunch", "time": "13:00"}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([(s["meal_type"], s["time"]) for s in r.json()["slots"]],
                         [("breakfast", "08:30"), ("lunch", "13:00"), ("dinner", "19:00")])
        self.assertEqual(self.c.get("/api/schedule").json()["slots"], r.json()["slots"])

    def test_what_is_sent_replaces_what_was_stored_and_the_other_key_is_left_alone(self):
        self.put({"slots": [{"meal_type": "lunch", "time": "13:00"}], "reminders": {"enabled": True, "lead_min": 30}})
        r = self.put({"reminders": {"enabled": False, "lead_min": 10}})
        self.assertEqual(r.json(), {"slots": [{"meal_type": "lunch", "time": "13:00"}], "reminders": {"enabled": False, "lead_min": 10}})
        r = self.put({"slots": []})
        self.assertEqual(r.json()["slots"], [])
        self.assertEqual(r.json()["reminders"], {"enabled": False, "lead_min": 10})

    def test_turning_reminders_on_is_explicit(self):
        self.put({"slots": [{"meal_type": "lunch", "time": "13:00"}]})
        self.assertFalse(self.c.get("/api/schedule").json()["reminders"]["enabled"])       # a schedule alone switches nothing on
        self.assertTrue(self.put({"reminders": {"enabled": True, "lead_min": 15}}).json()["reminders"]["enabled"])
        for bad in ("yes", 1, None):
            self.assertEqual(self.put({"reminders": {"enabled": bad}}).status_code, 422, bad)

    def test_invalid_schedules_are_rejected_and_change_nothing(self):
        self.put({"slots": [{"meal_type": "lunch", "time": "13:00"}], "reminders": {"enabled": True, "lead_min": 15}})
        too_many = [{"meal_type": "snack", "time": f"{9 + i:02d}:00"} for i in range(7)]
        cases = {
            "too_many": {"slots": too_many},
            "duplicate": {"slots": [{"meal_type": "lunch", "time": "13:00"}, {"meal_type": "snack", "time": "13:00"}]},
            "bad type": {"slots": [{"meal_type": "brunch", "time": "11:00"}]},
            "bad time": {"slots": [{"meal_type": "lunch", "time": "24:00"}]},
            "missing time": {"slots": [{"meal_type": "lunch"}]},
            "not a list": {"slots": "13:00"},
            "second slot bad": {"slots": [{"meal_type": "lunch", "time": "12:00"}, {"meal_type": "dinner", "time": "xx"}]},
            "lead too long": {"slots": [{"meal_type": "lunch", "time": "12:00"}], "reminders": {"enabled": True, "lead_min": 500}},
            "negative lead": {"reminders": {"enabled": True, "lead_min": -1}},
        }
        for name, payload in cases.items():
            r = self.put(payload)
            self.assertEqual(r.status_code, 422, name)
        self.assertEqual(self.c.get("/api/schedule").json(),
                         {"slots": [{"meal_type": "lunch", "time": "13:00"}], "reminders": {"enabled": True, "lead_min": 15}})

    def test_six_slots_are_the_most(self):
        six = [{"meal_type": "snack", "time": f"{9 + i:02d}:00"} for i in range(6)]
        self.assertEqual(self.put({"slots": six}).status_code, 200)

    def test_today_carries_the_schedule_and_the_apps_clock(self):
        self.put({"slots": [{"meal_type": "lunch", "time": "13:00"}], "reminders": {"enabled": True, "lead_min": 15}})
        with at(11, 7):
            body = self.c.get("/api/today").json()
        self.assertEqual(body["now"], "2026-10-22T11:07:00")
        self.assertEqual(body["schedule"]["slots"], [{"meal_type": "lunch", "time": "13:00"}])
        self.assertTrue(body["schedule"]["reminders"]["enabled"])

    def test_each_profile_has_its_own_schedule(self):
        other = self.make_user("Боян")
        c2 = self.signed_in_client(other)
        self.put({"slots": [{"meal_type": "lunch", "time": "13:00"}], "reminders": {"enabled": True, "lead_min": 15}})
        self.assertEqual(c2.get("/api/schedule").json()["slots"], [])
        self.assertFalse(c2.get("/api/schedule").json()["reminders"]["enabled"])
        self.put({"slots": [{"meal_type": "dinner", "time": "20:00"}]}, client=c2)
        self.assertEqual(self.c.get("/api/schedule").json()["slots"], [{"meal_type": "lunch", "time": "13:00"}])

    def test_it_needs_a_session_and_the_csrf_token(self):
        anon = self.new_client()
        self.assertEqual(anon.get("/api/schedule").status_code, 401)
        self.assertEqual(anon.put("/api/schedule", json={"slots": []}).status_code, 401)
        no_token = self.c.put("/api/schedule", json={"slots": []})        # signed in, but without the CSRF header
        self.assertEqual(no_token.status_code, 403)

    def test_deleting_the_profile_deletes_its_schedule(self):
        self.put({"slots": [{"meal_type": "lunch", "time": "13:00"}], "reminders": {"enabled": True, "lead_min": 15}})
        self.assertEqual(self.call(self.c, "DELETE", "/api/users/me").status_code, 200)
        self.assertEqual(self.rows("SELECT * FROM meal_schedule"), [])
        self.assertEqual(self.rows("SELECT * FROM reminder_settings"), [])
