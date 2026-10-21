"""The before/after comparison must fail whenever it cannot prove nothing changed.

Built on tiny hand-made databases (no app involved) so every case is a precise statement about
db_snapshot.compare(): a changed value must never hide behind a schema change or an allowed column.
"""

import json
import sqlite3
import unittest
from pathlib import Path
import tempfile

from tools import db_snapshot

OLD_SCHEMA = """
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, pin_hash TEXT);
CREATE TABLE weigh (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, kg REAL);
CREATE TABLE marks (user_id INTEGER, day TEXT, status TEXT, PRIMARY KEY (user_id, day));
"""


def build(path: Path, extra_users_column=False):
    conn = sqlite3.connect(path)
    conn.executescript(OLD_SCHEMA)
    if extra_users_column:
        conn.execute("ALTER TABLE users ADD COLUMN failed INTEGER NOT NULL DEFAULT 0")
    conn.executemany("INSERT INTO users (id, name, pin_hash) VALUES (?,?,?)",
                     [(1, "Zlatka-Test", "legacy-a"), (2, "Boris-Test", None)])
    conn.executemany("INSERT INTO weigh (user_id, kg) VALUES (?,?)", [(1, 71.5), (1, 72.0), (2, 90.25)])
    conn.executemany("INSERT INTO marks VALUES (?,?,?)", [(1, "2026-10-01", "complete"), (1, "2026-10-02", "skip")])
    conn.commit()
    conn.close()


class SnapshotCompareTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.old_path = self.tmp / "old.db"
        build(self.old_path)
        self.before = db_snapshot.snapshot(self.old_path)

    def mutated(self, *sql, add_column=False):
        path = self.tmp / f"after{len(list(self.tmp.glob('after*.db')))}.db"
        build(path, extra_users_column=add_column)
        conn = sqlite3.connect(path)
        for statement in sql:
            conn.execute(statement)
        conn.commit()
        conn.close()
        return db_snapshot.snapshot(path)

    # ---------- the two cases a reviewer reproduced ----------
    def test_added_column_plus_changed_existing_name_is_not_identical(self):
        after = self.mutated("UPDATE users SET name = 'Someone-Else' WHERE id = 1", add_column=True)
        # not allowed at all -> fails on the schema alone
        self.assertFalse(db_snapshot.compare(self.before, after)["identical"])
        # even with the new column explicitly allowed, the changed name is found
        report = db_snapshot.compare(self.before, after, allow_new_columns=["users.failed"])
        self.assertFalse(report["identical"], report)
        self.assertIn("users.name: changed in 1 row(s)", report["problems"])

    def test_allowing_only_pin_hash_does_not_excuse_a_changed_name(self):
        after = self.mutated("UPDATE users SET pin_hash = 'pbkdf2$new' WHERE id = 1",
                             "UPDATE users SET name = 'Someone-Else' WHERE id = 1")
        report = db_snapshot.compare(self.before, after, allow_changed=["users.pin_hash"])
        self.assertFalse(report["identical"], report)
        self.assertTrue(any(p.startswith("users.name:") for p in report["problems"]), report)

    # ---------- the allowed things really are allowed (and only those) ----------
    def test_only_the_named_column_may_change(self):
        after = self.mutated("UPDATE users SET pin_hash = 'pbkdf2$new' WHERE id = 1")
        self.assertFalse(db_snapshot.compare(self.before, after)["identical"])
        report = db_snapshot.compare(self.before, after, allow_changed=["users.pin_hash"])
        self.assertTrue(report["identical"], report)
        self.assertIn("users.pin_hash: changed in 1 row(s) (allowed)", report["notes"])

    def test_an_added_column_must_be_named(self):
        after = self.mutated(add_column=True)
        self.assertFalse(db_snapshot.compare(self.before, after)["identical"])
        self.assertTrue(db_snapshot.compare(self.before, after, allow_new_columns=["users.failed"])["identical"])
        self.assertFalse(db_snapshot.compare(self.before, after, allow_new_columns=["users.other"])["identical"])

    def test_a_new_table_must_be_named(self):
        after = self.mutated("CREATE TABLE extra (id INTEGER PRIMARY KEY)")
        self.assertFalse(db_snapshot.compare(self.before, after)["identical"])
        self.assertTrue(db_snapshot.compare(self.before, after, allow_new_tables={"extra"})["identical"])

    def test_identical_databases_are_identical(self):
        self.assertTrue(db_snapshot.compare(self.before, self.mutated())["identical"])

    # ---------- every kind of damage is found ----------
    def test_changed_lost_and_added_rows_and_values_are_found(self):
        cases = {
            "numeric value": ["UPDATE weigh SET kg = 72.1 WHERE id = 2"],
            "null to value": ["UPDATE users SET pin_hash = 'x' WHERE id = 2"],
            "lost row": ["DELETE FROM weigh WHERE id = 3"],
            "added row": ["INSERT INTO weigh (user_id, kg) VALUES (2, 1)"],
            "composite key row lost": ["DELETE FROM marks WHERE day = '2026-10-02'"],
            "composite key value": ["UPDATE marks SET status = 'complete' WHERE day = '2026-10-02'"],
            "number stored as text": ["UPDATE users SET name = 71.5 WHERE id = 2", "UPDATE users SET pin_hash = '71.5' WHERE id = 1"],
        }
        for label, sql in cases.items():
            with self.subTest(label):
                self.assertFalse(db_snapshot.compare(self.before, self.mutated(*sql))["identical"], label)

    def test_a_moved_value_between_rows_is_found(self):
        after = self.mutated("UPDATE weigh SET kg = 90.25 WHERE id = 1", "UPDATE weigh SET kg = 71.5 WHERE id = 3")
        self.assertFalse(db_snapshot.compare(self.before, after)["identical"])

    def test_a_missing_table_or_removed_column_is_found(self):
        after = self.mutated("DROP TABLE marks")
        self.assertFalse(db_snapshot.compare(self.before, after)["identical"])
        self.assertFalse(db_snapshot.compare(self.mutated(add_column=True), self.before,
                                             allow_new_columns=["users.failed"])["identical"])

    # ---------- if it can't be proven, it fails ----------
    def test_a_snapshot_without_cell_hashes_fails(self):
        old_style = {"tables": {t: {k: v for k, v in e.items() if k != "cells"} for t, e in self.before["tables"].items()}}
        self.assertFalse(db_snapshot.compare(old_style, self.before)["identical"])
        self.assertFalse(db_snapshot.compare(self.before, old_style)["identical"])

    def test_nonsense_allowances_fail_instead_of_being_ignored(self):
        after = self.mutated()
        self.assertFalse(db_snapshot.compare(self.before, after, allow_changed=["users.no_such_column"])["identical"])
        self.assertFalse(db_snapshot.compare(self.before, after, allow_changed=["users.id"])["identical"])
        self.assertFalse(db_snapshot.compare(self.before, after, allow_changed=["garbage"])["identical"])

    # ---------- the snapshot itself ----------
    def test_the_snapshot_file_holds_no_values(self):
        text = json.dumps(self.before)
        for secret in ("Zlatka-Test", "Boris-Test", "legacy-a", "71.5", "90.25"):
            self.assertNotIn(secret, text)

    def test_command_line_exit_codes(self):
        new_path = self.tmp / "cli-new.db"
        build(new_path)
        conn = sqlite3.connect(new_path)
        conn.execute("UPDATE users SET name='X' WHERE id=1")
        conn.commit()
        conn.close()
        a, b, c = self.tmp / "a.json", self.tmp / "b.json", self.tmp / "c.json"
        self.assertEqual(db_snapshot.main(["snapshot", str(self.old_path), str(a)]), 0)
        self.assertEqual(db_snapshot.main(["snapshot", str(self.old_path), str(b)]), 0)
        self.assertEqual(db_snapshot.main(["snapshot", str(new_path), str(c)]), 0)
        self.assertEqual(db_snapshot.main(["compare", str(a), str(b)]), 0)
        self.assertEqual(db_snapshot.main(["compare", str(a), str(c)]), 1)
        self.assertEqual(db_snapshot.main(["compare", str(a), str(self.tmp / "missing.json")]), 1)


if __name__ == "__main__":
    unittest.main()
