"""
Evidence-based BMR/TDEE/macro calculations.

BMR: Mifflin-St Jeor equation (Mifflin et al. 1990) — the formula recommended by
the Academy of Nutrition and Dietetics, shown in a 2005 systematic review
(Frankenfield, Roth-Yousey, Compher) to be the most accurate predictor of resting
energy expenditure across body types, outperforming the older Harris-Benedict
equation, especially in people with overweight/obesity.

Activity multipliers: the standard Mifflin-St Jeor/Harris-Benedict activity
scale used across clinical and fitness nutrition sources (sedentary 1.2 through
extra-active 1.9).

Deficit/surplus: 7700 kcal is the commonly cited energy equivalent of ~1kg of
body fat; a 500 kcal/day deficit or surplus yields roughly 0.45kg/week, in line
with CDC/Mayo Clinic guidance of 0.5-1kg/week as a safe, sustainable rate.

Protein: 1.6-2.2 g/kg bodyweight, per the International Society of Sports
Nutrition's 2017 position stand on protein intake — higher end for a calorie
deficit to preserve lean mass, lower end for maintenance/surplus.

Fat: minimum ~0.6g/kg (roughly 20% of calories at maintenance) to support
hormone production, per general sports-nutrition guidance; carbs fill the
remainder of the calorie budget.
"""

ACTIVITY_MULTIPLIERS = {
    "sedentary": 1.2,       # little or no exercise, desk job
    "light": 1.375,         # light exercise 1-3 days/week
    "moderate": 1.55,       # moderate exercise 3-5 days/week
    "active": 1.725,        # hard exercise 6-7 days/week
    "very_active": 1.9,     # very hard exercise, physical job
}

GOAL_RATE_KCAL_PER_KG = 7700  # commonly cited kcal-per-kg-bodyfat equivalent

DEFAULT_RATE_KG_PER_WEEK = {
    "lose": -0.45,
    "maintain": 0.0,
    "gain": 0.25,
}


def calculate_bmr(weight_kg: float, height_cm: float, age: int, sex: str) -> float:
    base = 10 * weight_kg + 6.25 * height_cm - 5 * age
    if sex == "male":
        return base + 5
    if sex == "female":
        return base - 161
    # "other" / prefer not to say: average of the two sex-specific constants,
    # a common fallback when the binary formula doesn't apply.
    return base - 78


def calculate_targets(profile: dict) -> dict:
    weight_kg = profile["weight_kg"]
    height_cm = profile["height_cm"]
    age = profile["age"]
    sex = profile["sex"]
    activity_level = profile["activity_level"]
    goal_type = profile["goal_type"]
    rate_kg_per_week = profile.get("target_rate_kg_week")
    if rate_kg_per_week is None:
        rate_kg_per_week = DEFAULT_RATE_KG_PER_WEEK.get(goal_type, 0.0)

    bmr = calculate_bmr(weight_kg, height_cm, age, sex)
    multiplier = ACTIVITY_MULTIPLIERS.get(activity_level, 1.2)
    tdee = bmr * multiplier

    daily_adjustment = (rate_kg_per_week * GOAL_RATE_KCAL_PER_KG) / 7
    target_calories = tdee + daily_adjustment

    # Floor to protect against unsafe extreme deficits.
    floor = 1200 if sex == "female" else 1500
    target_calories = max(target_calories, floor)

    protein_per_kg = 2.0 if goal_type == "lose" else 1.7
    protein_g = weight_kg * protein_per_kg

    fat_g = max(weight_kg * 0.7, target_calories * 0.20 / 9)

    protein_kcal = protein_g * 4
    fat_kcal = fat_g * 9
    carbs_kcal = max(target_calories - protein_kcal - fat_kcal, 0)
    carbs_g = carbs_kcal / 4

    return {
        "bmr": round(bmr),
        "tdee": round(tdee),
        "target_calories": round(target_calories),
        "protein_g": round(protein_g),
        "carbs_g": round(carbs_g),
        "fat_g": round(fat_g),
        "rate_kg_per_week": rate_kg_per_week,
        "method": "Mifflin-St Jeor BMR x activity multiplier, ISSN protein guidance (1.6-2.2 g/kg)",
    }
