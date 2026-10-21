# Backup, restore and "was anything lost?" checks

Two small, dependency-free tools (Python standard library only). Nothing here runs automatically and
nothing touches production unless you point it there.

## Before any deploy that changes the database or the sign-in system

1. **Back up the live data** (from a shell inside the running container, e.g. Coolify's terminal for the app):

   ```bash
   python tools/backup.py create --db /data/calorie_scanner.db --uploads /data/uploads --out /data/backups
   ```

   It copies the database with SQLite's online backup API (safe while the app is running), adds every
   photo, writes `MANIFEST.json` (SHA-256 of every file, per-table row counts, `integrity_check`), and then
   **reads the archive back and verifies it**. It must end with `VERIFIED`. Copy the `.zip` off the server
   (it contains personal data — store it accordingly). A backup that stays only inside the same volume
   does not protect against losing the volume.

2. **Take a fingerprint of the data** (hashes and counts only — no personal values):

   ```bash
   python tools/db_snapshot.py snapshot /data/calorie_scanner.db /data/backups/before.json
   ```

3. **Prove the backup restores** — on a copy, never over the live paths:

   ```bash
   python tools/backup.py restore /data/backups/calorie-scanner-backup-<stamp>.zip \
          --db /tmp/restore-test/calorie_scanner.db --uploads /tmp/restore-test/uploads
   python tools/db_snapshot.py snapshot /tmp/restore-test/calorie_scanner.db /tmp/restore-test/after.json
   python tools/db_snapshot.py compare /data/backups/before.json /tmp/restore-test/after.json
   ```

   `compare` must say `IDENTICAL`. `restore` refuses to overwrite an existing database or a non-empty
   uploads directory and ignores `CALORIE_DB_PATH` / `CALORIE_UPLOADS_DIR` on purpose.

## After the deploy

```bash
python tools/db_snapshot.py snapshot /data/calorie_scanner.db /data/backups/after-deploy.json
python tools/db_snapshot.py compare /data/backups/before.json /data/backups/after-deploy.json \
       --allow-new-table sessions
```

Expected: `IDENTICAL`, with notes listing the new `users` columns and the new `sessions` table. (The
sessions table and a user's two sign-in counters are the only schema additions of the Stage 1 work; a
legacy PIN is rewritten to the salted format only after that same PIN signs in — pass
`--allow-changed users.pin_hash` if you compare after someone has signed in.) Rows written after the
snapshot (a new meal, a weigh-in) are real changes and will show up as differences; compare right after
the deploy, or snapshot again just before it.

## What the archive does NOT cover

* Nothing schedules these runs. A scheduled job (Coolify scheduled task) and an off-server copy are still to be set up.
* If an entry points to a photo that is already missing on disk, the backup records it as
  `photos_referenced_but_missing` rather than failing — the data was lost before the backup.
