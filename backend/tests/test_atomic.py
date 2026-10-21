"""Business transactions are all-or-nothing: profile+targets, portions+details.

Fault injection runs the REAL write and then raises, so a passing test proves the first write was rolled
back — not merely that nothing was attempted. Comparison is on canonically sorted rows of the affected
tables (never on the bytes of the whole SQLite file, which legitimately changes with any write).
"""

import json
from unittest import mock

import db
import main
from tests.base import AppTestCase

PROFILE = {"height_cm": 178, "weight_kg": 65.0, "age": 24, "sex": "male", "activity_level": "moderate",
           "goal_type": "gain", "dietary_notes": ""}
GOALS = {"calories": 2780, "protein_g": 140, "carbs_g": 410, "fat_g": 62, "water_ml": 2500}


class AtomicBase(AppTestCase):
    def setUp(self):
        super().setUp()
        self.uid = self.make_user("T", height_cm=170, weight_kg=60, age=20, sex="female",
                                  activity_level="light", goal_type="maintain")
        with db.get_conn() as conn:
            db.set_goals(conn, self.uid, calories=2000, protein_g=100, carbs_g=250, fat_g=60, water_ml=2000)
        self.c = self.signed_in_client(self.uid)

    def canon(self, *tables):
        out = {}
        for t in tables:
            rows = self.rows(f"SELECT * FROM {t} ORDER BY 1, 2")
            out[t] = sorted(json.dumps(r, sort_keys=True) for r in rows)
        return out


class ApplyGoalsTests(AtomicBase):
    def apply(self, **over):
        body = {"profile": PROFILE, "goals": GOALS, **over}
        return self.call(self.c, "POST", "/api/goals/apply", json=body)

    def test_profile_and_targets_are_saved_together(self):
        r = self.apply()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.c.get("/api/profile").json()["weight_kg"], 65.0)
        g = self.c.get("/api/goals").json()
        self.assertEqual((g["calories"], g["protein_g"], g["carbs_g"], g["fat_g"], g["water_ml"]), (2780, 140, 410, 62, 2500))
        self.assertEqual(g["auto_apply_targets"], 1)           # untouched by saving targets
        self.assertEqual((r.json()["goals"]["calories"], r.json()["profile"]["goal_type"]), (2780, "gain"))

    def test_failure_after_the_profile_write_rolls_the_profile_back(self):
        before = self.canon("profile", "goals")
        real = db.set_goals

        def write_then_die(*a, **k):
            real(*a, **k)
            raise RuntimeError("boom after the goals write")

        with mock.patch.object(db, "set_goals", write_then_die):
            r = self.apply()
        self.assertEqual(r.status_code, 500)
        self.assertEqual(self.canon("profile", "goals"), before)

    def test_failure_after_the_goals_write_rolls_back_both(self):
        before = self.canon("profile", "goals")
        real_profile = db.set_profile

        def write_then_die(*a, **k):
            real_profile(*a, **k)
            raise RuntimeError("boom after the profile write")

        with mock.patch.object(db, "set_profile", write_then_die):
            self.assertEqual(self.apply().status_code, 500)
        self.assertEqual(self.canon("profile", "goals"), before)

    def test_invalid_goals_reject_the_whole_request_before_anything_is_written(self):
        before = self.canon("profile", "goals")
        r = self.apply(goals={**GOALS, "calories": 0})
        self.assertEqual((r.status_code, r.json()["detail"]["field"]), (422, "calories"))
        r = self.apply(profile={**PROFILE, "height_cm": 5334})
        self.assertEqual((r.status_code, r.json()["detail"]["field"]), (422, "height_cm"))
        self.assertEqual(self.canon("profile", "goals"), before)

    def test_missing_pieces_are_a_client_error(self):
        self.assertEqual(self.call(self.c, "POST", "/api/goals/apply", json={"profile": PROFILE}).status_code, 400)
        self.assertEqual(self.apply(profile={**PROFILE, "sex": "robot"}).status_code, 400)


class EntryEditTests(AtomicBase):
    def setUp(self):
        super().setUp()
        self.entry = self.add_entry(self.uid, calories=500, items=[
            {"name": "rice", "est_grams": 100, "calories": 130, "protein_g": 3, "carbs_g": 28, "fat_g": 0.3},
            {"name": "chicken", "est_grams": 100, "calories": 370, "protein_g": 30, "carbs_g": 0, "fat_g": 20}])

    def edit(self, body):
        return self.call(self.c, "PUT", f"/api/entries/{self.entry['id']}", json=body)

    def test_portions_and_details_are_one_request(self):
        r = self.edit({"meal_type": "dinner", "items": [{"est_grams": 200}, {"est_grams": 50}]})
        self.assertEqual(r.status_code, 200, r.text)
        e = r.json()
        self.assertEqual(e["meal_type"], "dinner")
        self.assertEqual([i["est_grams"] for i in e["items"]], [200, 50])
        self.assertEqual(e["total_calories"], 260 + 185)       # 130*2 + 370*0.5

    def test_explicit_numbers_win_over_the_grams_recalculation_as_before(self):
        r = self.edit({"items": [{"est_grams": 200}, {"est_grams": 50}], "total_calories": 999, "protein_g": 1,
                       "carbs_g": 2, "fat_g": 3})
        self.assertEqual((r.json()["total_calories"], r.json()["protein_g"]), (999, 1))
        self.assertEqual([i["est_grams"] for i in r.json()["items"]], [200, 50])    # grams still saved

    def test_failure_after_the_write_leaves_the_entry_exactly_as_it_was(self):
        before = self.canon("entries")
        real = db.update_entry

        def write_then_die(*a, **k):
            real(*a, **k)
            raise RuntimeError("boom after update")

        with mock.patch.object(db, "update_entry", write_then_die):
            r = self.edit({"meal_type": "snack", "items": [{"est_grams": 1}, {"est_grams": 1}]})
        self.assertEqual(r.status_code, 500)
        self.assertEqual(self.canon("entries"), before)

    def test_failure_while_recalculating_changes_nothing(self):
        before = self.canon("entries")
        with mock.patch.object(main, "_rescale_items", side_effect=RuntimeError("boom")):
            self.assertEqual(self.edit({"meal_type": "snack", "items": [{"est_grams": 1}, {"est_grams": 1}]}).status_code, 500)
        self.assertEqual(self.canon("entries"), before)

    def test_a_rejected_edit_changes_nothing(self):
        before = self.canon("entries")
        self.assertEqual(self.edit({"meal_type": "snack", "items": [{"est_grams": -1}, {"est_grams": 1}]}).status_code, 422)
        self.assertEqual(self.edit({"meal_type": "brunch"}).status_code, 400)
        self.assertEqual(self.edit({"items": [{"est_grams": 1}]}).status_code, 400)   # wrong item count
        self.assertEqual(self.canon("entries"), before)

    def test_legacy_portions_endpoint_is_still_available_and_validated(self):
        r = self.call(self.c, "PUT", f"/api/entries/{self.entry['id']}/portions",
                      json={"items": [{"est_grams": 100}, {"est_grams": 100}]})
        self.assertEqual(r.status_code, 200)
        r = self.call(self.c, "PUT", f"/api/entries/{self.entry['id']}/portions", json={"items": [{"est_grams": -1}, {}]})
        self.assertEqual(r.status_code, 422)

    def test_another_profile_cannot_edit_the_entry(self):
        other = self.signed_in_client(self.make_user("O"))
        before = self.canon("entries")
        r = self.call(other, "PUT", f"/api/entries/{self.entry['id']}", json={"total_calories": 1})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.canon("entries"), before)
