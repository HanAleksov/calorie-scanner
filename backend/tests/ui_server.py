"""A throw-away app instance for driving the real UI in a browser (never used in production).

    backend/.venv/Scripts/python backend/tests/ui_server.py [port]      (default 8423)

* Own temp database + uploads (synthetic people only). The real app code runs unmodified.
* AI calls are replaced by canned stubs — nothing here can reach a paid model.
* Test hooks live only in THIS file, under /api/__test/*:
    /api/__test/delay?path=/api/log-manual&ms=1500     slow a route down (to hold a request open)
    /api/__test/fail?status=500&times=1                make the next N state-changing requests fail
    /api/__test/expire?user=1                          delete that profile's sessions (simulate expiry)
    /api/__test/state                                  counters: requests seen per route
"""

import json
import os
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
TMP = Path(tempfile.mkdtemp(prefix="cs-ui-"))
os.environ["CALORIE_DB_PATH"] = str(TMP / "ui.db")
os.environ["CALORIE_UPLOADS_DIR"] = str(TMP / "uploads")

import asyncio  # noqa: E402

import uvicorn  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

import auth  # noqa: E402
import coach  # noqa: E402
import db  # noqa: E402
import main  # noqa: E402
import meal_plan as meal_plan_module  # noqa: E402
import tzutil  # noqa: E402
import vision  # noqa: E402


def _blocked(*_a, **_k):
    raise AssertionError("paid AI call attempted from the UI test server")


coach._client = vision._client = meal_plan_module._client = _blocked
vision.analyze_meal_photo = lambda images, lang="en", user_note=None: {
    "items": [{"name": "Test meal", "est_grams": 300, "calories": 520, "protein_g": 30, "carbs_g": 55, "fat_g": 18}],
    "total_calories": 520, "protein_g": 30, "carbs_g": 55, "fat_g": 18, "confidence": "high", "energy_score": 4.0}
vision.parse_scale_screenshot = lambda b, m: {"weight_kg": 65.2, "fat_mass_kg": None, "skeletal_muscle_kg": None,
                                              "body_water_pct": None, "body_fat_pct": None, "bmr_kcal": None, "protein_pct": None}
coach.generate_tip = lambda ctx, lang="en": "Stub tip"
coach.generate_analyst_note = lambda ctx, lang="en": "Stub coach note"
meal_plan_module.generate_meal_plan = lambda targets, notes="", lang="en": {
    "meals": [], "daily_totals": {"calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0}, "notes": "stub"}

HOOKS = {"delay": {}, "fail": {"status": 500, "times": 0}, "seen": {}}


@main.app.middleware("http")
async def test_hooks(request, call_next):
    path = request.url.path
    HOOKS["seen"][f"{request.method} {path}"] = HOOKS["seen"].get(f"{request.method} {path}", 0) + 1
    if path.startswith("/api/__test/"):
        q = request.query_params
        if path == "/api/__test/delay":
            HOOKS["delay"][q["path"]] = int(q["ms"])
        elif path == "/api/__test/fail":
            HOOKS["fail"] = {"status": int(q.get("status", 500)), "times": int(q.get("times", 1))}
        elif path == "/api/__test/expire":
            with db.get_conn() as conn:
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (int(q["user"]),))
        return JSONResponse({"hooks": HOOKS}, headers={"Cache-Control": "no-store"})  # a cached hook answer would fake results
    if request.method in ("POST", "PUT", "DELETE") and path.startswith("/api/") and path != "/api/session":
        if HOOKS["fail"]["times"] > 0:
            HOOKS["fail"]["times"] -= 1
            return JSONResponse({"detail": "injected failure"}, status_code=HOOKS["fail"]["status"])
    if path in HOOKS["delay"]:
        await asyncio.sleep(HOOKS["delay"][path] / 1000)
    return await call_next(request)


def _draw_food(path, kind):
    """Invented plates for the redesign screenshots (flat shapes, not photos of anything real)."""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (260, 260), (236, 226, 210))
    d = ImageDraw.Draw(img)
    d.ellipse((18, 18, 242, 242), fill=(250, 248, 244), outline=(214, 204, 190), width=4)
    if kind == "porridge":
        d.ellipse((46, 46, 214, 214), fill=(226, 196, 150))
        for x, y, c in [(100, 96, (176, 24, 48)), (140, 110, (40, 60, 150)), (120, 140, (200, 30, 52)), (86, 130, (50, 70, 160)), (156, 150, (186, 28, 50)), (110, 80, (40, 56, 140))]:
            d.ellipse((x - 14, y - 14, x + 14, y + 14), fill=c)
    elif kind == "chicken":
        d.ellipse((120, 56, 226, 150), fill=(196, 128, 60))
        d.ellipse((44, 110, 150, 206), fill=(246, 242, 232))
        for i in range(14):
            d.ellipse((58 + (i * 23) % 80, 124 + (i * 31) % 70, 70 + (i * 23) % 80, 134 + (i * 31) % 70), fill=(228, 222, 206))
        d.polygon([(150, 150), (206, 186), (170, 214)], fill=(66, 140, 66))
        d.ellipse((130, 62, 200, 112), fill=(176, 104, 44))
    else:  # yogurt
        d.ellipse((50, 50, 210, 210), fill=(252, 250, 246), outline=(226, 220, 210), width=3)
        d.ellipse((70, 70, 190, 190), fill=(244, 238, 226))
        for x, y in [(112, 104), (150, 96), (130, 134), (100, 140), (158, 138)]:
            d.ellipse((x - 12, y - 12, x + 12, y + 12), fill=(196, 30, 54))
        d.ellipse((120, 150, 150, 176), fill=(214, 170, 90))
    img.save(path, quality=90)


def seed_demo_profile(today):
    """One invented profile whose Today screen matches the approved concept's numbers (1440 of 2400 kcal)."""
    main.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    with db.get_conn() as conn:
        uid = db.create_user(conn, "Demo", None)["id"]
        db.set_profile(conn, uid, {"goal_type": "gain", "height_cm": 180, "weight_kg": 70, "age": 25, "sex": "male",
                                   "activity_level": "moderate"})
        db.set_goals(conn, uid, calories=2400, protein_g=150, carbs_g=270, fat_g=80, water_ml=2500)
        db.add_weight_entry(conn, uid, 70.0, f"{(today - timedelta(days=1)).isoformat()}T08:00:00")
        for d in range(1, 8):
            day = today - timedelta(days=d)
            for meal, hour, kcal in (("breakfast", "08", 700), ("lunch", "13", 900), ("dinner", "19", 800)):
                db.insert_entry(conn, user_id=uid, created_at=f"{day.isoformat()}T{hour}:00:00", meal_type=meal, source="manual",
                                items_json=json.dumps([{"name": "Seed " + meal, "est_grams": None}]), total_calories=kcal,
                                protein_g=45, carbs_g=80, fat_g=25, confidence="manual")
        for name, kind, hour, meal, item, kcal, p, c, f in (
            ("demo-porridge.jpg", "porridge", "08:10", "snack", "Oats with berries", 420, 28, 52, 12),
            ("demo-chicken.jpg", "chicken", "13:05", "lunch", "Chicken with rice", 720, 42, 78, 22),
            ("demo-yogurt.jpg", "yogurt", "15:40", "snack", "Yogurt with berries", 300, 20, 32, 14),
        ):
            _draw_food(main.UPLOADS_DIR / name, kind)
            db.insert_entry(conn, user_id=uid, created_at=f"{today.isoformat()}T{hour}:00", meal_type=meal, source="photo",
                            items_json=json.dumps([{"name": item, "est_grams": 250, "calories": kcal, "protein_g": p, "carbs_g": c, "fat_g": f}]),
                            total_calories=kcal, protein_g=p, carbs_g=c, fat_g=f, confidence="high", image_path=name)
    with db.get_conn() as conn:
        db.add_water(conn, uid, 1000, f"{today.isoformat()}T09:00:00")


def seed():
    today = tzutil.today_local()
    db.init_db()
    with db.get_conn() as conn:
        def person(name, pin, goal, weights, cals, intake, auto=1, **profile):
            uid = db.create_user(conn, name, pin)["id"]
            db.set_profile(conn, uid, {"goal_type": goal, "height_cm": 176, "weight_kg": weights[-1], "age": 20, "sex": "male",
                                       "activity_level": "moderate", **profile})
            db.set_goals(conn, uid, calories=cals, protein_g=140, carbs_g=380, fat_g=80, water_ml=2600)
            db.set_auto_apply_targets(conn, uid, bool(auto))
            for i, w in enumerate(weights):
                d = today - timedelta(days=len(weights) - i)
                db.add_weight_entry(conn, uid, w, f"{d.isoformat()}T08:00:00")
            for d in range(14):
                day = today - timedelta(days=d)
                for meal, share in (("breakfast", .3), ("lunch", .4), ("dinner", .3)):
                    db.insert_entry(conn, user_id=uid, created_at=f"{day.isoformat()}T{ {'breakfast': '08', 'lunch': '13', 'dinner': '19'}[meal] }:00:00",
                                    meal_type=meal, source="manual", items_json=json.dumps([{"name": "Seed " + meal, "est_grams": None}]),
                                    total_calories=round(intake * share), protein_g=30, carbs_g=60, fat_g=15, confidence="manual")
            return uid
        anna = person("Anna", None, "gain", [65.0] * 20, 2500, 2500)                 # flat weight + on target -> analyst raises it
        boris = person("Boris", "1234", "lose", [80.0] * 20, 2200, 2200, height_cm=178)
        ceci = person("Ceci", None, "maintain", [60.0] * 20, 2000, 2000)
        dani = person("Dani", None, "gain", [65.0] * 20, 2500, 2500, auto=0)         # same, but auto-apply is off -> unchanged
    seed_demo_profile(today)
    # a real photo entry for Anna
    main.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    from PIL import Image
    Image.new("RGB", (120, 80), (200, 120, 40)).save(main.UPLOADS_DIR / "anna-photo.jpg")
    with db.get_conn() as conn:
        db.insert_entry(conn, user_id=anna, created_at=tzutil.now_local_naive().isoformat(timespec="seconds"), meal_type="snack",
                        source="photo", items_json=json.dumps([{"name": "Photo snack", "est_grams": 100, "calories": 200,
                                                                "protein_g": 5, "carbs_g": 30, "fat_g": 6}]),
                        total_calories=200, protein_g=5, carbs_g=30, fat_g=6, confidence="high", image_path="anna-photo.jpg")


if __name__ == "__main__":
    seed()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8423
    print(f"UI test server on :{port}  data in {TMP}", flush=True)
    uvicorn.run(main.app, host="127.0.0.1", port=port, log_level="warning")
