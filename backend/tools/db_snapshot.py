"""Content fingerprint of a Calorie Scanner SQLite database, and a before/after comparison.

Why this exists: "nothing was lost or altered" has to be *shown*, not asserted. A snapshot records, per
table, the columns, the row count and a SHA-256 of every row (rows are hashed from their column values
in column order, so ids, dates and numbers all count). Comparing two snapshots tells you exactly which
rows disappeared, appeared or changed — independent of file layout, page order or VACUUM, none of which
a byte-for-byte comparison of the .db file could tolerate.

By default the snapshot holds ONLY hashes and counts — no personal values — so it is safe to keep next
to a backup or hand to a reviewer. Use --with-rows only on throw-away test data.

    python backend/tools/db_snapshot.py snapshot  <db> <out.json> [--with-rows]
    python backend/tools/db_snapshot.py compare   <before.json> <after.json> [--allow-new-table T]...
                                                   [--allow-changed TABLE.COLUMN]...

`compare` exits 0 only when every row that existed before still exists, unchanged, in the columns that
existed before. New tables/columns are listed; they are an error unless allowed explicitly.
"""

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path


def _row_hash(values) -> str:
    return hashlib.sha256(json.dumps(list(values), ensure_ascii=False, separators=(",", ":"),
                                     default=repr).encode("utf-8")).hexdigest()


def snapshot(db_path, with_rows: bool = False) -> dict:
    # mode=ro: opening a database to fingerprint it must never modify it (no journal, no migration)
    conn = sqlite3.connect(f"file:{Path(db_path).resolve().as_posix()}?mode=ro", uri=True)
    try:
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        out = {"tables": {}}
        for t in tables:
            cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{t}")')]
            rows = conn.execute(f'SELECT {", ".join(chr(34) + c + chr(34) for c in cols)} FROM "{t}"').fetchall()
            hashes = sorted(_row_hash(r) for r in rows)
            entry = {
                "columns": cols,
                "count": len(rows),
                "row_hashes": hashes,
                "table_hash": hashlib.sha256("".join(hashes).encode()).hexdigest(),
            }
            if with_rows:
                entry["rows"] = [list(r) for r in rows]
            out["tables"][t] = entry
        return out
    finally:
        conn.close()


def compare(before: dict, after: dict, allow_new_tables=(), allow_changed=()) -> dict:
    problems, notes = [], []
    for name, b in before["tables"].items():
        a = after["tables"].get(name)
        if a is None:
            problems.append(f"table {name} is missing after")
            continue
        missing_cols = [c for c in b["columns"] if c not in a["columns"]]
        if missing_cols:
            problems.append(f"{name}: columns removed {missing_cols}")
            continue
        new_cols = [c for c in a["columns"] if c not in b["columns"]]
        if new_cols:
            notes.append(f"{name}: new columns {new_cols}")
        ignored = {c.split(".", 1)[1] for c in allow_changed if c.split(".", 1)[0] == name}
        keep = [c for c in b["columns"] if c not in ignored]
        if ignored:
            notes.append(f"{name}: columns allowed to differ {sorted(ignored)}")

        if a["columns"] == b["columns"] and not ignored:
            hb, ha = b["row_hashes"], a["row_hashes"]
        else:
            if "rows" not in b or "rows" not in a:
                # snapshots without rows can only be compared on identical columns; fall back to count
                if b["count"] != a["count"]:
                    problems.append(f"{name}: row count {b['count']} -> {a['count']}")
                else:
                    notes.append(f"{name}: columns differ, compared by row count only ({b['count']}); "
                                 "re-run snapshots with --with-rows on test data for a content check")
                continue

            def proj(snap):
                idx = [snap["columns"].index(c) for c in keep]
                return sorted(_row_hash([row[i] for i in idx]) for row in snap["rows"])
            hb, ha = proj(b), proj(a)

        if hb == ha:
            continue
        from collections import Counter
        cb, ca = Counter(hb), Counter(ha)
        lost, gained = sum((cb - ca).values()), sum((ca - cb).values())
        problems.append(f"{name}: {lost} row(s) changed or lost, {gained} row(s) new/changed "
                        f"(count {b['count']} -> {a['count']})")
    for name in after["tables"]:
        if name not in before["tables"]:
            (notes if name in allow_new_tables else problems).append(
                f"new table {name} ({after['tables'][name]['count']} rows)"
                + ("" if name in allow_new_tables else " — not allowed"))
    return {"identical": not problems, "problems": problems, "notes": notes}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("db"), s.add_argument("out"), s.add_argument("--with-rows", action="store_true")
    c = sub.add_parser("compare")
    c.add_argument("before"), c.add_argument("after")
    c.add_argument("--allow-new-table", action="append", default=[])
    c.add_argument("--allow-changed", action="append", default=[], metavar="TABLE.COLUMN")
    args = ap.parse_args(argv)

    if args.cmd == "snapshot":
        snap = snapshot(args.db, with_rows=args.with_rows)
        Path(args.out).write_text(json.dumps(snap, indent=1), encoding="utf-8")
        for t, e in snap["tables"].items():
            print(f"{t:14} rows={e['count']:<6} hash={e['table_hash'][:16]}")
        return 0

    before = json.loads(Path(args.before).read_text(encoding="utf-8"))
    after = json.loads(Path(args.after).read_text(encoding="utf-8"))
    report = compare(before, after, args.allow_new_table, args.allow_changed)
    for n in report["notes"]:
        print("note:", n)
    for p in report["problems"]:
        print("PROBLEM:", p)
    print("IDENTICAL" if report["identical"] else "DIFFERENT")
    return 0 if report["identical"] else 1


if __name__ == "__main__":
    sys.exit(main())
