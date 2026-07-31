import os
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import json

import db
import vision

BACKEND_DIR = Path(__file__).parent
FRONTEND_DIR = BACKEND_DIR.parent / "frontend"
UPLOADS_DIR = Path(os.environ.get("CALORIE_UPLOADS_DIR", BACKEND_DIR / "uploads"))
UPLOADS_DIR.mkdir(exist_ok=True)

ALLOWED_MEAL_TYPES = {"breakfast", "lunch", "dinner", "snack"}
ALLOWED_IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

app = FastAPI(title="Calorie Scanner")


@app.on_event("startup")
def _startup():
    db.init_db()


def _entry_to_public(entry: dict) -> dict:
    entry = dict(entry)
    entry["items"] = json.loads(entry.pop("items_json"))
    return entry


def _totals(entries: list[dict]) -> dict:
    return {
        "calories": sum(e["total_calories"] or 0 for e in entries),
        "protein_g": round(sum(e["protein_g"] or 0 for e in entries), 1),
        "carbs_g": round(sum(e["carbs_g"] or 0 for e in entries), 1),
        "fat_g": round(sum(e["fat_g"] or 0 for e in entries), 1),
    }


@app.post("/api/log-meal")
async def log_meal(image: UploadFile = File(...), meal_type: str = Form("snack")):
    if meal_type not in ALLOWED_MEAL_TYPES:
        raise HTTPException(400, f"meal_type must be one of {sorted(ALLOWED_MEAL_TYPES)}")
    if image.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(400, "image must be JPEG, PNG, or WebP")

    image_bytes = await image.read()
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(400, "image too large (max 10MB)")

    try:
        result = vision.analyze_meal_photo(image_bytes, image.content_type)
    except RuntimeError as e:
        raise HTTPException(502, str(e))

    ext = ALLOWED_IMAGE_TYPES[image.content_type]
    filename = f"{uuid.uuid4().hex}{ext}"
    (UPLOADS_DIR / filename).write_bytes(image_bytes)

    with db.get_conn() as conn:
        entry = db.insert_entry(
            conn,
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
):
    if meal_type not in ALLOWED_MEAL_TYPES:
        raise HTTPException(400, f"meal_type must be one of {sorted(ALLOWED_MEAL_TYPES)}")

    with db.get_conn() as conn:
        entry = db.insert_entry(
            conn,
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
def today():
    today_str = date.today().isoformat()
    with db.get_conn() as conn:
        entries = db.get_entries_for_date(conn, today_str)
        goals = db.get_goals(conn)
    entries = [_entry_to_public(e) for e in entries]
    return {"date": today_str, "entries": entries, "totals": _totals(entries), "goals": goals}


@app.get("/api/history")
def history(days: int = 14):
    end = date.today()
    start = end - timedelta(days=days - 1)
    with db.get_conn() as conn:
        entries = db.get_entries_between(conn, start.isoformat(), end.isoformat())

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
def get_entry(entry_id: int):
    with db.get_conn() as conn:
        entry = db.get_entry(conn, entry_id)
    if not entry:
        raise HTTPException(404, "entry not found")
    return _entry_to_public(entry)


@app.put("/api/entries/{entry_id}")
def update_entry(entry_id: int, payload: dict):
    allowed = {"meal_type", "total_calories", "protein_g", "carbs_g", "fat_g", "notes"}
    fields = {k: v for k, v in payload.items() if k in allowed}
    if "meal_type" in fields and fields["meal_type"] not in ALLOWED_MEAL_TYPES:
        raise HTTPException(400, f"meal_type must be one of {sorted(ALLOWED_MEAL_TYPES)}")
    with db.get_conn() as conn:
        if not db.get_entry(conn, entry_id):
            raise HTTPException(404, "entry not found")
        entry = db.update_entry(conn, entry_id, fields)
    return _entry_to_public(entry)


@app.delete("/api/entries/{entry_id}")
def delete_entry(entry_id: int):
    with db.get_conn() as conn:
        if not db.get_entry(conn, entry_id):
            raise HTTPException(404, "entry not found")
        db.delete_entry(conn, entry_id)
    return {"ok": True}


@app.get("/api/goals")
def get_goals():
    with db.get_conn() as conn:
        return db.get_goals(conn)


@app.put("/api/goals")
def set_goals(payload: dict):
    required = {"calories", "protein_g", "carbs_g", "fat_g"}
    if not required.issubset(payload):
        raise HTTPException(400, f"payload must include {sorted(required)}")
    with db.get_conn() as conn:
        return db.set_goals(
            conn,
            calories=payload["calories"],
            protein_g=payload["protein_g"],
            carbs_g=payload["carbs_g"],
            fat_g=payload["fat_g"],
        )


@app.get("/uploads/{filename}")
def get_upload(filename: str):
    path = (UPLOADS_DIR / filename).resolve()
    if UPLOADS_DIR.resolve() not in path.parents or not path.exists():
        raise HTTPException(404)
    return FileResponse(path)


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
