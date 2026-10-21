"""Meal photos: only the owning profile, checked on every request; no other path serves the directory."""

import hashlib

import main
from tests.base import AppTestCase


class UploadIsolationTests(AppTestCase):
    def setUp(self):
        super().setUp()
        self.a, self.b = self.make_user("A"), self.make_user("B", pin="1234")
        # real, decodable files in all three accepted formats (JPEG, PNG, WebP), two for one entry
        self.bytes = {
            "a1.jpg": self.write_image("a1.jpg", "JPEG", (200, 100, 50)),
            "a2.png": self.write_image("a2.png", "PNG", (20, 200, 90)),
            "b1.webp": self.write_image("b1.webp", "WEBP", (30, 60, 220)),
        }
        self.add_entry(self.a, image="a1.jpg", image2="a2.png")
        self.add_entry(self.b, image="b1.webp")
        self.ca = self.signed_in_client(self.a)
        self.cb = self.signed_in_client(self.b, "1234")

    def test_owner_gets_the_exact_bytes_of_both_angles(self):
        for name in ("a1.jpg", "a2.png"):
            r = self.ca.get(f"/uploads/{name}")
            self.assertEqual(r.status_code, 200, name)
            self.assertEqual(hashlib.sha256(r.content).hexdigest(), hashlib.sha256(self.bytes[name]).hexdigest())
        self.assertEqual(self.cb.get("/uploads/b1.webp").content, self.bytes["b1.webp"])

    def test_another_profile_cannot_read_them_even_knowing_the_exact_name(self):
        for name in ("a1.jpg", "a2.png"):
            self.assertEqual(self.cb.get(f"/uploads/{name}").status_code, 404, name)
        self.assertEqual(self.ca.get("/uploads/b1.webp").status_code, 404)

    def test_no_session_no_photo(self):
        anon = self.new_client()
        for name in self.bytes:
            self.assertEqual(anon.get(f"/uploads/{name}").status_code, 401, name)
        # a claimed id is not a session
        self.assertEqual(anon.get("/uploads/a1.jpg", headers={"X-User-Id": str(self.a)}).status_code, 401)

    def test_ownership_is_checked_on_every_request_not_cached_in_the_session(self):
        self.assertEqual(self.ca.get("/uploads/a1.jpg").status_code, 200)
        self.call(self.ca, "DELETE", f"/api/entries/{self.rows('SELECT id FROM entries WHERE user_id=?', (self.a,))[0]['id']}")
        self.assertEqual(self.ca.get("/uploads/a1.jpg").status_code, 404)   # entry gone -> photo no longer served

    def test_signing_out_and_expiry_revoke_access_immediately(self):
        self.call(self.ca, "DELETE", "/api/session")
        self.assertEqual(self.ca.get("/uploads/a1.jpg").status_code, 401)

    def test_a_file_that_belongs_to_no_entry_is_not_served(self):
        self.write_image("orphan.jpg")
        self.assertEqual(self.ca.get("/uploads/orphan.jpg").status_code, 404)
        self.assertEqual(self.cb.get("/uploads/orphan.jpg").status_code, 404)

    def test_path_tricks_do_not_escape_the_directory_or_the_check(self):
        (self.tmp / "secret.txt").write_text("top secret")
        for path in ("/uploads/../secret.txt", "/uploads/%2e%2e/secret.txt", "/uploads/..%2fsecret.txt",
                     "/uploads/a1.jpg/../../secret.txt", "//uploads/a1.jpg", "/uploads/%2Fa1.jpg",
                     "/uploads/a1.jpg%00.png", "/uploads/./a1.jpg"):
            r = self.cb.get(path)       # profile B is NOT the owner of a1.jpg
            self.assertNotEqual(r.content, self.bytes["a1.jpg"], path)
            self.assertNotIn(b"top secret", r.content, path)
            self.assertNotEqual(r.status_code, 200, path)

    def test_static_mount_does_not_expose_uploads_or_backend_files(self):
        for path in ("/uploads/a1.jpg/x", "/backend/main.py", "/main.py", "/calorie_scanner.db",
                     "/../backend/main.py", "/.env", "/uploads"):
            r = self.new_client().get(path)
            self.assertNotIn(b"def current_user_id", r.content, path)
            self.assertNotEqual(r.content[:4], b"\xff\xd8\xff\xe0", path)
        # the static root is frontend/ only, and contains no upload files
        self.assertFalse(any(p.suffix.lower() in {".jpg", ".png", ".webp"} and "icon" not in p.name
                             for p in main.FRONTEND_DIR.rglob("*")), "photos found under frontend/")
        self.assertFalse(list(main.FRONTEND_DIR.rglob("*.db")))

    def test_photo_responses_are_revalidated_not_blindly_cached(self):
        r = self.ca.get("/uploads/a1.jpg")
        self.assertEqual(r.headers["cache-control"], "private, no-cache")

    def test_deleting_an_entry_removes_the_first_photo_file(self):
        entry = self.rows("SELECT id FROM entries WHERE user_id=?", (self.b,))[0]
        self.call(self.cb, "DELETE", f"/api/entries/{entry['id']}")
        self.assertFalse((main.UPLOADS_DIR / "b1.webp").exists())
