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
        if not db.get_entry(conn, user_id, entry_id):
            raise HTTPException(404, "entry not found")
        db.delete_entry(conn, user_id, entry_id)
    return {"ok": True}


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
