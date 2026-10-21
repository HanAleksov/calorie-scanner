"""Archive / verify / restore, with real image files and deliberate corruption."""

import hashlib
import io
import json
import shutil
import sqlite3
import zipfile
from pathlib import Path

import db
import main
from tests.base import AppTestCase
from tools import backup, db_snapshot


class BackupRestoreTests(AppTestCase):
    def setUp(self):
        super().setUp()
        self.a, self.b = self.make_user("Ana"), self.make_user("Bo", pin="1234", weight_kg=70)
        self.photos = {
            "a1.jpg": self.write_image("a1.jpg", "JPEG", (210, 120, 40)),
            "a2.png": self.write_image("a2.png", "PNG", (20, 180, 90)),
            "b1.webp": self.write_image("b1.webp", "WEBP", (30, 60, 220)),
            "orphan.jpg": self.write_image("orphan.jpg", "JPEG", (90, 90, 90)),     # on disk, no entry
        }
        self.add_entry(self.a, calories=640, image="a1.jpg", image2="a2.png")
        self.add_entry(self.b, calories=380, image="b1.webp")
        self.add_entry(self.b, calories=200, image="vanished.jpg")                   # entry whose file is gone
        self.add_entry(self.a, calories=90)
        with db.get_conn() as conn:
            db.add_weight_entry(conn, self.a, 65.0, "2026-03-18T09:12:00", fat_mass_kg=12.1, muscle_mass_kg=31.5, water_pct=55.2)
            db.set_goals(conn, self.a, calories=2780, protein_g=140, carbs_g=410, fat_g=62, water_ml=2500)
            db.add_analyst_log(conn, self.a, created_at="2026-03-12T10:05:00", old_calories=2880, new_calories=2780,
                               reason_text="r", coach_note="c")
            db.set_day_mark(conn, self.a, "2026-10-08", "complete")
        self.out = self.tmp / "backups"
        self.src_db = db.DB_PATH

    def make_archive(self):
        return backup.create(self.src_db, main.UPLOADS_DIR, self.out)

    def snap(self, path):
        return db_snapshot.snapshot(path, with_rows=True)

    # ---------- the good path ----------
    def test_create_verify_restore_round_trip_is_lossless(self):
        before_db_hash = hashlib.sha256(self.src_db.read_bytes()).hexdigest()
        before = self.snap(self.src_db)
        archive = self.make_archive()
        self.assertEqual(hashlib.sha256(self.src_db.read_bytes()).hexdigest(), before_db_hash,
                         "creating a backup must not modify the source database")

        report = backup.verify(archive)
        self.assertTrue(report["ok"], report["problems"])
        m = report["manifest"]
        self.assertEqual(m["integrity_check"], "ok")
        self.assertEqual(m["photos_present"], 4)
        self.assertEqual(m["photos_referenced"], 4)                  # a1, a2, b1, vanished
        self.assertEqual(m["photos_referenced_but_missing"], ["vanished.jpg"])
        self.assertEqual(m["photos_unreferenced"], ["orphan.jpg"])
        self.assertEqual(m["table_counts"]["entries"], 4)

        new_db, new_up = self.tmp / "restored" / "calorie_scanner.db", self.tmp / "restored" / "uploads"
        result = backup.restore(archive, new_db, new_up)
        self.assertEqual(result["photos"], 4)
        cmp = db_snapshot.compare(before, self.snap(new_db))
        self.assertTrue(cmp["identical"], cmp)
        for name, original in self.photos.items():
            self.assertEqual((new_up / name).read_bytes(), original, name)   # every photo, byte for byte
        self.assertEqual({p.name for p in new_up.iterdir()}, set(self.photos))

    def test_the_restored_copy_actually_serves_photos_through_the_app(self):
        archive = self.make_archive()
        new_db, new_up = self.tmp / "r2" / "calorie_scanner.db", self.tmp / "r2" / "uploads"
        backup.restore(archive, new_db, new_up)
        db.DB_PATH, main.UPLOADS_DIR = new_db, new_up
        c = self.signed_in_client(self.a)
        self.assertEqual(c.get("/uploads/a1.jpg").content, self.photos["a1.jpg"])
        self.assertEqual(c.get("/uploads/a2.png").content, self.photos["a2.png"])
        self.assertEqual(c.get("/uploads/b1.webp").status_code, 404)        # still not Ana's
        self.assertEqual(c.get("/api/goals").json()["calories"], 2780)

    def test_backup_taken_while_a_write_is_in_flight_contains_only_committed_data(self):
        writer = sqlite3.connect(self.src_db)
        writer.execute("INSERT INTO water_log (user_id, logged_at, ml) VALUES (?, '2026-10-20T10:00:00', 999)", (self.a,))
        try:                                                        # transaction deliberately left open
            archive = self.make_archive()
        finally:
            writer.rollback()
            writer.close()
        self.assertTrue(backup.verify(archive)["ok"])
        self.assertEqual(backup.verify(archive)["manifest"]["table_counts"]["water_log"], 0)

    # ---------- corruption is caught, nothing is restored ----------
    def tamper(self, archive, change):
        out = archive.with_name("tampered.zip")
        with zipfile.ZipFile(archive) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                new = change(item.filename, data)
                if new is not None:
                    zout.writestr(item.filename, new)
            change(None, None)
        return out

    def test_a_flipped_byte_in_a_photo_is_detected_and_blocks_restore(self):
        archive = self.make_archive()

        def flip(name, data):
            if name == "uploads/a1.jpg":
                return data[:20] + bytes([data[20] ^ 0xFF]) + data[21:]
            return data

        bad = self.tamper(archive, flip)
        report = backup.verify(bad)
        self.assertFalse(report["ok"])
        self.assertTrue(any("hash mismatch: uploads/a1.jpg" in p for p in report["problems"]), report["problems"])
        target = self.tmp / "nope"
        with self.assertRaises(backup.BackupError):
            backup.restore(bad, target / "x.db", target / "up")
        self.assertFalse(target.exists(), "a failed verification must not leave a half-restored copy")

    def test_a_missing_or_extra_member_is_detected(self):
        archive = self.make_archive()
        dropped = self.tamper(archive, lambda n, d: None if n == "uploads/b1.webp" else d)
        self.assertTrue(any("missing from archive: uploads/b1.webp" in p for p in backup.verify(dropped)["problems"]))

        def add_extra(name, data):
            return data
        extra = archive.with_name("extra.zip")
        shutil.copy(archive, extra)
        with zipfile.ZipFile(extra, "a") as z:
            z.writestr("uploads/surprise.jpg", b"x")
        self.assertTrue(any("not listed in manifest" in p for p in backup.verify(extra)["problems"]))

    def test_a_corrupted_database_fails_verification(self):
        archive = self.make_archive()
        bad = self.tamper(archive, lambda n, d: d[: len(d) // 2] if n == "db/calorie_scanner.db" else d)
        self.assertFalse(backup.verify(bad)["ok"])

    def test_not_a_zip_and_missing_manifest(self):
        junk = self.tmp / "junk.zip"
        junk.write_bytes(b"not a zip")
        self.assertFalse(backup.verify(junk)["ok"])
        nomanifest = self.tmp / "nm.zip"
        with zipfile.ZipFile(nomanifest, "w") as z:
            z.writestr("db/calorie_scanner.db", b"x")
        self.assertIn("MANIFEST.json missing", backup.verify(nomanifest)["problems"])

    # ---------- restore never overwrites ----------
    def test_restore_refuses_to_overwrite_an_existing_database_or_uploads(self):
        archive = self.make_archive()
        with self.assertRaises(backup.BackupError):
            backup.restore(archive, self.src_db, self.tmp / "fresh-uploads")          # live DB path
        busy = self.tmp / "busy"
        busy.mkdir()
        (busy / "keep.jpg").write_bytes(b"precious")
        with self.assertRaises(backup.BackupError):
            backup.restore(archive, self.tmp / "other.db", busy)
        self.assertEqual((busy / "keep.jpg").read_bytes(), b"precious")
        self.assertFalse((self.tmp / "other.db").exists())

    def test_restore_ignores_the_app_environment_paths(self):
        import os
        archive = self.make_archive()
        os.environ["CALORIE_DB_PATH"] = str(self.src_db)                              # pretend this is production
        try:
            with self.assertRaises(backup.BackupError):
                backup.restore(archive, self.src_db, self.tmp / "u")
        finally:
            os.environ["CALORIE_DB_PATH"] = str(self.tmp / "irrelevant.db")

    def test_command_line_exit_codes(self):
        archive = self.make_archive()
        self.assertEqual(backup.main(["verify", str(archive)]), 0)
        self.assertEqual(backup.main(["restore", str(archive), "--db", str(self.tmp / "cli" / "a.db"),
                                      "--uploads", str(self.tmp / "cli" / "u")]), 0)
        self.assertEqual(backup.main(["restore", str(archive), "--db", str(self.src_db), "--uploads", str(self.tmp / "u2")]), 1)
        self.assertEqual(backup.main(["verify", str(self.tmp / "missing.zip")]), 1)
        self.assertEqual(backup.main(["create", "--db", str(self.tmp / "nope.db"), "--uploads", str(main.UPLOADS_DIR),
                                      "--out", str(self.out)]), 1)

    def test_manifest_lists_every_file_with_a_hash(self):
        archive = self.make_archive()
        with zipfile.ZipFile(archive) as z:
            manifest = json.loads(z.read("MANIFEST.json"))
            for name, meta in manifest["files"].items():
                self.assertEqual(hashlib.sha256(z.read(name)).hexdigest(), meta["sha256"])
        self.assertEqual(len(manifest["files"]), 1 + 4)
