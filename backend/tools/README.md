# Backup, restore and "was anything lost?" checks

Two small, dependency-free tools (Python standard library only). Nothing here runs automatically and
nothing touches production unless you point it there. The concrete step-by-step procedure for the Coolify
server (read-only volume, separate helper container, quiet window, off-server copy) is in
[`SERVER_BACKUP.md`](SERVER_BACKUP.md).

## What counts as a backup

An archive counts as a **full backup** only when `backup.py verify` ends with `VERIFIED` (exit 0):

* the manifest is well-formed and lists the database; the database member is present and its SHA-256 and size match;
* every file in the archive is listed, and every listed file is present with a matching hash;
* `PRAGMA integrity_check` is `ok`, no foreign-key violations, row counts equal the manifest's;
* **every photo an entry points to is in the archive.** If one is not, the archive is reported as
  `INCOMPLETE` (exit 2): it is consistent, but it is not a full backup, it never prints `VERIFIED`, and
  `restore` refuses it unless `--allow-incomplete` is given (disaster recovery only).
* `create` refuses a missing database or a missing uploads directory (a wrong path must not yield a
  "backup" without photos) and only gives the archive its real name once it has been written completely.

## Before any deploy that changes the database or the sign-in system

1. **Back up the live data** (consistent set: see `SERVER_BACKUP.md` for the quiet-window procedure):

   ```bash
   python tools/backup.py fingerprint --db /data/calorie_scanner.db --uploads /data/uploads --out before.json
   python tools/backup.py create      --db /data/calorie_scanner.db --uploads /data/uploads --out /data/backups
   python tools/db_snapshot.py snapshot /data/calorie_scanner.db source_db.json
   python tools/backup.py fingerprint --db /data/calorie_scanner.db --uploads /data/uploads --out after.json
   python tools/backup.py compare-fingerprint before.json after.json --same-db     # must say SAME
   ```

   The database is copied with SQLite's online backup API; photos are added; `MANIFEST.json` carries
   SHA-256 of every file, per-table row counts and the integrity-check result; `create` then **reads the
   archive back and verifies it**. The two fingerprints (SHA-256 of the database file and of every photo)
   prove that nothing was written between them, i.e. that the database copy and the photo copy describe the
   same moment. If they differ, throw the archive away and repeat.
   Copy the `.zip` off the server (it contains personal data) and check its SHA-256 after the transfer.

2. **Prove the backup restores** — into new empty paths, never over the live ones:

   ```bash
   python tools/backup.py restore calorie-scanner-backup-<stamp>.zip --db restore/calorie_scanner.db --uploads restore/uploads
   python tools/db_snapshot.py snapshot restore/calorie_scanner.db restored_db.json
   python tools/db_snapshot.py compare source_db.json restored_db.json             # must say IDENTICAL, no allowances
   python tools/backup.py fingerprint --db restore/calorie_scanner.db --uploads restore/uploads --out restored.json
   python tools/backup.py compare-fingerprint before.json restored.json            # photos: SAME
   ```

   Compare against the **fixed** source (`source_db.json`, taken inside the quiet window), not against a
   live database that may have changed since. `restore` refuses to overwrite an existing database or a
   non-empty uploads directory and ignores `CALORIE_DB_PATH` / `CALORIE_UPLOADS_DIR` on purpose.

## How `db_snapshot.py compare` decides (it fails when it cannot prove)

A snapshot stores, per table, the columns, the primary key and — for every row — a hash of the primary key
and a hash of **each cell** (column name + value). No values are stored, but a hash of a short number can be
guessed, so keep snapshots next to the private archive and out of any review package.

`compare before after` exits 0 only when

* every table, row and column that existed before still exists, and no row appeared;
* every cell of every old column is unchanged — **including when columns were added in between** —
  except columns named explicitly with `--allow-changed TABLE.COLUMN`;
* every new table is named with `--allow-new-table T` and every new column with `--allow-new-column TABLE.COLUMN`;
* both snapshots carry per-cell hashes (a snapshot from an older version of this tool is rejected).

Anything else — an unnamed new column, an allowance that names a column that does not exist, a
primary-key change, duplicate keys — is a failure, never a pass. Problems are reported per column and row
count, without values.

## After the deploy

```bash
python tools/db_snapshot.py snapshot /data/calorie_scanner.db after-deploy.json
python tools/db_snapshot.py compare source_db.json after-deploy.json \
       --allow-new-table sessions \
       --allow-new-column users.pin_failed_count --allow-new-column users.pin_locked_until
```

Expected: `IDENTICAL`. These are the only schema additions of the Stage 1 work. A legacy PIN is rewritten to
the salted format only after that same PIN signs in; if anyone has signed in, add
`--allow-changed users.pin_hash` — and nothing else may differ. Rows written after the backup (a new
meal, a weigh-in) are real changes and will show as differences: compare right after the deploy, or take a
fresh `source_db.json` first.

## What the archive does NOT cover

* Nothing schedules these runs. A scheduled job (Coolify scheduled task) and an off-server copy are still to be set up.
* Sub-folders inside the uploads directory are not archived (the app writes a flat folder); they are listed
  in the manifest as `uploads_not_archived`.
