#!/usr/bin/env bash
# Consistent archive of the production database + photos, taken in a TECHNICAL no-write window.
#
# The app container is stopped (gracefully) for the few seconds in which the database snapshot, the photo
# copy and the fingerprints are taken, and is started again by a trap on EVERY exit path (success, failure,
# Ctrl-C, closed terminal). Everything after that (verify, restore into empty paths, comparison, checksums)
# works on the archive only, with the app already running again.
#
# Each attempt gets its own directory, $BASE/attempts/<timestamp>/. Nothing is ever deleted or reused: a failed
# attempt keeps its archive, logs and a FAILED file for diagnosis.
#
# Needs (confirmed by the read-only discovery, SERVER_BACKUP.md part 1), exported or set inline:
#   CID    the app container id          IMAGE  the image id the container runs NOW (not a movable tag)
#   SRC    the volume/dir mounted at /data   DB   path to the database inside it   UP   path to the photos inside it
#   BASE   working dir holding tools/ (backup.py, db_snapshot.py)
# Run it as root on the server:  bash $BASE/archive_window.sh
set -u
: "${CID:?CID is not set}" "${IMAGE:?IMAGE is not set}" "${SRC:?SRC is not set}"
: "${DB:?DB is not set}" "${UP:?UP is not set}" "${BASE:?BASE is not set}"
APP_URL_PATH="${APP_URL_PATH:-/health}"      # checked INSIDE the container; the image ships curl
APP_PORT="${APP_PORT:-8000}"
STOP_TIMEOUT="${STOP_TIMEOUT:-30}"

STAMP=$(date +%Y%m%d-%H%M%S)
ATT="$BASE/attempts/$STAMP"
mkdir -p "$ATT/out" "$ATT/restore" || { echo "can't create $ATT"; exit 1; }
LOG="$ATT/log.txt"
exec > >(tee -a "$LOG") 2>&1
echo "attempt $STAMP  ->  $ATT"

STOPPED=0          # 1 from the moment we ask the app to stop until we have started it again
APP_BACK=0
RESULT=1

H() {   # helper container: data volume READ-ONLY, tools READ-ONLY, writes only to this attempt's out/, no network
  docker run --rm --network none --read-only --tmpfs /tmp:rw,size=2g \
    -v "$SRC":/data:ro -v "$BASE/tools":/tools:ro -v "$ATT/out":/out \
    --entrypoint python "$IMAGE" -B "$@"
}
R() {   # restore/verify container: NO production volume at all
  docker run --rm --network none --read-only --tmpfs /tmp:rw,size=2g \
    -v "$BASE/tools":/tools:ro -v "$ATT/out":/out -v "$ATT/restore":/restore \
    --entrypoint python "$IMAGE" -B "$@"
}

app_state() { docker inspect -f '{{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}}{{if .State.Health}} health={{.State.Health.Status}}{{end}}' "$CID" 2>&1; }

wait_for_app() {   # up to ~2 minutes: running, and answering inside the container
  for _ in $(seq 1 "${WAIT_TRIES:-60}"); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$CID" 2>/dev/null)" = "true" ] &&
       docker exec "$CID" curl -fsS -o /dev/null "http://localhost:${APP_PORT}${APP_URL_PATH}" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

start_app() {
  [ "$APP_BACK" = 1 ] && return 0
  echo "== starting the app again"
  docker start "$CID" >/dev/null 2>&1
  if wait_for_app; then
    APP_BACK=1; STOPPED=0
    echo "== APP IS BACK: $(app_state)"
    return 0
  fi
  echo "!! THE APP DID NOT COME BACK IN TIME: $(app_state)"
  echo "!! try:  docker start $CID ; docker logs --tail 50 $CID   (or Deploy/Restart from Coolify)"
  return 1
}

finish() {   # runs on every exit path
  code=$?
  trap - EXIT INT TERM HUP
  if [ "$STOPPED" = 1 ]; then
    echo "!! leaving with the app stopped — restarting it first"
    start_app || code=3
  fi
  if [ "$RESULT" = 0 ] && [ "$code" = 0 ]; then
    : > "$ATT/ACCEPTED"
    echo; echo "ACCEPTED  $ATT"
  else
    [ -e "$ATT/ACCEPTED" ] || printf 'exit code %s\n' "$code" > "$ATT/FAILED"
    echo; echo "NOT ACCEPTED (kept for diagnosis, nothing deleted): $ATT"
    [ "$code" = 0 ] && code=1
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT TERM HUP

step() { echo; echo "== $*"; }
need() { "$@" || { echo "!! failed: $*"; exit 1; }; }

# ---------------------------------------------------------------- context (app still running)
step "context"
need test -f "$BASE/tools/backup.py"
need test -f "$BASE/tools/db_snapshot.py"
{
  echo "container: $CID"
  docker inspect -f 'image id: {{.Image}}{{println}}configured image: {{.Config.Image}}{{println}}created: {{.Created}}{{println}}started: {{.State.StartedAt}}{{println}}restart policy: {{.HostConfig.RestartPolicy.Name}}' "$CID"
  echo "helper image: $IMAGE"
  sha256sum "$BASE"/tools/*.py
} | tee "$ATT/context.txt"
[ "$(docker inspect -f '{{.State.Running}}' "$CID")" = "true" ] || { echo "!! the app is not running now; nothing to do"; exit 1; }
need H -c "import sqlite3; c=sqlite3.connect('file:$DB?mode=ro', uri=True); j=c.execute('PRAGMA journal_mode').fetchone()[0]; print('journal_mode', j); raise SystemExit(0 if j=='delete' else 1)"

# ---------------------------------------------------------------- the write-free window
step "STOPPING THE APP (window opens)"
STOPPED=1
docker stop -t "$STOP_TIMEOUT" "$CID" >/dev/null || { echo "!! docker stop failed"; exit 1; }
echo "$(app_state)"
[ "$(docker inspect -f '{{.State.Running}}' "$CID")" = "false" ] || { echo "!! still running"; exit 1; }
[ "$(docker inspect -f '{{.State.ExitCode}}' "$CID")" = "0" ] || echo "note: the app exited with a non-zero code (killed, not stopped cleanly?) — the journal check below decides"

step "no half-finished write on disk"
need H -c "
import os
names = sorted(os.listdir('/data'))
print(names)
bad = [n for n in names if n.endswith(('-journal', '-wal', '-shm'))]
print('leftover journal files:', bad)
raise SystemExit(1 if bad else 0)"

step "fingerprint before"
need H /tools/backup.py fingerprint --db "$DB" --uploads "$UP" --out /out/fp_before.json
step "archive (create verifies it)"
H /tools/backup.py create --db "$DB" --uploads "$UP" --out /out
CREATE_CODE=$?
echo "create exit code: $CREATE_CODE   (0 = VERIFIED, 2 = INCOMPLETE, 1 = failed)"
step "fixed source snapshot"
need H /tools/db_snapshot.py snapshot "$DB" /out/source_db.json
step "fingerprint after"
need H /tools/backup.py fingerprint --db "$DB" --uploads "$UP" --out /out/fp_after.json
need H /tools/backup.py compare-fingerprint /out/fp_before.json /out/fp_after.json --same-db
[ "$(docker inspect -f '{{.State.Running}}' "$CID")" = "false" ] || { echo "!! the app was started by something else during the window — attempt rejected"; exit 1; }

step "WINDOW CLOSES — starting the app"
start_app || exit 3
[ "$CREATE_CODE" = 0 ] || { echo "!! the archive is not VERIFIED (code $CREATE_CODE) — attempt rejected"; exit 1; }

# ---------------------------------------------------------------- from here on: archive only, app is running
ZIP=$(cd "$ATT/out" && ls calorie-scanner-backup-*.zip 2>/dev/null)
[ "$(printf '%s\n' "$ZIP" | wc -l)" = 1 ] && [ -n "$ZIP" ] || { echo "!! expected exactly one archive, got: $ZIP"; exit 1; }

step "verify the archive (no production volume mounted)"
need R /tools/backup.py verify "/out/$ZIP"
step "restore into new empty paths"
need R /tools/backup.py restore "/out/$ZIP" --db /restore/calorie_scanner.db --uploads /restore/uploads
step "compare restored with the FIXED source (no allowances)"
need R /tools/db_snapshot.py snapshot /restore/calorie_scanner.db /out/restored_db.json
need R /tools/db_snapshot.py compare /out/source_db.json /out/restored_db.json
need R /tools/backup.py fingerprint --db /restore/calorie_scanner.db --uploads /restore/uploads --out /out/fp_restored.json
need R /tools/backup.py compare-fingerprint /out/fp_before.json /out/fp_restored.json

step "checksums for the copy off the server"
( cd "$ATT/out" && sha256sum *.zip *.json > SHA256SUMS.txt && cat SHA256SUMS.txt ) || exit 1
RESULT=0
