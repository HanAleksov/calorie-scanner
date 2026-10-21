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
