"""Archive / verify / restore, with real image files and deliberate corruption."""

import hashlib
import io
import json
import shutil
import sqlite3
import zipfile
from datetime import datetime
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
        return db_snapshot.snapshot(path)

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
        self.assertEqual(m["photos_referenced"], 3)                  # a1, a2, b1
        self.assertEqual(m["photos_referenced_but_missing"], [])
        self.assertEqual(report["incomplete"], [])
        self.assertEqual(m["photos_unreferenced"], ["orphan.jpg"])
        self.assertEqual(m["table_counts"]["entries"], 3)

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

    # ---------- an archive that is not a whole backup must never pass ----------
    def raw_archive(self, name, members):
        path = self.tmp / name
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for member, data in members:
                z.writestr(member, data)
        return path

    def good_manifest(self):
        with zipfile.ZipFile(self.make_archive()) as z:
            return json.loads(z.read("MANIFEST.json"))

    def test_an_archive_with_only_a_manifest_is_not_valid(self):
        only_manifest = self.raw_archive("only-manifest.zip", [("MANIFEST.json", json.dumps(self.good_manifest()))])
        report = backup.verify(only_manifest)
        self.assertFalse(report["ok"])
        self.assertTrue(any("database (db/calorie_scanner.db) is not in the archive" in p for p in report["problems"]), report)
        with self.assertRaises(backup.BackupError):
            backup.restore(only_manifest, self.tmp / "x" / "a.db", self.tmp / "x" / "u")
        self.assertEqual(backup.main(["verify", str(only_manifest)]), 1)

    def test_a_bare_manifest_with_nothing_in_it_is_not_valid(self):
        bare = self.raw_archive("bare.zip", [("MANIFEST.json", json.dumps({"format_version": 1, "files": {}, "table_counts": {}}))])
        report = backup.verify(bare)
        self.assertFalse(report["ok"])
        self.assertTrue(report["problems"], "an archive without a database must name why it is rejected")

    def test_a_manifest_that_does_not_list_the_database_is_not_valid(self):
        m = self.good_manifest()
        del m["files"]["db/calorie_scanner.db"]
        with zipfile.ZipFile(self.make_archive_again()) as z:
            members = [(n, z.read(n)) for n in z.namelist() if n != "MANIFEST.json"]
        bad = self.raw_archive("no-db-listed.zip", members + [("MANIFEST.json", json.dumps(m))])
        report = backup.verify(bad)
        self.assertFalse(report["ok"])
        self.assertTrue(any("does not list the database" in p for p in report["problems"]), report)

    def make_archive_again(self):
        return backup.create(self.src_db, main.UPLOADS_DIR, self.out, now=datetime(2030, 1, 1, 0, 0, 0))

    def test_malformed_manifests_are_reported_not_crashed_on(self):
        good = self.good_manifest()
        broken = {
            "a list": [],
            "no files": {**good, "files": {}},
            "files not a dict": {**good, "files": []},
            "bad sha": {**good, "files": {**good["files"], "db/calorie_scanner.db": {"sha256": "zz", "bytes": 1}}},
            "bytes not a number": {**good, "files": {**good["files"], "db/calorie_scanner.db": {**good["files"]["db/calorie_scanner.db"], "bytes": "9"}}},
            "no table counts": {k: v for k, v in good.items() if k != "table_counts"},
            "wrong version": {**good, "format_version": 99},
            "integrity claim not ok": {**good, "integrity_check": "malformed"},
            "missing list": {k: v for k, v in good.items() if k != "photos_referenced_but_missing"},
            "path traversal": {**good, "files": {**good["files"], "uploads/../../evil": good["files"]["db/calorie_scanner.db"]}},
        }
        with zipfile.ZipFile(self.make_archive_again()) as z:
            members = [(n, z.read(n)) for n in z.namelist() if n != "MANIFEST.json"]
        for label, manifest in broken.items():
            with self.subTest(label):
                path = self.raw_archive(f"m-{label.replace(' ', '-')}.zip", members + [("MANIFEST.json", json.dumps(manifest))])
                self.assertFalse(backup.verify(path)["ok"], label)
        not_json = self.raw_archive("m-notjson.zip", members + [("MANIFEST.json", "{nope")])
        self.assertFalse(backup.verify(not_json)["ok"])

    def test_unexpected_or_duplicate_members_are_rejected(self):
        with zipfile.ZipFile(self.make_archive_again()) as z:
            members = [(n, z.read(n)) for n in z.namelist()]
        for label, extra in {"traversal": "../escape.txt", "nested": "uploads/sub/x.jpg", "root file": "notes.txt"}.items():
            with self.subTest(label):
                path = self.raw_archive(f"x-{label.replace(' ', '-')}.zip", members + [(extra, b"x")])
                report = backup.verify(path)
                self.assertFalse(report["ok"])
                self.assertTrue(any("unexpected member" in p for p in report["problems"]), report["problems"])
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")                            # the zip module warns about the duplicate name
            dup = self.raw_archive("dup.zip", members + [("uploads/a1.jpg", b"different bytes")])
        self.assertFalse(backup.verify(dup)["ok"])

    def test_create_refuses_a_missing_uploads_directory(self):
        with self.assertRaises(backup.BackupError):
            backup.create(self.src_db, self.tmp / "no-such-folder", self.out)
        self.assertEqual(backup.main(["create", "--db", str(self.src_db), "--uploads", str(self.tmp / "no-such-folder"),
                                      "--out", str(self.out)]), 1)
        self.assertEqual(list(self.out.glob("*.zip")) if self.out.exists() else [], [])

    def test_create_leaves_no_partial_file_behind(self):
        archive = self.make_archive()
        self.assertEqual([p.name for p in self.out.iterdir()], [archive.name])

    def lose_a_photo_then_back_up(self):
        (main.UPLOADS_DIR / "b1.webp").unlink()                       # an entry still points at it
        return self.make_archive_again()

    def test_a_missing_photo_makes_the_archive_incomplete(self):
        archive = self.lose_a_photo_then_back_up()
        report = backup.verify(archive)
        self.assertFalse(report["ok"])
        self.assertEqual(report["problems"], [])                      # internally consistent ...
        self.assertEqual(len(report["incomplete"]), 1)                # ... but not a whole backup
        self.assertIn("b1.webp", report["incomplete"][0])
        self.assertEqual(report["manifest"]["photos_referenced_but_missing"], ["b1.webp"])

    def test_an_incomplete_archive_exits_2_and_cannot_be_restored_by_default(self):
        archive = self.lose_a_photo_then_back_up()
        self.assertEqual(backup.main(["verify", str(archive)]), 2)
        self.assertEqual(backup.main(["create", "--db", str(self.src_db), "--uploads", str(main.UPLOADS_DIR),
                                      "--out", str(self.tmp / "other-out")]), 2)
        target = self.tmp / "refused"
        self.assertEqual(backup.main(["restore", str(archive), "--db", str(target / "a.db"), "--uploads", str(target / "u")]), 1)
        self.assertFalse(target.exists())
        # disaster recovery can still take what exists, and says so
        result = backup.restore(archive, target / "a.db", target / "u", allow_incomplete=True)
        self.assertEqual(len(result["incomplete"]), 1)
        self.assertEqual(backup.main(["restore", str(archive), "--db", str(self.tmp / "dr" / "a.db"),
                                      "--uploads", str(self.tmp / "dr" / "u"), "--allow-incomplete"]), 0)

    def test_a_manifest_that_hides_a_missing_photo_is_still_caught(self):
        """The database inside the archive is the authority, not the manifest's own claim."""
        archive = self.lose_a_photo_then_back_up()
        with zipfile.ZipFile(archive) as z:
            members = [(n, z.read(n)) for n in z.namelist() if n != "MANIFEST.json"]
            manifest = json.loads(z.read("MANIFEST.json"))
        manifest["photos_referenced_but_missing"] = []
        lying = self.raw_archive("lying.zip", members + [("MANIFEST.json", json.dumps(manifest))])
        self.assertFalse(backup.verify(lying)["ok"])
        self.assertEqual(len(backup.verify(lying)["incomplete"]), 1)

    # ---------- fingerprints: "was anything written during the backup window?" ----------
    def fp(self, db=None, uploads=None):
        return backup.fingerprint(db or self.src_db, uploads or main.UPLOADS_DIR)

    def test_fingerprints_before_and_after_create_are_equal_when_nothing_wrote(self):
        before = self.fp()
        self.make_archive()
        after = self.fp()
        self.assertEqual(backup.compare_fingerprints(before, after, same_db=True), [])
        self.assertEqual(set(before["photos"]), set(self.photos))

    def test_a_write_during_the_window_is_noticed(self):
        before = self.fp()
        with db.get_conn() as conn:
            db.add_water(conn, self.a, 250, "2026-10-21T10:00:00")
        self.assertTrue(any("database file changed" in p for p in backup.compare_fingerprints(before, self.fp(), same_db=True)))
        (main.UPLOADS_DIR / "late.jpg").write_bytes(b"arrived during the window")
        problems = backup.compare_fingerprints(before, self.fp(), same_db=True)
        self.assertTrue(any("only in the second: late.jpg" in p for p in problems), problems)

    def test_a_restored_uploads_folder_matches_the_source_photo_for_photo(self):
        source = self.fp()
        archive = self.make_archive()
        new_db, new_up = self.tmp / "fp-restored" / "calorie_scanner.db", self.tmp / "fp-restored" / "uploads"
        backup.restore(archive, new_db, new_up)
        restored = self.fp(new_db, new_up)
        self.assertEqual(backup.compare_fingerprints(source, restored), [])           # same photos, byte for byte
        self.assertNotEqual(source["db_sha256"], restored["db_sha256"])                # the db file itself is a fresh copy
        (new_up / "a1.jpg").write_bytes(b"x")
        self.assertTrue(any("photo differs: a1.jpg" in p for p in backup.compare_fingerprints(source, self.fp(new_db, new_up))))

    def test_backup_works_from_read_only_files(self):
        """The server procedure mounts the live volume read-only; a read-only database file must still be backed up."""
        import os
        import stat
        paths = [self.src_db] + [p for p in main.UPLOADS_DIR.iterdir()]
        for p in paths:
            os.chmod(p, stat.S_IREAD)
        try:
            archive = self.make_archive()
            fp = self.fp()
        finally:
            for p in paths:
                os.chmod(p, stat.S_IWRITE | stat.S_IREAD)
        self.assertTrue(backup.verify(archive)["ok"])
        self.assertEqual(set(fp["photos"]), set(self.photos))

    def test_fingerprint_command_line(self):
        a, b = self.tmp / "fa.json", self.tmp / "fb.json"
        args = ["--db", str(self.src_db), "--uploads", str(main.UPLOADS_DIR)]
        self.assertEqual(backup.main(["fingerprint", *args, "--out", str(a)]), 0)
        self.assertEqual(backup.main(["fingerprint", *args, "--out", str(b)]), 0)
        self.assertEqual(backup.main(["compare-fingerprint", str(a), str(b), "--same-db"]), 0)
        with db.get_conn() as conn:
            db.add_water(conn, self.a, 250, "2026-10-21T10:00:00")
        self.assertEqual(backup.main(["fingerprint", *args, "--out", str(b)]), 0)
        self.assertEqual(backup.main(["compare-fingerprint", str(a), str(b), "--same-db"]), 1)
        self.assertEqual(backup.main(["compare-fingerprint", str(a), str(b)]), 0)      # photos alone are still equal
        self.assertEqual(backup.main(["compare-fingerprint", str(a), str(self.tmp / "none.json")]), 1)
        self.assertEqual(backup.main(["fingerprint", "--db", str(self.tmp / "none.db"), "--uploads", str(main.UPLOADS_DIR)]), 1)

    def test_manifest_lists_every_file_with_a_hash(self):
        archive = self.make_archive()
        with zipfile.ZipFile(archive) as z:
            manifest = json.loads(z.read("MANIFEST.json"))
            for name, meta in manifest["files"].items():
                self.assertEqual(hashlib.sha256(z.read(name)).hexdigest(), meta["sha256"])
        self.assertEqual(len(manifest["files"]), 1 + 4)
