"""Server-side input validation for state-changing requests.

Every failure raises HTTP 422 with a machine-readable body the client can localize:
    {"detail": {"code": "out_of_range" | "invalid_number" | "required" | "too_long" | "inconsistent",
                "field": "<name>", "min": .., "max": .., "message": "<english, for logs/other clients>"}}

These bounds are sanity limits against typos and unit mix-ups (66 kg typed as 66 lb, 175 ft), not
nutritional advice. They apply to *writes only*: values already stored (even if outside today's bounds)
are still read back unchanged. Nutrition formulas live in nutrition.py and are not touched here.
"""

import math
import re

from fastapi import HTTPException

LIMITS = {
    "height_cm": (100, 250),
    "weight_kg": (30, 300),
    "age": (10, 100),
    "target_rate_kg_week": (-2, 2),
    "goal_calories": (1, 10_000),
    "entry_calories": (0, 10_000),
    "macro_g": (0, 2_000),
    "water_goal_ml": (500, 10_000),
    "water_delta_ml": (-5_000, 5_000),
    "water_pct": (0, 100),
    "est_grams": (0, 10_000),
}
MAX_TEXT = {"description": 300, "dietary_notes": 500, "notes": 500, "name": 200}


def fail(code: str, field: str, message: str, **extra):
    raise HTTPException(422, detail={"code": code, "field": field, "message": message, **extra})


def number(value, field: str, lo: float, hi: float, *, integer: bool = False,
           exclusive_lo: bool = False, allow_none: bool = False):
    """Validates one numeric value and returns it as int/float. Rejects bool, strings that aren't plain
    numbers, NaN/Infinity, non-whole numbers for integer fields, and anything outside [lo, hi]."""
    if value is None:
        if allow_none:
            return None
        fail("required", field, f"{field} is required")
    if isinstance(value, bool):
        fail("invalid_number", field, f"{field} must be a number")
    if isinstance(value, str):
        try:
            value = float(value.strip())
        except ValueError:
            fail("invalid_number", field, f"{field} must be a number")
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        fail("invalid_number", field, f"{field} must be a finite number")
    if integer:
        if isinstance(value, float):
            if not value.is_integer():
                fail("invalid_number", field, f"{field} must be a whole number")
            value = int(value)
    below = value <= lo if exclusive_lo else value < lo
    if below or value > hi:
        fail("out_of_range", field, f"{field} must be between {lo} and {hi}", min=lo, max=hi)
    return value


def text(value, field: str, *, required: bool = False, max_len: int | None = None):
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            fail("required", field, f"{field} is required")
        return None if value is None else ""
    if not isinstance(value, str):
        fail("invalid_number", field, f"{field} must be text")
    limit = max_len or MAX_TEXT.get(field, 1000)
    if len(value) > limit:
        fail("too_long", field, f"{field} must be at most {limit} characters", max=limit)
    return value


def profile_fields(payload: dict, *, require_all: bool = False) -> dict:
    """Validates the numeric profile fields present in payload (all of them if require_all)."""
    out = {}
    specs = {
        "height_cm": (*LIMITS["height_cm"], False),
        "weight_kg": (*LIMITS["weight_kg"], False),
        "age": (*LIMITS["age"], True),
        "target_rate_kg_week": (*LIMITS["target_rate_kg_week"], False),
    }
    for field, (lo, hi, integer) in specs.items():
        if field not in payload and not (require_all and field != "target_rate_kg_week"):
            continue
        # explicit null clears an optional value on a partial update; require_all (suggest/apply) needs real numbers
        v = number(payload.get(field), field, lo, hi, integer=integer,
                   allow_none=(field == "target_rate_kg_week") or not require_all)
        out[field] = v
    if "dietary_notes" in payload:
        out["dietary_notes"] = text(payload.get("dietary_notes"), "dietary_notes") or ""
    return out


def goals_fields(payload: dict) -> dict:
    out = {
        "calories": number(payload.get("calories"), "calories", *LIMITS["goal_calories"], integer=True),
        "protein_g": number(payload.get("protein_g"), "protein_g", *LIMITS["macro_g"]),
        "carbs_g": number(payload.get("carbs_g"), "carbs_g", *LIMITS["macro_g"]),
        "fat_g": number(payload.get("fat_g"), "fat_g", *LIMITS["macro_g"]),
    }
    if payload.get("water_ml") is not None:
        out["water_ml"] = number(payload["water_ml"], "water_ml", *LIMITS["water_goal_ml"], integer=True)
    return out


def entry_values(payload: dict, *, require_all: bool = False) -> dict:
    """calories/macros of a logged entry; only the keys present are validated unless require_all."""
    out = {}
    if "total_calories" in payload or require_all:
        out["total_calories"] = number(payload.get("total_calories"), "total_calories",
                                       *LIMITS["entry_calories"], integer=True)
    for field in ("protein_g", "carbs_g", "fat_g"):
        if field in payload or require_all:
            out[field] = number(payload.get(field, 0), field, *LIMITS["macro_g"])
    return out


def weigh_in(payload: dict) -> dict:
    weight = number(payload.get("weight_kg"), "weight_kg", *LIMITS["weight_kg"])
    out = {"weight_kg": weight}
    for field in ("fat_mass_kg", "muscle_mass_kg"):
        v = payload.get(field)
        if v is None:
            continue
        v = number(v, field, 0, LIMITS["weight_kg"][1], exclusive_lo=True)
        if v > weight:
            fail("inconsistent", field, f"{field} can't be more than weight_kg", max=weight)
        out[field] = v
    if payload.get("water_pct") is not None:
        out["water_pct"] = number(payload["water_pct"], "water_pct", *LIMITS["water_pct"], exclusive_lo=True)
    return out


def water_delta(payload: dict) -> int:
    ml = number(payload.get("ml"), "ml", *LIMITS["water_delta_ml"], integer=True)
    if ml == 0:
        fail("invalid_number", "ml", "ml must not be zero")
    return ml


def portions(items) -> list:
    """items: [{"est_grams": number|null}, ...] -> list of grams (None kept as None)."""
    if not isinstance(items, list):
        fail("invalid_number", "items", "items must be a list")
    grams = []
    for i, item in enumerate(items):
        g = item.get("est_grams") if isinstance(item, dict) else None
        grams.append(number(g, f"items[{i}].est_grams", *LIMITS["est_grams"], allow_none=True))
    return grams


# ---------- eating time & schedule ----------

CLOCK_RE = re.compile(r"^(?:[01]?\d|2[0-3]):[0-5]\d$")
REMINDER_LEAD_MIN = (0, 120)


def clock_time(value, field: str, *, allow_none: bool = False):
    """A wall-clock time "H:MM" / "HH:MM" -> zero-padded "HH:MM". None / "" is 'not given' when allow_none."""
    if value is None or (isinstance(value, str) and not value.strip()):
        if allow_none:
            return None
        fail("required", field, f"{field} is required")
    if not isinstance(value, str) or not CLOCK_RE.match(value.strip()):
        fail("invalid_time", field, f"{field} must be a time like 13:05")
    hours, minutes = value.strip().split(":")
    return f"{int(hours):02d}:{minutes}"


def eaten_time_not_in_future(eaten_time: str | None, entry_day: str, today: str, now_hhmm: str) -> None:
    """Today's entries can't have been eaten later than the current local time (the HH:MM strings compare correctly)."""
    if eaten_time is not None and entry_day == today and eaten_time > now_hhmm:
        fail("in_future", "eaten_time", "the time you ate can't be later than now", max=now_hhmm)


def schedule(payload: dict, allowed_meal_types, max_slots: int) -> tuple:
    """-> (slots sorted by time or None when absent, reminders dict or None when absent). Everything is checked
    before anything is stored, so a rejected request changes nothing."""
    slots = None
    if "slots" in payload:
        raw = payload["slots"]
        if not isinstance(raw, list):
            fail("invalid_number", "slots", "slots must be a list")
        if len(raw) > max_slots:
            fail("too_many", "slots", f"at most {max_slots} meals in the schedule", max=max_slots)
        slots, seen = [], set()
        for i, item in enumerate(raw):
            if not isinstance(item, dict):
                fail("invalid_number", f"slots[{i}]", "each slot must be an object")
            meal_type = item.get("meal_type")
            if meal_type not in allowed_meal_types:
                fail("invalid_number", f"slots[{i}].meal_type", f"meal_type must be one of {sorted(allowed_meal_types)}")
            at = clock_time(item.get("time"), f"slots[{i}].time")
            if at in seen:
                fail("duplicate", f"slots[{i}].time", "two meals can't have the same time")
            seen.add(at)
            slots.append({"meal_type": meal_type, "time": at})
        slots.sort(key=lambda s: s["time"])
    reminders = None
    if "reminders" in payload:
        raw = payload["reminders"]
        if not isinstance(raw, dict) or not isinstance(raw.get("enabled"), bool):
            fail("invalid_number", "reminders.enabled", "enabled must be true or false")
        lead = number(raw.get("lead_min", 15), "reminders.lead_min", *REMINDER_LEAD_MIN, integer=True)
        reminders = {"enabled": raw["enabled"], "lead_min": lead}
    return slots, reminders
