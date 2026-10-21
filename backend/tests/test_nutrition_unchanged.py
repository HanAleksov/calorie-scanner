"""Golden outputs for the nutrition formulas and analyst rules, on synthetic fixed inputs.

The reliability/security work must not move a single number here. `fixtures/nutrition_golden.json` was
produced by running these same inputs through `nutrition.py` BEFORE any of that work; if a formula,
threshold or macro split ever changes on purpose, regenerate it deliberately and say so in the commit.
The inputs are invented (no real person's data).
"""

import json
import unittest
from datetime import date, timedelta
from pathlib import Path

import nutrition as N

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "nutrition_golden.json").read_text(encoding="utf-8"))
AS_OF = date(2026, 3, 31)
GOALS = {"calories": 3000, "protein_g": 130, "carbs_g": 400, "fat_g": 70}


def weights(per_week_kg, fat_per_week_kg):
    return [{"logged_at": f"{(AS_OF - timedelta(days=20 - i)).isoformat()}T08:00:00",
             "weight_kg": round(70 + per_week_kg * i / 7, 2),
             "fat_mass_kg": round(12 + fat_per_week_kg * i / 7, 2)} for i in range(21)]


INTAKE = [((AS_OF - timedelta(days=13 - i)), 2800 + (i % 3) * 100) for i in range(14)]


def norm(x):
    return json.loads(json.dumps(x, default=str))


class NutritionUnchangedTests(unittest.TestCase):
    def test_static_targets(self):
        self.assertEqual(norm(N.calculate_targets({"height_cm": 175, "weight_kg": 70, "age": 30, "sex": "male",
                                                   "activity_level": "moderate", "goal_type": "gain"})), GOLDEN["gain"])
        self.assertEqual(norm(N.calculate_targets({"height_cm": 165, "weight_kg": 80, "age": 40, "sex": "female",
                                                   "activity_level": "light", "goal_type": "lose"})), GOLDEN["lose"])
        self.assertEqual(norm(N.calculate_targets({"height_cm": 170, "weight_kg": 65, "age": 25, "sex": "other",
                                                   "activity_level": "sedentary", "goal_type": "maintain"})),
                         GOLDEN["maintain_other"])

    def test_calorie_adjustment_macro_math(self):
        self.assertEqual(N.apply_calorie_adjustment(GOALS, 150), GOLDEN["adj_plain"])
        self.assertEqual(N.apply_calorie_adjustment(GOALS, -100, prioritize_carbs=True), GOLDEN["adj_fat"])
        self.assertEqual(N.apply_calorie_adjustment({"calories": 1800, "protein_g": 120, "carbs_g": 150, "fat_g": 41},
                                                    -300, prioritize_carbs=True), GOLDEN["adj_fat_floor"])

    def test_adaptive_tdee_and_rules_per_goal(self):
        w = weights(0.3, 0.05)
        for goal in ("gain", "lose", "maintain"):
            self.assertEqual(norm(N.calculate_adaptive_tdee(INTAKE, w, as_of=AS_OF, goal_type=goal)),
                             GOLDEN[f"adaptive_{goal}"], goal)

    def test_fat_spike_rule(self):
        got = norm(N.calculate_adaptive_tdee(INTAKE, weights(0.2, 0.5), as_of=AS_OF, goal_type="gain"))
        self.assertEqual(got, GOLDEN["adaptive_fat_spike"])
        self.assertEqual([s["type"] for s in got["suggestions"]], ["under_fueled", "fat_spike"])

    def test_macro_adherence(self):
        days = [(d, {"calories": k, "protein_g": 100, "carbs_g": 300, "fat_g": 90}) for d, k in INTAKE]
        self.assertEqual(N.calculate_macro_adherence(days, AS_OF - timedelta(days=13), AS_OF, GOALS),
                         GOLDEN["macro_adherence"])

    def test_the_thresholds_themselves(self):
        self.assertEqual((N.ADJUSTMENT_ADHERENCE_GATE_PCT, N.AUTO_ADJUST_MIN_COMMIT_KCAL, N.AUTO_ADJUST_COOLDOWN_DAYS,
                          N.ADJUSTMENT_FAT_SPIKE_RATIO, N.ADJUSTMENT_UNDER_FUELED_MIN_VELOCITY_KG_WEEK,
                          N.COMPLETE_DAY_MIN_MEAL_TYPES, N.ADAPTIVE_MIN_INTAKE_COVERAGE),
                         (0.85, 50, 7, 0.65, 0.2, 3, 0.7))


if __name__ == "__main__":
    unittest.main()
