"""Server-side validation: ranges, types, operations vs values, and that stored legacy data stays readable."""

import json

import db
from tests.base import AppTestCase


class ValidationBase(AppTestCase):
    def setUp(self):
        super().setUp()
        self.uid = self.make_user("V", goal_type="gain", height_cm=178, weight_kg=65.0, age=24, sex="male",
                                  activity_level="moderate")
        self.c = self.signed_in_client(self.uid)

    def put(self, path, body):
        return self.call(self.c, "PUT", path, json=body)

    def post(self, path, body=None, **kw):
        return self.call(self.c, "POST", path, json=body, **kw)

    def assert_rejected(self, r, field=None, code=None):
        self.assertEqual(r.status_code, 422, r.text)
        detail = r.json()["detail"]
        if field:
            self.assertEqual(detail["field"], field)
        if code:
            self.assertEqual(detail["code"], code)

    def profile_row(self):
        return self.rows("SELECT * FROM profile WHERE user_id=?", (self.uid,))[0]

    def goals_row(self):
        return self.rows("SELECT * FROM goals WHERE user_id=?", (self.uid,))[0]


class ProfileBoundsTests(ValidationBase):
    def test_height_weight_age_bounds_are_inclusive(self):
        cases = [("height_cm", 100, 250), ("weight_kg", 30, 300), ("age", 10, 100)]
        for field, lo, hi in cases:
            for ok in (lo, hi):
                self.assertEqual(self.put("/api/profile", {field: ok}).status_code, 200, f"{field}={ok}")
            for bad in (lo - 0.1 if field != "age" else lo - 1, hi + 0.1 if field != "age" else hi + 1):
                before = self.profile_row()
                self.assert_rejected(self.put("/api/profile", {field: bad}), field, "out_of_range")
                self.assertEqual(self.profile_row(), before, "a rejected write must change nothing")

    def test_thirty_kilos_is_a_valid_weight_not_an_error(self):
        self.assertEqual(self.put("/api/profile", {"weight_kg": 30}).status_code, 200)
        self.assertEqual(self.post("/api/weight", {"weight_kg": 30}).status_code, 200)
        r = self.post("/api/goals/suggested", {"height_cm": 170, "weight_kg": 30, "age": 20, "sex": "female",
                                               "activity_level": "light", "goal_type": "gain"})
        self.assertEqual(r.status_code, 200)
        self.assert_rejected(self.post("/api/weight", {"weight_kg": 29.9}), "weight_kg", "out_of_range")

    def test_a_unit_mix_up_is_caught_after_conversion(self):
        # 175 ft typed into the metric-converted field -> 5334 cm; 65 kg read as pounds -> 29.48 kg
        self.assert_rejected(self.put("/api/profile", {"height_cm": round(175 * 30.48, 1)}), "height_cm")
        self.assert_rejected(self.post("/api/goals/suggested", {
            "height_cm": 5334, "weight_kg": 65.0, "age": 24, "sex": "male",
            "activity_level": "moderate", "goal_type": "gain"}), "height_cm")
        self.assert_rejected(self.put("/api/profile", {"weight_kg": round(65.0 * 0.453592, 2)}), "weight_kg")

    def test_canonical_metric_values_round_trip_exactly(self):
        self.assertEqual(self.put("/api/profile", {"height_cm": 178.0, "weight_kg": 65.0}).status_code, 200)
        p = self.c.get("/api/profile").json()
        self.assertEqual((p["height_cm"], p["weight_kg"]), (178.0, 65.0))

    def test_bad_types_are_refused(self):
        for bad in ("abc", "", [], {}, True, None):
            r = self.put("/api/profile", {"weight_kg": bad})
            if bad is None:
                self.assertEqual(r.status_code, 200)   # explicit null clears an optional value
            else:
                self.assert_rejected(r, "weight_kg")
        self.assert_rejected(self.put("/api/profile", {"age": 18.5}), "age", "invalid_number")
        for raw in ("NaN", "Infinity", "-Infinity"):
            r = self.c.put("/api/profile", content='{"weight_kg": %s}' % raw,
                           headers={"Content-Type": "application/json", "X-CSRF-Token": self.c.csrf})
            self.assert_rejected(r, "weight_kg")

    def test_suggested_targets_need_real_numbers_not_nulls(self):
        body = {"height_cm": None, "weight_kg": 66, "age": 18, "sex": "male", "activity_level": "moderate",
                "goal_type": "gain"}
        self.assert_rejected(self.post("/api/goals/suggested", body), "height_cm", "required")

    def test_target_rate_bounds(self):
        self.assertEqual(self.put("/api/profile", {"target_rate_kg_week": 0.4}).status_code, 200)
        self.assertEqual(self.put("/api/profile", {"target_rate_kg_week": None}).status_code, 200)
        self.assert_rejected(self.put("/api/profile", {"target_rate_kg_week": 5}), "target_rate_kg_week")


class GoalsBoundsTests(ValidationBase):
    BODY = {"calories": 2780, "protein_g": 140, "carbs_g": 410, "fat_g": 62, "water_ml": 2500}

    def test_goal_ranges(self):
        for field, lo, hi in (("calories", 1, 10000), ("protein_g", 0, 2000), ("carbs_g", 0, 2000),
                              ("fat_g", 0, 2000), ("water_ml", 500, 10000)):
            for ok in (lo, hi):
                self.assertEqual(self.put("/api/goals", {**self.BODY, field: ok}).status_code, 200, f"{field}={ok}")
            before = self.goals_row()
            for bad in (lo - 1, hi + 1):
                self.assert_rejected(self.put("/api/goals", {**self.BODY, field: bad}), field, "out_of_range")
            self.assertEqual(self.goals_row(), before)

    def test_calories_must_be_a_whole_number(self):
        self.assert_rejected(self.put("/api/goals", {**self.BODY, "calories": 2780.5}), "calories", "invalid_number")
        self.assertEqual(self.put("/api/goals", {**self.BODY, "calories": 2780.0}).status_code, 200)

    def test_saving_goals_keeps_auto_apply_flag_and_water_when_omitted(self):
        body = {k: v for k, v in self.BODY.items() if k != "water_ml"}
        self.put("/api/goals", self.BODY)
        self.assertEqual(self.put("/api/goals", body).status_code, 200)
        g = self.goals_row()
        self.assertEqual((g["auto_apply_targets"], g["water_ml"]), (1, 2500))


class EntryAndWaterTests(ValidationBase):
    def manual(self, **over):
        form = {"meal_type": "lunch", "description": "oats", "total_calories": "350", "protein_g": "12",
                "carbs_g": "60", "fat_g": "6", **over}
        return self.call(self.c, "POST", "/api/log-manual", data=form)

    def test_manual_entry_ranges_and_types(self):
        self.assertEqual(self.manual().status_code, 200)
        self.assertEqual(self.manual(total_calories="0").status_code, 200)      # black coffee is a real entry
        self.assertEqual(self.manual(total_calories="10000").status_code, 200)
        for bad in ("-1", "10001", "250.5", "abc", "", "nan", "inf"):
            self.assert_rejected(self.manual(total_calories=bad), "total_calories")
        for macro in ("protein_g", "carbs_g", "fat_g"):
            self.assert_rejected(self.manual(**{macro: "-5"}), macro, "out_of_range")
            self.assert_rejected(self.manual(**{macro: "2001"}), macro, "out_of_range")
        self.assert_rejected(self.manual(description="   "), "description", "required")
        self.assert_rejected(self.manual(description="x" * 301), "description", "too_long")
        n = self.rows("SELECT COUNT(*) n FROM entries")[0]["n"]
        self.assertEqual(n, 3)   # only the three valid ones were stored

    def test_removing_water_still_works_and_the_total_never_goes_negative(self):
        self.assertEqual(self.post("/api/water", {"ml": 500}).json()["water_ml"], 500)
        self.assertEqual(self.post("/api/water", {"ml": -250}).json()["water_ml"], 250)
        self.assertEqual(self.post("/api/water", {"ml": -250}).json()["water_ml"], 0)
        self.assertEqual(self.post("/api/water", {"ml": -250}).json()["water_ml"], 0)     # nothing left to remove
        self.assertEqual(self.post("/api/water", {"ml": -5000}).json()["water_ml"], 0)
        self.assertEqual(self.rows("SELECT COALESCE(SUM(ml),0) s FROM water_log")[0]["s"], 0)
        self.assertEqual(self.c.get("/api/today").json()["water_ml"], 0)

    def test_water_operations_are_validated_as_operations_not_as_totals(self):
        for bad in (0, 5001, -5001, 250.5, "abc", None, True):
            self.assert_rejected(self.post("/api/water", {"ml": bad}), "ml")
        self.assertEqual(self.post("/api/water", {"ml": 5000}).status_code, 200)
        self.assertEqual(self.post("/api/water", {"ml": -5000}).status_code, 200)

    def test_weigh_in_composition_must_be_consistent(self):
        self.assertEqual(self.post("/api/weight", {"weight_kg": 65, "fat_mass_kg": 10.6, "muscle_mass_kg": 30,
                                                   "water_pct": 53.4}).status_code, 200)
        self.assert_rejected(self.post("/api/weight", {"weight_kg": 65, "fat_mass_kg": 70}), "fat_mass_kg", "inconsistent")
        self.assert_rejected(self.post("/api/weight", {"weight_kg": 65, "muscle_mass_kg": 65.1}), "muscle_mass_kg")
        self.assertEqual(self.post("/api/weight", {"weight_kg": 65, "muscle_mass_kg": 65.0}).status_code, 200)
        self.assert_rejected(self.post("/api/weight", {"weight_kg": 65, "fat_mass_kg": 0}), "fat_mass_kg")
        self.assert_rejected(self.post("/api/weight", {"weight_kg": 65, "water_pct": 100.1}), "water_pct")
        self.assert_rejected(self.post("/api/weight", {"weight_kg": 65, "water_pct": 0}), "water_pct")
        self.assertEqual(self.post("/api/weight", {"weight_kg": 65, "water_pct": 100}).status_code, 200)
        self.assertEqual(self.rows("SELECT COUNT(*) n FROM weight_log")[0]["n"], 3)

    def test_entry_edit_validation(self):
        e = self.add_entry(self.uid, calories=400)
        self.assert_rejected(self.put(f"/api/entries/{e['id']}", {"total_calories": -5}), "total_calories")
        self.assert_rejected(self.put(f"/api/entries/{e['id']}", {"items": [{"est_grams": -3}]}), "items[0].est_grams")
        self.assert_rejected(self.put(f"/api/entries/{e['id']}", {"items": "x"}), "items")
        self.assertEqual(self.put(f"/api/entries/{e['id']}", {"items": [{"est_grams": 1}, {"est_grams": 2}]}).status_code, 400)
        self.assertEqual(self.rows("SELECT total_calories FROM entries WHERE id=?", (e["id"],))[0]["total_calories"], 400)


class LegacyDataStaysReadableTests(ValidationBase):
    def test_values_outside_todays_bounds_are_read_back_unchanged(self):
        with db.get_conn() as conn:
            conn.execute("UPDATE profile SET weight_kg=28, height_cm=90, age=9 WHERE user_id=?", (self.uid,))
            conn.execute("UPDATE goals SET calories=20000, water_ml=100 WHERE user_id=?", (self.uid,))
            conn.execute("INSERT INTO weight_log (user_id, logged_at, weight_kg) VALUES (?, '2026-01-01T08:00:00', 25)", (self.uid,))
        p, g = self.c.get("/api/profile").json(), self.c.get("/api/goals").json()
        self.assertEqual((p["weight_kg"], p["height_cm"], p["age"]), (28, 90, 9))
        self.assertEqual((g["calories"], g["water_ml"]), (20000, 100))
        self.assertEqual(self.c.get("/api/weight").json()["entries"][-1]["weight_kg"], 25)
        self.assertEqual(self.c.get("/api/today").status_code, 200)
        self.assertEqual(self.c.get("/api/history?days=7").status_code, 200)
        # a partial update that doesn't touch the odd fields is not blocked by them
        self.assertEqual(self.put("/api/profile", {"dietary_notes": "no nuts"}).status_code, 200)
        self.assertEqual(self.c.get("/api/profile").json()["weight_kg"], 28)

    def test_old_entries_with_unusual_numbers_can_still_be_edited_by_meal_type(self):
        with db.get_conn() as conn:
            e = db.insert_entry(conn, user_id=self.uid, created_at="2026-10-01T12:00:00", meal_type="lunch",
                                source="manual", items_json=json.dumps([{"name": "x", "est_grams": None}]),
                                total_calories=15000, protein_g=1, carbs_g=1, fat_g=1, confidence="manual")
        self.assertEqual(self.put(f"/api/entries/{e['id']}", {"meal_type": "dinner"}).status_code, 200)
        self.assertEqual(self.c.get(f"/api/entries/{e['id']}").json()["total_calories"], 15000)
