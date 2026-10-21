"""POST /api/weight returns the targets as they are *after* the analyst ran, for gain, lose and maintain,
both when the analyst changed them and when it did not. The analyst's own decisions are not altered.

AI is replaced by a stub: `coach.generate_analyst_note` returns canned text and is counted.
"""

from datetime import timedelta
from unittest import mock

import coach
import db
import tzutil
from tests.base import AppTestCase


class WeighInGoalsTests(AppTestCase):
    def build(self, goal_type, *, weights, calories=2500, intake=2500, auto_apply=1):
        """User with `weights` (oldest first, one per day ending yesterday) and 14 full logged days."""
        today = tzutil.today_local()
        uid = self.make_user(f"U-{goal_type}", goal_type=goal_type, height_cm=175, weight_kg=weights[-1], age=25,
                             sex="male", activity_level="moderate")
        with db.get_conn() as conn:
            db.set_goals(conn, uid, calories=calories, protein_g=150, carbs_g=300, fat_g=70, water_ml=2500)
            db.set_auto_apply_targets(conn, uid, bool(auto_apply))
            for i, w in enumerate(weights):
                day = today - timedelta(days=len(weights) - i)
                db.add_weight_entry(conn, uid, w, f"{day.isoformat()}T08:00:00")
            for d in range(14):
                day = today - timedelta(days=d)
                for meal, share in (("breakfast", .3), ("lunch", .4), ("dinner", .3)):
                    db.insert_entry(conn, user_id=uid, created_at=f"{day.isoformat()}T12:00:00", meal_type=meal,
                                    source="manual", items_json="[]", total_calories=round(intake * share),
                                    protein_g=30, carbs_g=60, fat_g=15, confidence="manual")
        return uid, self.signed_in_client(uid)

    def weigh(self, client, kg):
        with mock.patch.object(coach, "generate_analyst_note", return_value="stub coach note") as note:
            r = self.call(client, "POST", "/api/weight", json={"weight_kg": kg, "lang": "en"})
        return r, note

    def goals_in_db(self, uid):
        return self.rows("SELECT * FROM goals WHERE user_id=?", (uid,))[0]

    def logs(self, uid):
        return self.rows("SELECT * FROM analyst_logs WHERE user_id=? ORDER BY id", (uid,))

    # ---------- gain ----------
    def test_gain_goals_changed_by_the_analyst_are_returned_immediately(self):
        uid, c = self.build("gain", weights=[65.0] * 20)             # flat weight, eating the target -> raise
        r, note = self.weigh(c, 65.0)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["goals_changed"])
        self.assertEqual(body["goals"]["calories"], 2650)             # 2500 + the 150 kcal under-fueled step
        self.assertEqual(body["goals"], dict(self.goals_in_db(uid)))  # exactly what is stored
        self.assertEqual(c.get("/api/today").json()["goals"]["calories"], 2650)
        self.assertEqual(body["weight_kg"], 65.0)                     # the entry fields are still there
        self.assertEqual(note.call_count, 1)
        self.assertEqual((self.logs(uid)[-1]["old_calories"], self.logs(uid)[-1]["new_calories"]), (2500, 2650))

    def test_gain_goals_left_alone_are_returned_as_unchanged(self):
        uid, c = self.build("gain", weights=[65.0] * 20, auto_apply=0)   # analyst evaluates but may not write
        before = dict(self.goals_in_db(uid))
        r, note = self.weigh(c, 65.0)
        body = r.json()
        self.assertFalse(body["goals_changed"])
        self.assertEqual(body["goals"], before)
        self.assertEqual(dict(self.goals_in_db(uid)), before)
        self.assertEqual(note.call_count, 0)
        self.assertIn("Auto-Apply Targets is turned off", self.logs(uid)[-1]["reason_text"])

    def test_gain_without_enough_history_still_returns_the_current_targets(self):
        uid = self.make_user("New", goal_type="gain", weight_kg=65, height_cm=175, age=25, sex="male",
                             activity_level="moderate")
        c = self.signed_in_client(uid)
        before = dict(self.goals_in_db(uid))
        r, _ = self.weigh(c, 65.0)
        self.assertEqual((r.json()["goals_changed"], r.json()["goals"]), (False, before))
        self.assertEqual(self.logs(uid), [])                           # insufficient data: no log row, as before

    # ---------- lose ----------
    def test_lose_goal_is_never_auto_changed_and_says_so(self):
        uid, c = self.build("lose", weights=[80.0] * 20, calories=2200, intake=2200)   # stalled
        before = dict(self.goals_in_db(uid))
        r, note = self.weigh(c, 80.0)
        body = r.json()
        self.assertEqual(r.status_code, 200)
        self.assertFalse(body["goals_changed"])
        self.assertEqual(body["goals"], before)
        self.assertEqual(dict(self.goals_in_db(uid)), before)
        self.assertEqual(note.call_count, 0)                           # coach note is gain-only
        log = self.logs(uid)[-1]
        self.assertEqual((log["old_calories"], log["new_calories"]), (2200, 2200))
        self.assertIn("automatic changes only apply to a weight-gain goal", log["reason_text"])

    # ---------- maintain ----------
    def test_maintain_drift_is_reported_but_targets_stay(self):
        weights = [70 + 0.06 * i for i in range(20)]                   # +0.4 kg/week drift upward
        uid, c = self.build("maintain", weights=weights, calories=2400, intake=2400)
        before = dict(self.goals_in_db(uid))
        r, note = self.weigh(c, round(weights[-1] + 0.06, 2))
        self.assertFalse(r.json()["goals_changed"])
        self.assertEqual(r.json()["goals"], before)
        self.assertEqual(note.call_count, 0)
        self.assertIn("automatic changes only apply to a weight-gain goal", self.logs(uid)[-1]["reason_text"])

    def test_maintain_stable_weight_changes_nothing(self):
        uid, c = self.build("maintain", weights=[70.0] * 20, calories=2400, intake=2400)
        before = dict(self.goals_in_db(uid))
        r, _ = self.weigh(c, 70.0)
        self.assertEqual((r.json()["goals_changed"], r.json()["goals"]), (False, before))

    # ---------- profile isolation ----------
    def test_the_response_carries_only_the_signed_in_profiles_targets(self):
        a, ca = self.build("gain", weights=[65.0] * 20)
        b, cb = self.build("gain", weights=[65.0] * 20, calories=3100, intake=3100)
        r, _ = self.weigh(cb, 65.0)
        self.assertEqual(r.json()["goals"]["calories"], 3250)
        self.assertEqual(self.goals_in_db(a)["calories"], 2500)        # A untouched by B's weigh-in
