"""Shared test scaffolding: every test gets its own throwaway SQLite file and uploads directory, a
movable clock, and AI clients that fail loudly instead of making a paid request.

Run all tests (no extra dependencies):  backend/.venv/Scripts/python -m unittest discover -s backend/tests -t backend
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_IMPORT_DIR = tempfile.mkdtemp(prefix="cs-import-")
os.environ["CALORIE_DB_PATH"] = str(Path(_IMPORT_DIR) / "import.db")      # only so importing main can't touch a real DB
os.environ["CALORIE_UPLOADS_DIR"] = str(Path(_IMPORT_DIR) / "uploads")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import coach  # noqa: E402
import db  # noqa: E402
import main  # noqa: E402
import meal_plan as meal_plan_module  # noqa: E402
import tzutil  # noqa: E402
import vision  # noqa: E402


def _paid_call_blocked(*_a, **_k):
    raise AssertionError("a test tried to make a paid AI request — stub the AI function instead")


class AppTestCase(unittest.TestCase):
    """One isolated app instance per test."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self._saved = (db.DB_PATH, main.UPLOADS_DIR, auth.now, coach._client, vision._client, meal_plan_module._client)
        db.DB_PATH = self.tmp / "test.db"
        main.UPLOADS_DIR = self.tmp / "uploads"
        main.UPLOADS_DIR.mkdir()
        self.clock = [1_800_000_000.0]
        auth.now = lambda: self.clock[0]
        # No test may reach a paid model: the client factories explode, and tests stub the call sites.
        coach._client = vision._client = meal_plan_module._client = _paid_call_blocked
        db.init_db()
        self.addCleanup(self._restore)

    def _restore(self):
        (db.DB_PATH, main.UPLOADS_DIR, auth.now, coach._client, vision._client, meal_plan_module._client) = self._saved

    # ---- helpers ----
    def new_client(self, **kw) -> TestClient:
        kw.setdefault("raise_server_exceptions", False)
        return TestClient(main.app, **kw)

    def make_user(self, name="Test", pin=None, **profile) -> int:
        with db.get_conn() as conn:
            uid = db.create_user(conn, name, pin)["id"]
            if profile:
                db.set_profile(conn, uid, profile)
        return uid

    def sign_in(self, client: TestClient, user_id: int, pin=None) -> str:
        """Signs the client in and returns the CSRF token (also remembered on the client)."""
        body = {"user_id": user_id}
        if pin is not None:
            body["pin"] = pin
        r = client.post("/api/session", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        client.csrf = r.json()["csrf_token"]
        return client.csrf

    def call(self, client: TestClient, method: str, path: str, **kw):
        """Request with the client's CSRF header (as the real page sends it)."""
        headers = dict(kw.pop("headers", {}))
        if getattr(client, "csrf", None) and "X-CSRF-Token" not in headers:
            headers["X-CSRF-Token"] = client.csrf
        return client.request(method, path, headers=headers, **kw)

    def signed_in_client(self, user_id: int, pin=None, **kw) -> TestClient:
        c = self.new_client(**kw)
        self.sign_in(c, user_id, pin)
        return c

    def rows(self, sql: str, params=()):
        with db.get_conn() as conn:
            return [dict(r) for r in conn.execute(sql, params).fetchall()]

    def add_entry(self, user_id: int, *, calories=500, meal_type="lunch", image: str | None = None,
                  image2: str | None = None, created_at: str | None = None, items=None):
        created_at = created_at or tzutil.now_local_naive().isoformat(timespec="seconds")
        items = items if items is not None else [{"name": "x", "est_grams": 100, "calories": calories,
                                                    "protein_g": 10, "carbs_g": 50, "fat_g": 10}]
        with db.get_conn() as conn:
            return db.insert_entry(conn, user_id=user_id, created_at=created_at, meal_type=meal_type,
                                   source="photo" if image else "manual", items_json=json.dumps(items),
                                   total_calories=calories, protein_g=10, carbs_g=50, fat_g=10,
                                   confidence="high", image_path=image, image_path2=image2)

    def write_image(self, name: str, fmt: str = "JPEG", color=(200, 120, 40), size=(96, 64)) -> bytes:
        """A real, decodable image file in the uploads directory (not a placeholder string)."""
        from PIL import Image
        img = Image.new("RGB", size, color)
        for x in range(0, size[0], 4):          # some texture so different files have different bytes
            for y in range(0, size[1], 4):
                img.putpixel((x, y), ((x * 7 + color[0]) % 256, (y * 5 + color[1]) % 256, color[2]))
        buf = io.BytesIO()
        img.save(buf, fmt)
        (main.UPLOADS_DIR / name).write_bytes(buf.getvalue())
        return buf.getvalue()
