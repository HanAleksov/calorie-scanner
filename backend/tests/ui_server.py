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
    """Fallback plates (flat shapes) used only when no demo photographs are available."""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (260, 260), (236, 226, 210))
    d = ImageDraw.Draw(img)
    d.ellipse((18, 18, 242, 242), fill=(250, 248, 244), outline=(214, 204, 190), width=4)
    if kind == 0:
        d.ellipse((46, 46, 214, 214), fill=(226, 196, 150))
        for x, y, col in [(100, 96, (176, 24, 48)), (140, 110, (40, 60, 150)), (120, 140, (200, 30, 52)), (86, 130, (50, 70, 160))]:
            d.ellipse((x - 14, y - 14, x + 14, y + 14), fill=col)
    elif kind == 1:
        d.ellipse((120, 56, 226, 150), fill=(196, 128, 60))
        d.ellipse((44, 110, 150, 206), fill=(246, 242, 232))
        d.polygon([(150, 150), (206, 186), (170, 214)], fill=(66, 140, 66))
    else:
        d.ellipse((50, 50, 210, 210), fill=(252, 250, 246), outline=(226, 220, 210), width=3)
        d.ellipse((70, 70, 190, 190), fill=(244, 238, 226))
        for x, y in [(112, 104), (150, 96), (130, 134)]:
            d.ellipse((x - 12, y - 12, x + 12, y + 12), fill=(196, 30, 54))
    img.save(path, quality=90)


DEMO_PHOTO_DIR = Path(__file__).resolve().parent / "demo_photos"   # git-ignored: drop any food photographs here


def make_demo_photos(count=4):
    """Photo files for the demo meals. Real food photographs from backend/tests/demo_photos/ when there are any (if
    there are fewer than `count`, different crops of them are used so the rows don't all look alike); otherwise drawn plates."""
    from PIL import Image
    main.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    sources = sorted(p for ext in ("*.jpg", "*.jpeg", "*.png", "*.webp") for p in DEMO_PHOTO_DIR.glob(ext)) if DEMO_PHOTO_DIR.is_dir() else []
    names = []
    if not sources:
        for n in range(count):
            name = f"demo-{n}.jpg"
            _draw_food(main.UPLOADS_DIR / name, n % 3)
            names.append(name)
        return names, False
    crops = [None, (0.0, 0.10, 0.5, 0.55), (0.5, 0.0, 1.0, 0.45), (0.2, 0.25, 0.7, 0.85)]     # fractions of the picture
    for n in range(count):
        im = Image.open(sources[n % len(sources)]).convert("RGB")
        box = crops[(n // len(sources)) % len(crops)]
        if box:
            w, h = im.size
            im = im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))
        im.thumbnail((720, 720))
        name = f"demo-{n}.jpg"
        im.save(main.UPLOADS_DIR / name, quality=88)
        names.append(name)
    return names, True


def _history(conn, uid, today, goal_kcal):
    for d in range(1, 8):
        day = today - timedelta(days=d)
        for meal, hour, share in (("breakfast", "08", .3), ("lunch", "13", .4), ("dinner", "19", .3)):
            db.insert_entry(conn, user_id=uid, created_at=f"{day.isoformat()}T{hour}:00:00", meal_type=meal, source="manual",
                            items_json=json.dumps([{"name": "Seed " + meal, "est_grams": None}]), total_calories=round(goal_kcal * share),
                            protein_g=45, carbs_g=80, fat_g=25, confidence="manual")


def seed_demo_profile(today):
    """Invented profiles for the redesign screenshots. "Demo" matches the approved concept's numbers (1440 of 2400 kcal);
    the others show the edge states: an empty day, values over target (gain and lose goals) and very long names."""
    photos, _real = make_demo_photos()
    long_name = "Домашна мусака със сирене, патладжани и картофи, подправена с копър и чубрица, сервирана със зелена салата и тъмен хляб"

    def person(conn, name, goal, goals, weight, entries, water, h=180):
        uid = db.create_user(conn, name, None)["id"]
        db.set_profile(conn, uid, {"goal_type": goal, "height_cm": h, "weight_kg": weight, "age": 25, "sex": "male", "activity_level": "moderate"})
        db.set_goals(conn, uid, calories=goals[0], protein_g=goals[1], carbs_g=goals[2], fat_g=goals[3], water_ml=goals[4])
        db.add_weight_entry(conn, uid, weight, f"{(today - timedelta(days=1)).isoformat()}T08:00:00")
        _history(conn, uid, today, goals[0])
        for e in entries:
            db.insert_entry(conn, user_id=uid, created_at=f"{today.isoformat()}T{e['at']}:00", meal_type=e["meal"], source="photo" if e.get("photo") is not None else "manual",
                            items_json=json.dumps([{"name": e["name"], "est_grams": 250, "calories": e["kcal"], "protein_g": e["p"], "carbs_g": e["c"], "fat_g": e["f"]}]),
                            total_calories=e["kcal"], protein_g=e["p"], carbs_g=e["c"], fat_g=e["f"], confidence=e.get("conf", "high"),
                            notes=e.get("note"), energy_score=e.get("energy"),
                            image_path=photos[e["photo"] % len(photos)] if e.get("photo") is not None else None)
        if water:
            db.add_water(conn, uid, water, f"{today.isoformat()}T09:00:00")
        return uid

    with db.get_conn() as conn:
        person(conn, "Demo", "gain", (2400, 150, 270, 80, 2500), 70.0, [
            dict(at="08:10", meal="snack", name="Овесена каша с боровинки", kcal=420, p=28, c=52, f=12, photo=0),
            dict(at="13:05", meal="lunch", name="Пилешко с ориз", kcal=720, p=42, c=78, f=22, photo=1),
            dict(at="15:40", meal="snack", name="Кисело мляко с плодове", kcal=300, p=20, c=32, f=14, photo=2),
        ], 1000)
        person(conn, "Demo Empty", "gain", (2400, 150, 270, 80, 2500), 70.0, [], 0)
        person(conn, "Demo Over", "gain", (2400, 150, 270, 80, 2500), 70.0, [
            dict(at="08:00", meal="breakfast", name="Палачинки с извара", kcal=820, p=60, c=90, f=30, photo=0, energy=4),
            dict(at="13:00", meal="lunch", name="Телешко със задушени зеленчуци", kcal=1010, p=70, c=110, f=40, photo=1, energy=4),
            dict(at="19:00", meal="dinner", name="Паста с пиле и сметанов сос", kcal=930, p=55, c=100, f=32, photo=3, energy=3),
        ], 2800)
        person(conn, "Demo Over Lose", "lose", (1900, 120, 200, 60, 2500), 78.0, [
            dict(at="08:00", meal="breakfast", name="Тост с яйца и авокадо", kcal=640, p=34, c=58, f=34, photo=0),
            dict(at="13:00", meal="lunch", name="Бургер с картофки", kcal=1040, p=48, c=98, f=52, photo=1),
            dict(at="19:00", meal="dinner", name="Салата с печено пиле", kcal=570, p=44, c=40, f=24, photo=2),
        ], 1200)
        person(conn, "Demo Long", "gain", (2400, 150, 270, 80, 2500), 70.0, [
            dict(at="08:20", meal="breakfast", name=long_name, kcal=640, p=36, c=58, f=28, photo=3, conf="low", energy=3,
                 note="Порция около 400 г, без хляб; сиренето е повече от обикновено"),
            dict(at="13:10", meal="lunch", name="Пилешко с ориз", kcal=720, p=42, c=78, f=22, photo=1, energy=4),
        ], 1500)


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
