"""Verified backup and restore for Calorie Scanner (SQLite database + uploaded meal photos).

    python backend/tools/backup.py create  --db <calorie_scanner.db> --uploads <uploads dir> --out <dir>
    python backend/tools/backup.py verify  <archive.zip>
    python backend/tools/backup.py restore <archive.zip> --db <new .db path> --uploads <new uploads dir>
    python backend/tools/backup.py fingerprint --db <.db> --uploads <dir> [--out file.json]
    python backend/tools/backup.py compare-fingerprint <a.json> <b.json> [--same-db]

Design rules (each exists because the alternative loses data or hides a bad backup):
  * The database is copied with SQLite's online backup API, which is consistent while the app is writing.
    Copying the .db file with cp/scp can capture a half-written page.
  * Photos live OUTSIDE the .db file; the archive carries both, plus a MANIFEST.json with the SHA-256 of
    every file, per-table row counts, and the integrity-check result taken at backup time.
  * `verify` re-derives all of that from the archive alone: the manifest's structure, the database member
    (mandatory), hashes and sizes, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, row counts, and
    that every photo an entry points to is present. A photo that an entry points to but the archive does
    not hold makes the archive INCOMPLETE: it is reported separately, it is never "ok", and `restore`
    refuses it unless you pass --allow-incomplete (disaster recovery only). An incomplete archive does not
    satisfy the "full verified backup before deploy" condition.
  * `restore` only ever writes to the paths you pass explicitly (it ignores CALORIE_DB_PATH /
    CALORIE_UPLOADS_DIR on purpose), refuses to overwrite an existing database or a non-empty uploads
    directory, and re-verifies the result after copying. It never deletes anything.
  * `fingerprint` (read-only) records the SHA-256 of the database file and of every photo. Taken before and
    after `create`, two equal fingerprints prove nothing was written in between, i.e. the database copy and
    the photo copy describe the same moment. `compare-fingerprint` also checks a restored uploads folder
    against the source photo for photo.
  * Nothing here reads or prints secrets; the archive contains personal data — store it accordingly.

Exit status: 0 = verified and complete, 1 = a check failed, 2 = internally consistent but INCOMPLETE.
"""

import argparse
import hashlib
import json
import os
import re
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
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


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


def _safe_photo_name(name) -> bool:
    return (isinstance(name, str) and name not in ("", ".", "..")
            and name == Path(name).name and "/" not in name and "\\" not in name and ":" not in name)


def _member_ok(name) -> bool:
    return name == DB_MEMBER or (isinstance(name, str) and name.startswith(UPLOADS_PREFIX)
                                 and _safe_photo_name(name[len(UPLOADS_PREFIX):]))


def _manifest_problems(m) -> list:
    """Structure of MANIFEST.json. Anything later code indexes into is checked here first."""
    if not isinstance(m, dict):
        return ["MANIFEST.json is not an object"]
    out = []
    if m.get("format_version") != FORMAT_VERSION:
        out.append(f"unknown format_version {m.get('format_version')!r}")
    files = m.get("files")
    if not isinstance(files, dict) or not files:
        out.append("manifest lists no files")
        files = {}
    for name, meta in files.items():
        if not _member_ok(name):
            out.append(f"manifest names an unexpected path: {name!r}")
        elif not (isinstance(meta, dict) and isinstance(meta.get("sha256"), str) and _SHA256.match(meta["sha256"])
                  and isinstance(meta.get("bytes"), int) and meta["bytes"] >= 0):
            out.append(f"manifest entry is malformed: {name}")
    if DB_MEMBER not in files:
        out.append(f"manifest does not list the database ({DB_MEMBER})")
    counts = m.get("table_counts")
    if not (isinstance(counts, dict) and counts and all(isinstance(k, str) and isinstance(v, int) for k, v in counts.items())):
        out.append("manifest table_counts is missing or malformed")
    if m.get("integrity_check") != "ok":
        out.append(f"manifest integrity_check is {m.get('integrity_check')!r}")
    for key in ("foreign_key_violations", "photos_referenced", "photos_present"):
        if not isinstance(m.get(key), int):
            out.append(f"manifest {key} is missing or not a number")
    for key in ("photos_referenced_but_missing", "photos_unreferenced"):
        if not (isinstance(m.get(key), list) and all(isinstance(x, str) for x in m[key])):
            out.append(f"manifest {key} is missing or not a list")
    return out


def create(db_path, uploads_dir, out_dir, now: datetime | None = None) -> Path:
    db_path, uploads_dir, out_dir = Path(db_path), Path(uploads_dir), Path(out_dir)
    if not db_path.is_file():
        raise BackupError(f"database not found: {db_path}")
    if not uploads_dir.is_dir():
        # A wrong path would otherwise produce a "backup" without a single photo that still looks fine.
        raise BackupError(f"uploads directory not found: {uploads_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    archive = out_dir / f"calorie-scanner-backup-{stamp}.zip"
    partial = archive.with_name(archive.name + ".partial")
    if archive.exists() or partial.exists():
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

        entries = sorted(uploads_dir.iterdir())
        photos = [p for p in entries if p.is_file()]
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
            "uploads_not_archived": sorted(p.name for p in entries if not p.is_file()),   # sub-folders etc.
        }
        for p in photos:
            manifest["files"][UPLOADS_PREFIX + p.name] = {"sha256": _sha256_file(p), "bytes": p.stat().st_size}

        try:
            with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as z:
                z.write(copy, DB_MEMBER)
                for p in photos:
                    z.write(p, UPLOADS_PREFIX + p.name)
                z.writestr(MANIFEST, json.dumps(manifest, indent=1))
            os.replace(partial, archive)     # an archive only appears under its real name once it is whole
        finally:
            if partial.exists():
                partial.unlink()
    return archive


def verify(archive) -> dict:
    """Re-checks an archive from scratch.

    Returns {"ok": bool, "problems": [...], "incomplete": [...], "manifest": {...} | None}.
    `problems` = the archive is damaged or malformed. `incomplete` = it is consistent but an entry points
    to a photo it does not hold. `ok` needs both lists empty.
    """
    archive = Path(archive)
    problems, incomplete = [], []

    def result(manifest=None):
        return {"ok": not problems and not incomplete, "problems": problems, "incomplete": incomplete,
                "manifest": manifest}

    if not archive.is_file() or not zipfile.is_zipfile(archive):
        problems.append(f"not a zip archive: {archive}")
        return result()
    try:
        zf = zipfile.ZipFile(archive)
    except (zipfile.BadZipFile, OSError) as e:
        problems.append(f"can't open the archive: {e}")
        return result()
    with zf as z:
        listing = z.namelist()
        if len(listing) != len(set(listing)):
            problems.append("the archive contains the same member name more than once")
        bad = z.testzip()
        if bad:
            problems.append(f"corrupt zip member: {bad}")
        if MANIFEST not in listing:
            problems.append("MANIFEST.json missing")
            return result()
        try:
            manifest = json.loads(z.read(MANIFEST))
        except ValueError as e:
            problems.append(f"MANIFEST.json is not valid JSON: {e}")
            return result()
        structural = _manifest_problems(manifest)
        names = set(listing) - {MANIFEST}
        for n in sorted(names):
            if not _member_ok(n):
                problems.append(f"unexpected member in the archive: {n!r}")
        if DB_MEMBER not in names:
            problems.append(f"the database ({DB_MEMBER}) is not in the archive")
        if structural:
            problems.extend(structural)
            return result(manifest)

        sizes = {i.filename: i.file_size for i in z.infolist()}
        for name, meta in manifest["files"].items():
            if name not in names:
                if name != DB_MEMBER:           # a missing database was reported above
                    problems.append(f"missing from archive: {name}")
                continue
            h = hashlib.sha256()
            with z.open(name) as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            if h.hexdigest() != meta["sha256"]:
                problems.append(f"hash mismatch: {name}")
            elif sizes[name] != meta["bytes"]:
                problems.append(f"size differs from the manifest: {name}")
        for extra in sorted(n for n in names - set(manifest["files"]) if _member_ok(n)):
            problems.append(f"not listed in manifest: {extra}")
        uploads_listed = [n for n in manifest["files"] if n.startswith(UPLOADS_PREFIX)]
        if manifest["photos_present"] != len(uploads_listed):
            problems.append("manifest photos_present does not match the files it lists")

        info = None
        if DB_MEMBER in names:
            with tempfile.TemporaryDirectory(prefix="cs-verify-") as tmp:
                dbp = Path(tmp) / "calorie_scanner.db"
                with z.open(DB_MEMBER) as src, open(dbp, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                try:
                    info = _inspect_db(dbp)
                except sqlite3.Error as e:
                    problems.append(f"database in the archive can't be read: {e}")
        missing = set(manifest["photos_referenced_but_missing"])
        if info is not None:
            if info["integrity_check"] != "ok":
                problems.append(f"integrity_check: {info['integrity_check']}")
            if info["foreign_key_violations"]:
                problems.append(f"{info['foreign_key_violations']} foreign key violation(s)")
            if info["table_counts"] != manifest["table_counts"]:
                problems.append("table row counts differ from the manifest")
            have = {n[len(UPLOADS_PREFIX):] for n in names if n.startswith(UPLOADS_PREFIX)}
            missing |= set(info["referenced_photos"]) - have
        for m in sorted(missing):
            incomplete.append(f"an entry points to a photo that is not in the archive: {m}")
    return result(manifest)


def restore(archive, db_path, uploads_dir, allow_incomplete: bool = False) -> dict:
    db_path, uploads_dir = Path(db_path), Path(uploads_dir)
    report = verify(archive)
    if report["problems"]:
        raise BackupError("archive failed verification, nothing was restored: " + "; ".join(report["problems"]))
    if report["incomplete"] and not allow_incomplete:
        raise BackupError("archive is INCOMPLETE, nothing was restored (--allow-incomplete is for disaster "
                          "recovery only): " + "; ".join(report["incomplete"]))
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
            if name.startswith(UPLOADS_PREFIX):
                target = uploads_dir / Path(name).name          # flat directory; verify() proved the names are safe
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
    return {"restored_db": str(db_path), "photos": manifest["photos_present"], "table_counts": info["table_counts"],
            "incomplete": report["incomplete"]}


def fingerprint(db_path, uploads_dir) -> dict:
    """Hashes only, no values: the database FILE's SHA-256 and every photo's size and SHA-256."""
    db_path, uploads_dir = Path(db_path), Path(uploads_dir)
    if not db_path.is_file():
        raise BackupError(f"database not found: {db_path}")
    if not uploads_dir.is_dir():
        raise BackupError(f"uploads directory not found: {uploads_dir}")
    entries = sorted(uploads_dir.iterdir())
    return {
        "db_sha256": _sha256_file(db_path),
        "db_bytes": db_path.stat().st_size,
        "photos": {p.name: {"bytes": p.stat().st_size, "sha256": _sha256_file(p)} for p in entries if p.is_file()},
        "not_files": sorted(p.name for p in entries if not p.is_file()),
    }


def compare_fingerprints(a: dict, b: dict, same_db: bool = False) -> list:
    """Problems between two fingerprints ([] = the same photos; plus the same database file if same_db)."""
    out = []
    for name in sorted(set(a["photos"]) - set(b["photos"])):
        out.append(f"photo only in the first: {name}")
    for name in sorted(set(b["photos"]) - set(a["photos"])):
        out.append(f"photo only in the second: {name}")
    for name in sorted(set(a["photos"]) & set(b["photos"])):
        if a["photos"][name] != b["photos"][name]:
            out.append(f"photo differs: {name}")
    if a.get("not_files") != b.get("not_files"):
        out.append("sub-folders in the uploads directory differ")
    if same_db and a["db_sha256"] != b["db_sha256"]:
        out.append("the database file changed between the two fingerprints (something wrote to it)")
    return out


def _finish(report) -> int:
    for p in report["problems"]:
        print("PROBLEM:", p)
    for p in report["incomplete"]:
        print("INCOMPLETE:", p)
    if report["problems"]:
        print("VERIFICATION FAILED")
        return 1
    if report["incomplete"]:
        print("INCOMPLETE ARCHIVE — the archive is consistent, but it does NOT hold every photo the database "
              "points to. It does not count as a full backup.")
        return 2
    print("VERIFIED")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create")
    c.add_argument("--db", required=True), c.add_argument("--uploads", required=True), c.add_argument("--out", required=True)
    v = sub.add_parser("verify")
    v.add_argument("archive")
    r = sub.add_parser("restore")
    r.add_argument("archive"), r.add_argument("--db", required=True), r.add_argument("--uploads", required=True)
    r.add_argument("--allow-incomplete", action="store_true")
    f = sub.add_parser("fingerprint")
    f.add_argument("--db", required=True), f.add_argument("--uploads", required=True), f.add_argument("--out")
    cf = sub.add_parser("compare-fingerprint")
    cf.add_argument("a"), cf.add_argument("b"), cf.add_argument("--same-db", action="store_true")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "create":
            archive = create(args.db, args.uploads, args.out)
            report = verify(archive)           # a backup is only a backup once it has been read back
            print(f"created {archive}")
            m = report["manifest"]
            if m and not report["problems"]:
                print(f"  tables: {m['table_counts']}")
                print(f"  photos: {m['photos_present']} present, {m['photos_referenced']} referenced, "
                      f"{len(m['photos_referenced_but_missing'])} referenced-but-missing")
            return _finish(report)
        if args.cmd == "verify":
            return _finish(verify(args.archive))
        if args.cmd == "fingerprint":
            fp = fingerprint(args.db, args.uploads)
            text = json.dumps(fp, indent=1)
            if args.out:
                Path(args.out).write_text(text, encoding="utf-8")
            print(f"db sha256 {fp['db_sha256']}  ({fp['db_bytes']} bytes), {len(fp['photos'])} photo(s)")
            return 0
        if args.cmd == "compare-fingerprint":
            try:
                a = json.loads(Path(args.a).read_text(encoding="utf-8"))
                b = json.loads(Path(args.b).read_text(encoding="utf-8"))
                problems = compare_fingerprints(a, b, args.same_db)
            except (OSError, ValueError, KeyError, TypeError) as e:
                print("ERROR: can't compare:", e)
                return 1
            for line in problems:
                print("PROBLEM:", line)
            print("SAME" if not problems else "DIFFERENT")
            return 0 if not problems else 1
        print(json.dumps(restore(args.archive, args.db, args.uploads, args.allow_incomplete), indent=1))
        print("RESTORED AND VERIFIED")
        return 0
    except BackupError as e:
        print("ERROR:", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
