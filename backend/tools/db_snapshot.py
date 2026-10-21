"""Content fingerprint of a Calorie Scanner SQLite database, and a before/after comparison.

Why this exists: "nothing was lost or altered" has to be *shown*, not asserted. A snapshot records, per
table, the columns, the primary key, the row count and — for every row — a SHA-256 of the primary key and
a SHA-256 of each individual cell (column name + value). Comparing two snapshots therefore says exactly
which rows disappeared or appeared and, for rows that exist in both, which columns changed — independent
of file layout, page order or VACUUM, none of which a byte-for-byte comparison of the .db file could
tolerate. It also works when columns were added in between (the old columns are compared cell by cell).

The snapshot holds ONLY hashes and counts, never values. That is not anonymity: the hash of a short
number can be guessed by trying numbers. Keep a snapshot next to the private backup; do not put one that
came from real data into a review package.

    python backend/tools/db_snapshot.py snapshot  <db> <out.json>
    python backend/tools/db_snapshot.py compare   <before.json> <after.json>
        [--allow-new-table T]... [--allow-new-column TABLE.COLUMN]... [--allow-changed TABLE.COLUMN]...

`compare` exits 0 only when
  * every table and column that existed before still exists,
  * every row that existed before still exists, and nothing else appeared,
  * every cell of every old column is unchanged, except columns named with --allow-changed,
  * every new table / new column was named explicitly (--allow-new-table / --allow-new-column).
Anything it cannot verify (a snapshot from an older version of this tool, a table with no primary key
whose columns changed, duplicate keys) is a failure, never a pass.
"""

import argparse
import hashlib
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path

FORMAT = 2
_HASH_LEN = 32          # hex chars kept per cell hash (128 bits — ample against accidental collisions)


def _h(obj) -> str:
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=repr).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def snapshot(db_path) -> dict:
    # mode=ro: opening a database to fingerprint it must never modify it (no journal, no migration)
    conn = sqlite3.connect(f"file:{Path(db_path).resolve().as_posix()}?mode=ro", uri=True)
    try:
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        out = {"format": FORMAT, "tables": {}}
        for t in tables:
            info = conn.execute(f'PRAGMA table_info("{t}")').fetchall()
            cols = [r[1] for r in info]
            pk = [r[1] for r in sorted((r for r in info if r[5] > 0), key=lambda r: r[5])]
            pk_idx = [cols.index(c) for c in pk]
            rows = conn.execute(f'SELECT {", ".join(chr(34) + c + chr(34) for c in cols)} FROM "{t}"').fetchall()
            cells, duplicate_keys = {}, False
            for row in rows:
                key = _h([row[i] for i in pk_idx])[:_HASH_LEN] if pk else _h(list(row))[:_HASH_LEN]
                if key in cells:
                    duplicate_keys = True
                cells[key] = {c: _h([c, v])[:_HASH_LEN] for c, v in zip(cols, row)}
            whole_rows = sorted(_h(list(r)) for r in rows)
            out["tables"][t] = {
                "columns": cols,
                "pk": pk,
                "count": len(rows),
                "duplicate_keys": duplicate_keys,
                "table_hash": hashlib.sha256("".join(whole_rows).encode()).hexdigest(),
                "cells": cells,
            }
        return out
    finally:
        conn.close()


def _split(spec: str):
    table, _, column = spec.partition(".")
    return (table, column) if table and column else None


def compare(before: dict, after: dict, allow_new_tables=(), allow_new_columns=(), allow_changed=()) -> dict:
    problems, notes = [], []
    for label, snap in (("before", before), ("after", after)):
        if snap.get("format") != FORMAT or any("cells" not in e for e in snap.get("tables", {}).values()):
            problems.append(f"the {label} snapshot has no per-cell hashes (made by an older version of this tool); "
                            "take it again — a comparison that cannot look at every column proves nothing")
    if problems:
        return {"identical": False, "problems": problems, "notes": notes}

    allowed_new, allowed_chg = set(), set()
    for kind, specs, bucket in (("--allow-new-column", allow_new_columns, allowed_new),
                                ("--allow-changed", allow_changed, allowed_chg)):
        for spec in specs:
            parsed = _split(spec)
            if parsed is None:
                problems.append(f"{kind} {spec!r} is not TABLE.COLUMN")
            else:
                bucket.add(parsed)

    for name, b in before["tables"].items():
        a = after["tables"].get(name)
        if a is None:
            problems.append(f"table {name} is missing after")
            continue
        missing_cols = [c for c in b["columns"] if c not in a["columns"]]
        if missing_cols:
            problems.append(f"{name}: columns removed {missing_cols}")
            continue
        for c in [c for c in a["columns"] if c not in b["columns"]]:
            if (name, c) in allowed_new:
                notes.append(f"{name}.{c}: new column (allowed)")
            else:
                problems.append(f"{name}.{c}: new column — not allowed (name it with --allow-new-column {name}.{c})")
        if b["pk"] != a["pk"]:
            problems.append(f"{name}: primary key changed {b['pk']} -> {a['pk']}")
            continue
        if b.get("duplicate_keys") or a.get("duplicate_keys"):
            problems.append(f"{name}: duplicate row keys, rows cannot be matched one to one")
            continue

        ignored = {c for (t, c) in allowed_chg if t == name}
        unknown = sorted(c for c in ignored if c not in b["columns"])
        if unknown:
            problems.append(f"{name}: --allow-changed names columns that did not exist before {unknown}")
        pk_ignored = sorted(ignored & set(b["pk"]))
        if pk_ignored:
            problems.append(f"{name}: primary-key columns can never be allowed to change {pk_ignored}")
        ignored -= set(unknown) | set(pk_ignored)
        keep = [c for c in b["columns"] if c not in ignored]

        if not b["pk"] and (ignored or a["columns"] != b["columns"]):
            problems.append(f"{name}: no primary key, so rows cannot be matched once columns change")
            continue

        bc, ac = b["cells"], a["cells"]
        lost = [k for k in bc if k not in ac]
        gained = [k for k in ac if k not in bc]
        if lost or gained:
            problems.append(f"{name}: {len(lost)} row(s) lost, {len(gained)} row(s) new "
                            f"(count {b['count']} -> {a['count']})")
        if b["count"] != a["count"] and not (lost or gained):
            problems.append(f"{name}: row count {b['count']} -> {a['count']}")
        changed = Counter()
        changed_allowed = Counter()
        for k, cells_b in bc.items():
            cells_a = ac.get(k)
            if cells_a is None:
                continue
            for c in b["columns"]:
                if cells_b[c] != cells_a[c]:
                    (changed_allowed if c in ignored else changed)[c] += 1
        for c, n in sorted(changed.items()):
            problems.append(f"{name}.{c}: changed in {n} row(s)")
        for c, n in sorted(changed_allowed.items()):
            notes.append(f"{name}.{c}: changed in {n} row(s) (allowed)")
        if not keep:
            problems.append(f"{name}: nothing left to compare after the allowed changes")

    for name in after["tables"]:
        if name not in before["tables"]:
            ok = name in allow_new_tables
            (notes if ok else problems).append(f"new table {name} ({after['tables'][name]['count']} rows)"
                                               + ("" if ok else " — not allowed (use --allow-new-table)"))
    return {"identical": not problems, "problems": problems, "notes": notes}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("db"), s.add_argument("out")
    c = sub.add_parser("compare")
    c.add_argument("before"), c.add_argument("after")
    c.add_argument("--allow-new-table", action="append", default=[])
    c.add_argument("--allow-new-column", action="append", default=[], metavar="TABLE.COLUMN")
    c.add_argument("--allow-changed", action="append", default=[], metavar="TABLE.COLUMN")
    args = ap.parse_args(argv)

    try:
        if args.cmd == "snapshot":
            snap = snapshot(args.db)
            Path(args.out).write_text(json.dumps(snap, indent=1), encoding="utf-8")
            for t, e in snap["tables"].items():
                print(f"{t:14} rows={e['count']:<6} hash={e['table_hash'][:16]}")
            return 0
        before = json.loads(Path(args.before).read_text(encoding="utf-8"))
        after = json.loads(Path(args.after).read_text(encoding="utf-8"))
    except (OSError, ValueError, sqlite3.Error) as e:
        print("ERROR:", e)
        return 1
    report = compare(before, after, args.allow_new_table, args.allow_new_column, args.allow_changed)
    for n in report["notes"]:
        print("note:", n)
    for p in report["problems"]:
        print("PROBLEM:", p)
    print("IDENTICAL" if report["identical"] else "DIFFERENT")
    return 0 if report["identical"] else 1


if __name__ == "__main__":
    sys.exit(main())
