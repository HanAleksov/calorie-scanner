"""Verified backup and restore for Calorie Scanner (SQLite database + uploaded meal photos).

    python backend/tools/backup.py create  --db <calorie_scanner.db> --uploads <uploads dir> --out <dir>
    python backend/tools/backup.py verify  <archive.zip>
    python backend/tools/backup.py restore <archive.zip> --db <new .db path> --uploads <new uploads dir>

Design rules (each exists because the alternative loses data or hides a bad backup):
  * The database is copied with SQLite's online backup API, which is consistent while the app is writing.
    Copying the .db file with cp/scp can capture a half-written page.
  * Photos live OUTSIDE the .db file; the archive carries both, plus a MANIFEST.json with the SHA-256 of
    every file, per-table row counts, and the integrity-check result taken at backup time.
  * `verify` re-derives all of that from the archive alone: hashes, `PRAGMA integrity_check`,
    `PRAGMA foreign_key_check`, row counts, and that every photo an entry points to is present.
  * `restore` only ever writes to the paths you pass explicitly (it ignores CALORIE_DB_PATH /
    CALORIE_UPLOADS_DIR on purpose), refuses to overwrite an existing database or a non-empty uploads
    directory, and re-verifies the result after copying. It never deletes anything.
  * Nothing here reads or prints secrets; the archive contains personal data — store it accordingly.

Exit status is non-zero whenever a check fails.
"""

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

FORMAT_VERSION = 1
DB_MEMBER = "db/calorie_scanner.db"
UPLOADS_PREFIX = "uploads/"
MANIFEST = "MANIFEST.json"


class BackupError(Exception):
    pass


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _table_counts(conn) -> dict:
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    return {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}


def _referenced_photos(conn) -> set:
    try:
        rows = conn.execute("SELECT image_path, image_path2 FROM entries").fetchall()
    except sqlite3.Error:
        return set()
    return {p for r in rows for p in r if p}


def _inspect_db(db_path: Path) -> dict:
    conn = sqlite3.connect(f"file:{db_path.resolve().as_posix()}?mode=ro", uri=True)
    try:
        return {
            "integrity_check": conn.execute("PRAGMA integrity_check").fetchone()[0],
            "foreign_key_violations": len(conn.execute("PRAGMA foreign_key_check").fetchall()),
            "table_counts": _table_counts(conn),
            "referenced_photos": sorted(_referenced_photos(conn)),
        }
    finally:
        conn.close()


def create(db_path, uploads_dir, out_dir, now: datetime | None = None) -> Path:
    db_path, uploads_dir, out_dir = Path(db_path), Path(uploads_dir), Path(out_dir)
    if not db_path.is_file():
        raise BackupError(f"database not found: {db_path}")
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    archive = out_dir / f"calorie-scanner-backup-{stamp}.zip"
    if archive.exists():
        raise BackupError(f"refusing to overwrite {archive}")

    with tempfile.TemporaryDirectory(prefix="cs-backup-") as tmp:
        copy = Path(tmp) / "calorie_scanner.db"
        src = sqlite3.connect(f"file:{db_path.resolve().as_posix()}?mode=ro", uri=True)
        dst = sqlite3.connect(copy)
        try:
            src.backup(dst)          # consistent snapshot even if the app is writing right now
        except sqlite3.Error as e:
            raise BackupError(f"could not read the source database: {e}")
        finally:
            dst.close()
            src.close()
        try:
            info = _inspect_db(copy)
        except sqlite3.Error as e:
            raise BackupError(f"source database can't be read: {e}")
        if info["integrity_check"] != "ok":
            raise BackupError(f"source database failed integrity_check: {info['integrity_check']}")

        photos = sorted(p for p in uploads_dir.iterdir() if p.is_file()) if uploads_dir.is_dir() else []
        referenced = set(info["referenced_photos"])
        present = {p.name for p in photos}
        manifest = {
            "format_version": FORMAT_VERSION,
            "created_at": (now or datetime.now()).isoformat(timespec="seconds"),
            "files": {DB_MEMBER: {"sha256": _sha256_file(copy), "bytes": copy.stat().st_size}},
            "table_counts": info["table_counts"],
            "integrity_check": info["integrity_check"],
            "foreign_key_violations": info["foreign_key_violations"],
            "photos_referenced": len(referenced),
            "photos_present": len(photos),
            "photos_referenced_but_missing": sorted(referenced - present),   # data already lost at backup time
            "photos_unreferenced": sorted(present - referenced),
        }
        for p in photos:
            manifest["files"][UPLOADS_PREFIX + p.name] = {"sha256": _sha256_file(p), "bytes": p.stat().st_size}

        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(copy, DB_MEMBER)
            for p in photos:
                z.write(p, UPLOADS_PREFIX + p.name)
            z.writestr(MANIFEST, json.dumps(manifest, indent=1))
    return archive


def verify(archive) -> dict:
    """Re-checks an archive from scratch. Returns {"ok": bool, "problems": [...], "manifest": {...}}."""
    archive = Path(archive)
    problems = []
    if not zipfile.is_zipfile(archive):
        return {"ok": False, "problems": [f"not a zip archive: {archive}"], "manifest": None}
    with zipfile.ZipFile(archive) as z:
        bad = z.testzip()
        if bad:
            problems.append(f"corrupt zip member: {bad}")
        if MANIFEST not in z.namelist():
            return {"ok": False, "problems": problems + ["MANIFEST.json missing"], "manifest": None}
        manifest = json.loads(z.read(MANIFEST))
        if manifest.get("format_version") != FORMAT_VERSION:
            problems.append(f"unknown format_version {manifest.get('format_version')}")
        names = set(z.namelist()) - {MANIFEST}
        for name, meta in manifest["files"].items():
            if name not in names:
                problems.append(f"missing from archive: {name}")
                continue
            h = hashlib.sha256(z.read(name)).hexdigest()
            if h != meta["sha256"]:
                problems.append(f"hash mismatch: {name}")
        for extra in sorted(names - set(manifest["files"])):
            problems.append(f"not listed in manifest: {extra}")

        if DB_MEMBER in names:
            with tempfile.TemporaryDirectory(prefix="cs-verify-") as tmp:
                dbp = Path(tmp) / "calorie_scanner.db"
                dbp.write_bytes(z.read(DB_MEMBER))
                try:
                    info = _inspect_db(dbp)
                except sqlite3.Error as e:
                    problems.append(f"database in the archive can't be read: {e}")
                    info = None
            if info is None:
                pass
            elif info["integrity_check"] != "ok":
                problems.append(f"integrity_check: {info['integrity_check']}")
            if info is not None:
                if info["foreign_key_violations"]:
                    problems.append(f"{info['foreign_key_violations']} foreign key violation(s)")
                if info["table_counts"] != manifest["table_counts"]:
                    problems.append("table row counts differ from the manifest")
                have = {n[len(UPLOADS_PREFIX):] for n in names if n.startswith(UPLOADS_PREFIX)}
                missing = sorted(set(info["referenced_photos"]) - have)
                expected_missing = set(manifest.get("photos_referenced_but_missing", []))
                for m in missing:
                    if m not in expected_missing:
                        problems.append(f"entry points to a photo that is not in the archive: {m}")
    return {"ok": not problems, "problems": problems, "manifest": manifest}


def restore(archive, db_path, uploads_dir) -> dict:
    db_path, uploads_dir = Path(db_path), Path(uploads_dir)
    report = verify(archive)
    if not report["ok"]:
        raise BackupError("archive failed verification, nothing was restored: " + "; ".join(report["problems"]))
    if db_path.exists():
        raise BackupError(f"refusing to overwrite an existing database: {db_path}")
    if uploads_dir.exists() and any(uploads_dir.iterdir()):
        raise BackupError(f"refusing to restore into a non-empty uploads directory: {uploads_dir}")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    uploads_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        with z.open(DB_MEMBER) as src, open(db_path, "wb") as dst:
            shutil.copyfileobj(src, dst)
        for name in z.namelist():
            if name.startswith(UPLOADS_PREFIX) and not name.endswith("/"):
                target = uploads_dir / Path(name).name          # flat directory; never trust member paths
                with z.open(name) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
    # prove the copy on disk, not just the archive
    manifest = report["manifest"]
    problems = []
    if _sha256_file(db_path) != manifest["files"][DB_MEMBER]["sha256"]:
        problems.append("restored database hash differs")
    for name, meta in manifest["files"].items():
        if name.startswith(UPLOADS_PREFIX) and _sha256_file(uploads_dir / Path(name).name) != meta["sha256"]:
            problems.append(f"restored photo hash differs: {name}")
    info = _inspect_db(db_path)
    if info["integrity_check"] != "ok" or info["table_counts"] != manifest["table_counts"]:
        problems.append("restored database failed its checks")
    if problems:
        raise BackupError("; ".join(problems))
    return {"restored_db": str(db_path), "photos": manifest["photos_present"], "table_counts": info["table_counts"]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create")
    c.add_argument("--db", required=True), c.add_argument("--uploads", required=True), c.add_argument("--out", required=True)
    v = sub.add_parser("verify")
    v.add_argument("archive")
    r = sub.add_parser("restore")
    r.add_argument("archive"), r.add_argument("--db", required=True), r.add_argument("--uploads", required=True)
    args = ap.parse_args(argv)
    try:
        if args.cmd == "create":
            archive = create(args.db, args.uploads, args.out)
            report = verify(archive)           # a backup is only a backup once it has been read back
            print(f"created {archive}")
            m = report["manifest"]
            print(f"  tables: {m['table_counts']}")
            print(f"  photos: {m['photos_present']} present, {m['photos_referenced']} referenced, "
                  f"{len(m['photos_referenced_but_missing'])} referenced-but-missing")
            for p in report["problems"]:
                print("PROBLEM:", p)
            print("VERIFIED" if report["ok"] else "VERIFICATION FAILED")
            return 0 if report["ok"] else 1
        if args.cmd == "verify":
            report = verify(args.archive)
            for p in report["problems"]:
                print("PROBLEM:", p)
            print("VERIFIED" if report["ok"] else "VERIFICATION FAILED")
            return 0 if report["ok"] else 1
        print(json.dumps(restore(args.archive, args.db, args.uploads), indent=1))
        print("RESTORED AND VERIFIED")
        return 0
    except BackupError as e:
        print("ERROR:", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
