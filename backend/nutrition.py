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

Water: ~30-35ml/kg bodyweight/day is the commonly cited general hydration
baseline (Mayo Clinic, EFSA-adjacent guidance). Extra fluid is added per
activity tier to cover sweat losses from exercise, and a flat seasonal bonus
is added during Sofia's hot months (Jun-Aug), when insensible/sweat losses
run higher even without structured exercise.
"""

from datetime import date, timedelta

import tzutil

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
    "gain": 0.4,  # midpoint of a 0.3-0.5kg/week hardgainer target; matches what a
                  # 400kcal/day surplus implies (400*7/7700 ~= 0.36kg/wk)
}

WATER_ML_PER_KG = 35  # general hydration baseline

ACTIVITY_WATER_BONUS_ML = {
    "sedentary": 0,
    "light": 300,
    "moderate": 500,
    "active": 700,
    "very_active": 900,
}

SUMMER_MONTHS = {6, 7, 8}  # Jun-Aug in Europe/Sofia
SUMMER_WATER_BONUS_ML = 500

# ---------- Adaptive TDEE ----------
# Real_TDEE = avg_daily_intake - (weight_trend_delta_kg * 7700 / elapsed_days), which
# generalizes the commonly-cited "14-day rolling adaptive TDEE" formula to whatever span
# of real data is actually available (converges to the literal /14 once a full window
# exists). This is a separate, additive path from calculate_targets()'s static formula —
# nothing here runs until a user has real weigh-in + intake history.
ADAPTIVE_WINDOW_DAYS = 14
ADAPTIVE_LOOKBACK_DAYS = 21          # extra days fetched so the EWMA is warmed up by the
                                      # time the 14-day window starts
ADAPTIVE_MIN_ELAPSED_DAYS = 10       # earliest the engine will report a number at all
ADAPTIVE_MIN_INTAKE_COVERAGE = 0.7   # fraction of elapsed days needing a logged
                                      # total_calories > 0 for the intake average to be trusted
EWMA_ALPHA = 0.2                     # ~9-day half-life smoothing of daily weight noise
ADAPTIVE_SURPLUS_BUFFER_KCAL = 400

# ---------- Scale-based adjustment suggestions ----------
# Velocity thresholds are specified in kg/week (matches how a hardgainer target is usually
# talked about) and compared against weight_velocity_kg_week, which calculate_adaptive_tdee
# already derives from the 14-day window — no separate unit conversion needed at the call site.
ADJUSTMENT_UNDER_FUELED_MIN_VELOCITY_KG_WEEK = 0.2
ADJUSTMENT_UNDER_FUELED_DELTA_KCAL = 150
ADJUSTMENT_SWEET_SPOT_MIN_KG_WEEK = 0.3
ADJUSTMENT_SWEET_SPOT_MAX_KG_WEEK = 0.5
ADJUSTMENT_FAT_SPIKE_RATIO = 0.65
ADJUSTMENT_FAT_SPIKE_DELTA_KCAL = -100
ADJUSTMENT_MIN_FAT_MASS_READINGS = 2
ADJUSTMENT_PROTEIN_FLOOR_G = 135  # held as a minimum (never lowered) when trimming for a fat spike
ADJUSTMENT_FAT_FLOOR_G = 40       # sane floor so an automated fat-priority cut can't zero out fat

# ---------- Autonomous auto-adjustment engine ----------
AUTO_ADJUST_MIN_COMMIT_KCAL = 50   # a computed change smaller than this is noise, not a decision
AUTO_ADJUST_COOLDOWN_DAYS = 7      # at most one auto-committed change per rolling week, even if
                                    # weight is logged/scanned more often than that

# "Bridge to reality": under_fueled infers "raise the target" purely from weight velocity, which
# can't tell "target is too low" apart from "not eating anywhere near the current target in the
# first place." Below this fraction of the current calorie goal, the second explanation is more
# likely, and auto-raising further would just make an already-unhit number bigger — so the
# raise is withheld from auto-commit (the manual "Recalculate" button can still show/apply it;
# that's an informed human choice, not a silent one).
ADJUSTMENT_ADHERENCE_GATE_PCT = 0.85
ADJUSTMENT_ADHERENCE_OVER_PCT = 1.15  # symmetric upper bound — "significantly over" a macro
                                        # target is as worth surfacing as "significantly under"
COACH_NOTE_MIN_INTERVAL_DAYS = 3   # don't re-generate an AI coach note more often than this,
                                    # even if the same finding keeps re-evaluating true


def calculate_macro_adherence(daily_macros: list, window_start: date, window_end: date, goals: dict) -> dict:
    """daily_macros: list of (date, {"calories", "protein_g", "carbs_g", "fat_g"}) tuples, one
    per day with at least one logged entry — matches main._daily_macro_totals()'s shape.
    Averages each field over days within [window_start, window_end] that have logged intake
    (calories > 0, same coverage rule calculate_adaptive_tdee uses), compares against goals,
    and classifies each as "under"/"on_target"/"over" relative to
    ADJUSTMENT_ADHERENCE_GATE_PCT/ADJUSTMENT_ADHERENCE_OVER_PCT. Multi-tracks every field —
    not just calories — so a rule (or the coach note) can reference "you're averaging 61g fat
    against a 40g target" even though only calorie adherence gates auto-commit behavior.
    Returns {} if there are no days with logged intake in the window."""
    in_window = [m for d, m in daily_macros if window_start <= d <= window_end and (m.get("calories") or 0) > 0]
    if not in_window:
        return {}

    out = {}
    for field in ("calories", "protein_g", "carbs_g", "fat_g"):
        goal_value = goals.get(field)
        if not goal_value:
            continue
        avg_value = sum(m.get(field, 0) or 0 for m in in_window) / len(in_window)
        pct = avg_value / goal_value
        if pct < ADJUSTMENT_ADHERENCE_GATE_PCT:
            status = "under"
        elif pct > ADJUSTMENT_ADHERENCE_OVER_PCT:
            status = "over"
        else:
            status = "on_target"
        out[field] = {"avg": round(avg_value), "goal": round(goal_value), "pct": round(pct, 3), "status": status}
    return out


def calculate_water_ml(weight_kg: float, activity_level: str, is_summer: bool) -> int:
    total = weight_kg * WATER_ML_PER_KG
    total += ACTIVITY_WATER_BONUS_ML.get(activity_level, 0)
    if is_summer:
        total += SUMMER_WATER_BONUS_ML
    return round(total / 50) * 50  # round to a sane 50ml increment


def _ewma_from_daily(raw_by_date: dict, as_of: date, lookback_days: int, alpha: float) -> list:
    """Forward-fill gap days (no weigh-in that day means "no new evidence", not a guessed
    value) and run an EWMA over the resulting daily series. Returns an ascending list of
    {"date": iso, "raw": value_or_None_if_filled, "smoothed": value} dicts starting from
    the first day that actually has data within the window."""
    window_start = as_of - timedelta(days=lookback_days - 1)
    in_window = {d: v for d, v in raw_by_date.items() if window_start <= d <= as_of}
    if len(in_window) < 2:
        return []

    first_date = min(in_window)
    series = []
    last_raw = None
    smoothed = None
    d = first_date
    while d <= as_of:
        if d in in_window:
            last_raw = in_window[d]
        value = last_raw
        smoothed = value if smoothed is None else alpha * value + (1 - alpha) * smoothed
        series.append({"date": d.isoformat(), "raw": in_window.get(d), "smoothed": round(smoothed, 3)})
        d += timedelta(days=1)
    return series


def ewma_weight_trend(weight_entries: list, as_of: date | None = None,
                       lookback_days: int = ADAPTIVE_LOOKBACK_DAYS, alpha: float = EWMA_ALPHA) -> list:
    """weight_entries: rows from db.get_weight_log (order-agnostic, any mix of dates).
    Buckets by calendar day (averaging same-day duplicates), then smooths. Returns []
    when there's under 2 distinct days of data in the window — the caller's signal for
    insufficient data."""
    as_of = as_of or tzutil.today_local()
    raw_by_date: dict = {}
    counts: dict = {}
    for entry in weight_entries:
        d = date.fromisoformat(entry["logged_at"][:10])
        raw_by_date[d] = raw_by_date.get(d, 0) + entry["weight_kg"]
        counts[d] = counts.get(d, 0) + 1
    raw_by_date = {d: v / counts[d] for d, v in raw_by_date.items()}

    series = _ewma_from_daily(raw_by_date, as_of, lookback_days, alpha)
    return [{"date": row["date"], "raw_kg": row["raw"], "smoothed_kg": row["smoothed"]} for row in series]


def _evaluate_adjustment_rules(weight_delta_kg: float, weight_entries: list,
                                effective_start: date, as_of: date, elapsed_days: int) -> list:
    """Scale-driven "should we nudge the target" checks, evaluated over the same window
    calculate_adaptive_tdee already computed. Never raises on missing/sparse data — a
    rule that can't be evaluated (e.g. no fat_mass_kg logged) simply doesn't fire."""
    suggestions = []
    weight_velocity_kg_week = (weight_delta_kg / elapsed_days) * 7 if elapsed_days else 0.0

    if weight_velocity_kg_week < ADJUSTMENT_UNDER_FUELED_MIN_VELOCITY_KG_WEEK:
        suggestions.append({
            "type": "under_fueled",
            "calorie_delta": ADJUSTMENT_UNDER_FUELED_DELTA_KCAL,
            "weight_delta_kg": round(weight_delta_kg, 2),
            "weight_velocity_kg_week": round(weight_velocity_kg_week, 3),
        })
    elif ADJUSTMENT_SWEET_SPOT_MIN_KG_WEEK <= weight_velocity_kg_week <= ADJUSTMENT_SWEET_SPOT_MAX_KG_WEEK:
        # In the target range — an explicit "no change" signal rather than silence, so the
        # caller (and the Analyst Feed) can say *why* nothing moved instead of showing nothing.
        suggestions.append({
            "type": "on_track",
            "calorie_delta": 0,
            "weight_delta_kg": round(weight_delta_kg, 2),
            "weight_velocity_kg_week": round(weight_velocity_kg_week, 3),
        })

    # Bucket ALL fat_mass_kg readings (not just those inside the scored window) so the
    # EWMA gets the same ADAPTIVE_LOOKBACK_DAYS warmup buffer the main weight trend gets —
    # restricting to the window first would cold-start the smoothing mid-window and
    # systematically understate the fat trend.
    fat_by_date: dict = {}
    fat_counts: dict = {}
    for entry in weight_entries:
        if entry.get("fat_mass_kg") is None:
            continue
        d = date.fromisoformat(entry["logged_at"][:10])
        fat_by_date[d] = fat_by_date.get(d, 0) + entry["fat_mass_kg"]
        fat_counts[d] = fat_counts.get(d, 0) + 1
    fat_by_date = {d: v / fat_counts[d] for d, v in fat_by_date.items()}

    readings_in_window = sum(1 for d in fat_by_date if effective_start <= d <= as_of)
    if readings_in_window >= ADJUSTMENT_MIN_FAT_MASS_READINGS:
        fat_series = _ewma_from_daily(fat_by_date, as_of, ADAPTIVE_LOOKBACK_DAYS, EWMA_ALPHA)
        # Only trust the delta if the (warmed-up) fat series actually reaches back to the
        # same effective_start the weight delta was measured from — otherwise the two
        # deltas would cover different spans and the ratio wouldn't mean anything.
        if fat_series and fat_series[0]["date"] <= effective_start.isoformat():
            fat_series_by_date = {row["date"]: row["smoothed"] for row in fat_series}
            fat_mass_delta_kg = fat_series_by_date[as_of.isoformat()] - fat_series_by_date[effective_start.isoformat()]
            if weight_delta_kg > 0 and (fat_mass_delta_kg / weight_delta_kg) > ADJUSTMENT_FAT_SPIKE_RATIO:
                suggestions.append({
                    "type": "fat_spike",
                    "calorie_delta": ADJUSTMENT_FAT_SPIKE_DELTA_KCAL,
                    "fat_mass_delta_kg": round(fat_mass_delta_kg, 2),
                    "weight_delta_kg": round(weight_delta_kg, 2),
                    "protein_floor_g": ADJUSTMENT_PROTEIN_FLOOR_G,
                    "prioritize_carbs": True,  # trim comes out of fat grams, carbs held steady
                })

    return suggestions


def apply_calorie_adjustment(goals: dict, calorie_delta: int, prioritize_carbs: bool = False) -> dict:
    """Pure macro redistribution for a calorie_delta coming from an adjustment suggestion.
    Default behavior (prioritize_carbs=False) matches the existing manual "Apply" flow:
    protein_g and fat_g stay fixed, carbs_g absorbs the whole delta. prioritize_carbs=True
    (the fat_spike case) instead holds protein at ADJUSTMENT_PROTEIN_FLOOR_G minimum and
    carbs_g fixed, taking the delta out of fat_g — floored so an automated cut can't zero
    out fat entirely; any remainder past that floor spills back onto carbs."""
    protein_g = goals["protein_g"]
    carbs_g = goals["carbs_g"]
    fat_g = goals["fat_g"]
    new_calories = round(goals["calories"] + calorie_delta)

    if prioritize_carbs:
        protein_g = max(protein_g, ADJUSTMENT_PROTEIN_FLOOR_G)
        fat_g = max(fat_g + calorie_delta / 9, ADJUSTMENT_FAT_FLOOR_G)

    carbs_g = round(max(new_calories - protein_g * 4 - fat_g * 9, 0) / 4)

    return {
        "calories": new_calories,
        "protein_g": round(protein_g),
        "carbs_g": carbs_g,
        "fat_g": round(fat_g),
    }


def calculate_adaptive_tdee(daily_calories: list, weight_entries: list,
                             surplus_buffer_kcal: int = ADAPTIVE_SURPLUS_BUFFER_KCAL,
                             as_of: date | None = None) -> dict:
    """daily_calories: list of (date, total_kcal) tuples, one per day that has at least
    one logged meal (days with nothing logged are simply absent, not zero).
    weight_entries: rows from db.get_weight_log."""
    as_of = as_of or tzutil.today_local()
    series = ewma_weight_trend(weight_entries, as_of=as_of)
    if not series:
        return {
            "insufficient_data": True,
            "reason": "no_weight_history",
            "elapsed_days": 0,
            "days_with_intake_logged": 0,
            "min_days_required": ADAPTIVE_MIN_ELAPSED_DAYS,
            "suggestions": [],
        }

    first_available = date.fromisoformat(series[0]["date"])
    effective_start = max(first_available, as_of - timedelta(days=ADAPTIVE_WINDOW_DAYS - 1))
    elapsed_days = (as_of - effective_start).days + 1

    if elapsed_days < ADAPTIVE_MIN_ELAPSED_DAYS:
        return {
            "insufficient_data": True,
            "reason": "insufficient_weight_span",
            "elapsed_days": elapsed_days,
            "days_with_intake_logged": 0,
            "min_days_required": ADAPTIVE_MIN_ELAPSED_DAYS,
            "suggestions": [],
        }

    series_by_date = {row["date"]: row["smoothed_kg"] for row in series}
    start_kg = series_by_date[effective_start.isoformat()]
    end_kg = series_by_date[as_of.isoformat()]
    weight_delta_kg = end_kg - start_kg

    intake_in_window = [kcal for d, kcal in daily_calories if effective_start <= d <= as_of and kcal > 0]
    coverage = len(intake_in_window) / elapsed_days

    if coverage < ADAPTIVE_MIN_INTAKE_COVERAGE:
        return {
            "insufficient_data": True,
            "reason": "insufficient_intake_logging",
            "elapsed_days": elapsed_days,
            "days_with_intake_logged": len(intake_in_window),
            "min_days_required": ADAPTIVE_MIN_ELAPSED_DAYS,
            "suggestions": [],
        }

    avg_daily_intake = sum(intake_in_window) / len(intake_in_window)
    daily_energy_balance = (weight_delta_kg * GOAL_RATE_KCAL_PER_KG) / elapsed_days
    real_tdee = avg_daily_intake - daily_energy_balance
    weight_velocity_kg_week = (weight_delta_kg / elapsed_days) * 7
    suggested_calories = round(real_tdee + surplus_buffer_kcal)

    return {
        "insufficient_data": False,
        "real_tdee": round(real_tdee),
        "avg_daily_intake": round(avg_daily_intake),
        "weight_delta_kg": round(weight_delta_kg, 2),
        "weight_velocity_kg_week": round(weight_velocity_kg_week, 3),
        "surplus_buffer_kcal": surplus_buffer_kcal,
        "suggested_calories": suggested_calories,
        "elapsed_days": elapsed_days,
        "days_with_intake_logged": len(intake_in_window),
        "window_start": effective_start.isoformat(),
        "window_end": as_of.isoformat(),
        "method": "EWMA-smoothed weight trend vs. logged intake over the trailing window",
        "suggestions": _evaluate_adjustment_rules(weight_delta_kg, weight_entries, effective_start, as_of, elapsed_days),
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

    is_summer = tzutil.today_local().month in SUMMER_MONTHS
    water_ml = calculate_water_ml(weight_kg, activity_level, is_summer)

    return {
        "bmr": round(bmr),
        "tdee": round(tdee),
        "target_calories": round(target_calories),
        "protein_g": round(protein_g),
        "carbs_g": round(carbs_g),
        "fat_g": round(fat_g),
        "water_ml": water_ml,
        "rate_kg_per_week": rate_kg_per_week,
        "method": "Mifflin-St Jeor BMR x activity multiplier, ISSN protein guidance (1.6-2.2 g/kg)",
    }
