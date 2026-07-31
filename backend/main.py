import json
import os
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import db
import meal_plan as meal_plan_module
import nutrition
import vision

BACKEND_DIR = Path(__file__).parent
FRONTEND_DIR = BACKEND_DIR.parent / "frontend"
UPLOADS_DIR = Path(os.environ.get("CALORIE_UPLOADS_DIR", BACKEND_DIR / "uploads"))
UPLOADS_DIR.mkdir(exist_ok=True, parents=True)

ALLOWED_MEAL_TYPES = {"breakfast", "lunch", "dinner", "snack"}
ALLOWED_IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
ALLOWED_SEX = {"male", "female", "other"}
ALLOWED_ACTIVITY = {"sedentary", "light", "moderate", "active", "very_active"}
ALLOWED_GOAL_TYPE = {"lose", "maintain", "gain"}
ALLOWED_LANGS = {"en", "bg"}

app = FastAPI(title="Calorie Scanner")


@app.on_event("startup")
def _startup():
    db.init_db()


def current_user_id(x_user_id: int | None = Header(default=None)) -> int:
    if x_user_id is None:
        raise HTTPException(401, "missing X-User-Id header — pick or create a profile first")
    with db.get_conn() as conn:
        if not db.get_user(conn, x_user_id):
            raise HTTPException(401, "unknown user")
    return x_user_id


def _entry_to_public(entry: dict) -> dict:
    entry = dict(entry)
    entry.pop("user_id", None)
    entry["items"] = json.loads(entry.pop("items_json"))
    return entry


def _totals(entries: list[dict]) -> dict:
    return {
        "calories": sum(e["total_calories"] or 0 for e in entries),
        "protein_g": round(sum(e["protein_g"] or 0 for e in entries), 1),
        "carbs_g": round(sum(e["carbs_g"] or 0 for e in entries), 1),
        "fat_g": round(sum(e["fat_g"] or 0 for e in entries), 1),
    }


def _validate_profile_payload(payload: dict):
    if "sex" in payload and payload["sex"] not in ALLOWED_SEX:
        raise HTTPException(400, f"sex must be one of {sorted(ALLOWED_SEX)}")
    if "activity_level" in payload and payload["activity_level"] not in ALLOWED_ACTIVITY:
        raise HTTPException(400, f"activity_level must be one of {sorted(ALLOWED_ACTIVITY)}")
    if "goal_type" in payload and payload["goal_type"] not in ALLOWED_GOAL_TYPE:
        raise HTTPException(400, f"goal_type must be one of {sorted(ALLOWED_GOAL_TYPE)}")


# ---------- users ----------

@app.get("/api/users")
def list_users():
    with db.get_conn() as conn:
        return db.list_users(conn)


@app.post("/api/users")
def create_user(payload: dict):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    pin = payload.get("pin")
    if pin is not None and (not str(pin).isdigit() or len(str(pin)) != 4):
        raise HTTPException(400, "pin must be exactly 4 digits")
    with db.get_conn() as conn:
        return db.create_user(conn, name, pin)


@app.post("/api/users/{user_id}/verify")
def verify_user_pin(user_id: int, payload: dict):
    with db.get_conn() as conn:
        if not db.get_user(conn, user_id):
            raise HTTPException(404, "user not found")
        ok = db.verify_pin(conn, user_id, payload.get("pin", ""))
    return {"ok": ok}


@app.get("/api/users/me")
def get_current_user(user_id: int = Depends(current_user_id)):
    with db.get_conn() as conn:
        user = db.get_user(conn, user_id)
        user["has_pin"] = db.user_has_pin(conn, user_id)
    return user


@app.put("/api/users/me")
def rename_current_user(payload: dict, user_id: int = Depends(current_user_id)):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    with db.get_conn() as conn:
        return db.rename_user(conn, user_id, name)


@app.put("/api/users/me/pin")
def change_current_user_pin(payload: dict, user_id: int = Depends(current_user_id)):
    new_pin = payload.get("new_pin") or None
    old_pin = payload.get("old_pin") or ""
    if new_pin is not None and (not str(new_pin).isdigit() or len(str(new_pin)) != 4):
        raise HTTPException(400, "pin must be exactly 4 digits")
    with db.get_conn() as conn:
        if db.user_has_pin(conn, user_id):
            if not old_pin:
                raise HTTPException(400, "old_pin is required to change an existing PIN")
            if not db.verify_pin(conn, user_id, old_pin):
                raise HTTPException(403, "old_pin is incorrect")
        db.set_pin(conn, user_id, new_pin)
    return {"ok": True, "has_pin": new_pin is not None}


@app.delete("/api/users/me")
def delete_current_user(user_id: int = Depends(current_user_id)):
    with db.get_conn() as conn:
        image_paths = db.get_image_paths_for_user(conn, user_id)
        db.delete_user(conn, user_id)
    for path in image_paths:
        _remove_upload(path)
    return {"ok": True}


@app.delete("/api/today")
def reset_today(user_id: int = Depends(current_user_id)):
    today_str = date.today().isoformat()
    with db.get_conn() as conn:
        image_paths = db.delete_entries_for_date(conn, user_id, today_str)
    for path in image_paths:
        _remove_upload(path)
    return {"ok": True}


# ---------- meals ----------

@app.post("/api/log-meal")
async def log_meal(
    image: UploadFile = File(...),
    meal_type: str = Form("snack"),
    lang: str = Form("en"),
    user_id: int = Depends(current_user_id),
):
    if meal_type not in ALLOWED_MEAL_TYPES:
        raise HTTPException(400, f"meal_type must be one of {sorted(ALLOWED_MEAL_TYPES)}")
    if lang not in ALLOWED_LANGS:
        lang = "en"
    if image.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(400, "image must be JPEG, PNG, or WebP")

    image_bytes = await image.read()
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(400, "image too large (max 10MB)")

    try:
        result = vision.analyze_meal_photo(image_bytes, image.content_type, lang=lang)
    except RuntimeError as e:
        raise HTTPException(502, str(e))

    ext = ALLOWED_IMAGE_TYPES[image.content_type]
    filename = f"{uuid.uuid4().hex}{ext}"
    (UPLOADS_DIR / filename).write_bytes(image_bytes)

    with db.get_conn() as conn:
        entry = db.insert_entry(
            conn,
            user_id=user_id,
            created_at=datetime.now().isoformat(timespec="seconds"),
            meal_type=meal_type,
            source="photo",
            items_json=json.dumps(result["items"]),
            total_calories=result["total_calories"],
            protein_g=result["protein_g"],
            carbs_g=result["carbs_g"],
            fat_g=result["fat_g"],
            confidence=result["confidence"],
            image_path=filename,
        )
    return _entry_to_public(entry)


@app.post("/api/log-manual")
async def log_manual(
    meal_type: str = Form("snack"),
    description: str = Form(...),
    total_calories: int = Form(...),
    protein_g: float = Form(0),
    carbs_g: float = Form(0),
    fat_g: float = Form(0),
    user_id: int = Depends(current_user_id),
):
    if meal_type not in ALLOWED_MEAL_TYPES:
        raise HTTPException(400, f"meal_type must be one of {sorted(ALLOWED_MEAL_TYPES)}")

    with db.get_conn() as conn:
        entry = db.insert_entry(
            conn,
            user_id=user_id,
            created_at=datetime.now().isoformat(timespec="seconds"),
            meal_type=meal_type,
            source="manual",
            items_json=json.dumps([{"name": description, "est_grams": None}]),
            total_calories=total_calories,
            protein_g=protein_g,
            carbs_g=carbs_g,
            fat_g=fat_g,
            confidence="manual",
        )
    return _entry_to_public(entry)


@app.get("/api/today")
def today(user_id: int = Depends(current_user_id)):
    today_str = date.today().isoformat()
    with db.get_conn() as conn:
        entries = db.get_entries_for_date(conn, user_id, today_str)
        goals = db.get_goals(conn, user_id)
    entries = [_entry_to_public(e) for e in entries]
    return {"date": today_str, "entries": entries, "totals": _totals(entries), "goals": goals}


@app.get("/api/history")
def history(days: int = 14, user_id: int = Depends(current_user_id)):
    end = date.today()
    start = end - timedelta(days=days - 1)
    with db.get_conn() as conn:
        entries = db.get_entries_between(conn, user_id, start.isoformat(), end.isoformat())

    by_day: dict[str, list[dict]] = {}
    for e in entries:
        day_key = e["created_at"][:10]
        by_day.setdefault(day_key, []).append(e)

    days_out = []
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        day_entries = by_day.get(d, [])
        days_out.append({"date": d, "totals": _totals(day_entries), "entry_count": len(day_entries)})
    return {"days": days_out}


@app.get("/api/entries/{entry_id}")
def get_entry(entry_id: int, user_id: int = Depends(current_user_id)):
    with db.get_conn() as conn:
        entry = db.get_entry(conn, user_id, entry_id)
    if not entry:
        raise HTTPException(404, "entry not found")
    return _entry_to_public(entry)


@app.put("/api/entries/{entry_id}")
def update_entry(entry_id: int, payload: dict, user_id: int = Depends(current_user_id)):
    allowed = {"meal_type", "total_calories", "protein_g", "carbs_g", "fat_g", "notes"}
    fields = {k: v for k, v in payload.items() if k in allowed}
    if "meal_type" in fields and fields["meal_type"] not in ALLOWED_MEAL_TYPES:
        raise HTTPException(400, f"meal_type must be one of {sorted(ALLOWED_MEAL_TYPES)}")
    with db.get_conn() as conn:
        if not db.get_entry(conn, user_id, entry_id):
            raise HTTPException(404, "entry not found")
        entry = db.update_entry(conn, user_id, entry_id, fields)
    return _entry_to_public(entry)


@app.delete("/api/entries/{entry_id}")
def delete_entry(entry_id: int, user_id: int = Depends(current_user_id)):
    with db.get_conn() as conn:
        entry = db.get_entry(conn, user_id, entry_id)
        if not entry:
            raise HTTPException(404, "entry not found")
        db.delete_entry(conn, user_id, entry_id)
    _remove_upload(entry.get("image_path"))
    return {"ok": True}


@app.put("/api/entries/{entry_id}/portions")
def adjust_portions(entry_id: int, payload: dict, user_id: int = Depends(current_user_id)):
    new_items_payload = payload.get("items")
    if not isinstance(new_items_payload, list):
        raise HTTPException(400, "items must be a list")

    with db.get_conn() as conn:
        entry = db.get_entry(conn, user_id, entry_id)
        if not entry:
            raise HTTPException(404, "entry not found")
        old_items = json.loads(entry["items_json"])
        if len(new_items_payload) != len(old_items):
            raise HTTPException(400, "items must match the entry's item count")

        new_grams = [p.get("est_grams") for p in new_items_payload]
        entry_totals_fallback = {
            "calories": entry.get("total_calories") or 0,
            "protein_g": entry.get("protein_g") or 0,
            "carbs_g": entry.get("carbs_g") or 0,
            "fat_g": entry.get("fat_g") or 0,
        }
        new_items, totals = _rescale_items(old_items, new_grams, entry_totals_fallback)

        updated = db.update_entry(conn, user_id, entry_id, {
            "items_json": json.dumps(new_items),
            "total_calories": totals["calories"],
            "protein_g": totals["protein_g"],
            "carbs_g": totals["carbs_g"],
            "fat_g": totals["fat_g"],
        })
    return _entry_to_public(updated)


def _rescale_items(old_items: list, new_grams: list, entry_totals_fallback: dict | None = None) -> tuple:
    total_old_grams = sum((it.get("est_grams") or 0) for it in old_items) or 1
    fallback = entry_totals_fallback or {"calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0}

    new_items = []
    totals = {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0}
    for item, new_g in zip(old_items, new_grams):
        old_g = item.get("est_grams")
        has_macros = item.get("calories") is not None

        if not has_macros:
            # legacy entry logged before per-item macros existed — approximate this
            # item's share of the entry's already-known totals by its share of total grams
            share = ((old_g or 0) / total_old_grams) if old_g else 0
            item = {
                **item,
                "calories": fallback["calories"] * share,
                "protein_g": fallback["protein_g"] * share,
                "carbs_g": fallback["carbs_g"] * share,
                "fat_g": fallback["fat_g"] * share,
            }
            old_g = old_g or item.get("est_grams") or 1

        if new_g is None or not old_g:
            scaled = dict(item)
        else:
            ratio = new_g / old_g
            scaled = {
                "name": item["name"],
                "est_grams": new_g,
                "calories": round((item.get("calories") or 0) * ratio),
                "protein_g": round((item.get("protein_g") or 0) * ratio, 1),
                "carbs_g": round((item.get("carbs_g") or 0) * ratio, 1),
                "fat_g": round((item.get("fat_g") or 0) * ratio, 1),
            }

        new_items.append(scaled)
        totals["calories"] += scaled.get("calories") or 0
        totals["protein_g"] += scaled.get("protein_g") or 0
        totals["carbs_g"] += scaled.get("carbs_g") or 0
        totals["fat_g"] += scaled.get("fat_g") or 0

    totals["calories"] = round(totals["calories"])
    totals["protein_g"] = round(totals["protein_g"], 1)
    totals["carbs_g"] = round(totals["carbs_g"], 1)
    totals["fat_g"] = round(totals["fat_g"], 1)
    return new_items, totals


def _remove_upload(image_path: str | None):
    if not image_path:
        return
    path = (UPLOADS_DIR / image_path).resolve()
    if UPLOADS_DIR.resolve() in path.parents and path.exists():
        path.unlink()


@app.get("/api/goals")
def get_goals(user_id: int = Depends(current_user_id)):
    with db.get_conn() as conn:
        return db.get_goals(conn, user_id)


@app.put("/api/goals")
def set_goals(payload: dict, user_id: int = Depends(current_user_id)):
    required = {"calories", "protein_g", "carbs_g", "fat_g"}
    if not required.issubset(payload):
        raise HTTPException(400, f"payload must include {sorted(required)}")
    with db.get_conn() as conn:
        return db.set_goals(
            conn, user_id,
            calories=payload["calories"],
            protein_g=payload["protein_g"],
            carbs_g=payload["carbs_g"],
            fat_g=payload["fat_g"],
        )


@app.get("/api/profile")
def get_profile(user_id: int = Depends(current_user_id)):
    with db.get_conn() as conn:
        return db.get_profile(conn, user_id)


@app.put("/api/profile")
def set_profile(payload: dict, user_id: int = Depends(current_user_id)):
    allowed = {"height_cm", "weight_kg", "age", "sex", "activity_level",
               "goal_type", "target_rate_kg_week", "dietary_notes"}
    fields = {k: v for k, v in payload.items() if k in allowed}
    _validate_profile_payload(fields)
    with db.get_conn() as conn:
        return db.set_profile(conn, user_id, fields)


@app.post("/api/goals/suggested")
def suggested_goals(payload: dict, user_id: int = Depends(current_user_id)):
    required = {"height_cm", "weight_kg", "age", "sex", "activity_level", "goal_type"}
    if not required.issubset(payload):
        raise HTTPException(400, f"payload must include {sorted(required)}")
    _validate_profile_payload(payload)
    try:
        return nutrition.calculate_targets(payload)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/meal-plan")
def create_meal_plan(lang: str = "en", user_id: int = Depends(current_user_id)):
    if lang not in ALLOWED_LANGS:
        lang = "en"
    with db.get_conn() as conn:
        profile = db.get_profile(conn, user_id)
        goals = db.get_goals(conn, user_id)

    required = ["height_cm", "weight_kg", "age", "sex", "activity_level", "goal_type"]
    if not profile or any(profile.get(f) is None for f in required):
        raise HTTPException(400, "complete your profile first (height, weight, age, sex, activity, goal)")

    targets = {
        "target_calories": goals["calories"],
        "protein_g": goals["protein_g"],
        "carbs_g": goals["carbs_g"],
        "fat_g": goals["fat_g"],
    }
    try:
        plan = meal_plan_module.generate_meal_plan(targets, profile.get("dietary_notes") or "", lang=lang)
    except RuntimeError as e:
        raise HTTPException(502, str(e))

    with db.get_conn() as conn:
        db.set_meal_plan(
            conn, user_id,
            plan_json=json.dumps(plan),
            generated_at=datetime.now().isoformat(timespec="seconds"),
        )
    return {"generated_at": datetime.now().isoformat(timespec="seconds"), **plan}


@app.get("/api/meal-plan")
def get_meal_plan(user_id: int = Depends(current_user_id)):
    with db.get_conn() as conn:
        row = db.get_meal_plan(conn, user_id)
    if not row or not row.get("plan_json"):
        return {"plan": None}
    return {"generated_at": row["generated_at"], **json.loads(row["plan_json"])}


@app.get("/uploads/{filename}")
def get_upload(filename: str):
    path = (UPLOADS_DIR / filename).resolve()
    if UPLOADS_DIR.resolve() not in path.parents or not path.exists():
        raise HTTPException(404)
    return FileResponse(path)


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
