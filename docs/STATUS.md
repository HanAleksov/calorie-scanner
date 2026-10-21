# Calorie Scanner — project status and hand-off

This file lets the project continue without the session that built it. It is kept in the repository on purpose; it holds
no secrets, no server addresses and no production data. (Where things live: `CLAUDE.md` has the engineering rules and
gotchas, `backend/tools/SERVER_BACKUP.md` the production backup procedure, this file the state of the work.)

## Two stages, kept apart

| | Branch | Contents | State |
|---|---|---|---|
| **Stage 1** | `stage1-sessions` (last commit `60444ef`) | server-side sessions + CSRF, owner-checked photos, server validation, one-request-one-transaction writes, reliable client networking, backup / restore / "nothing was lost" tools, production archive procedure | finished and reviewed, **not published**: pushing it to `master` (which auto-deploys) was blocked in the session that built it, so it has to be done by hand — see "Order of release" |
| **Stage 2** | `stage2-ui` (on top of Stage 1) | the redesign (Today, Progress, Plan, sign-in, Settings, every panel), light/dark × Normal/Roman style, the Roman centurion, the meal schedule, the time a meal was eaten, in-app reminders | cycle 1 finished locally; one review + one fixing cycle left; **never pushed or deployed** |

Stage 2 contains every Stage 1 commit (its history starts at `master` = `a685a3b`), so Stage 2 can only ever go out
**after or together with** Stage 1. `git log --oneline master..stage2-ui` lists exactly what a release would contain.

## Done / partial / missing

**Done (verified by tests, a real browser run and mutation checks — see the review package)**
- Stage 1 as above.
- Redesigned screens: sign-in, Today, Progress (weight hero, 14-day calorie chart with a day detail), Plan (targets hero, schedule card, folded profile), Settings (grouped), Add-food panel, photo review, manual entry, favourites, editor, schedule dialog, welcome, what's new, reaction preview (DEMO). Four looks: Normal/Roman × light/dark; Bulgarian and English.
- Meal schedule (per profile, up to six meals), the time a meal was eaten (separate from when it was logged; old entries stay unconfirmed), in-app reminders (off until switched on; only while the app is open; no AI, no network).
- The Roman centurion reacts to the schedule and the records: calm line naming the next meal, reminder before a planned meal, "did you eat?" when there is no record, approval after a logged meal. Four portrait files, replaceable (`frontend/legion/README.md`).
- Dialog stack (Settings → What's New / schedule / preview and back), accessible names, 40 px targets, reduced motion, focus handling.

**Partial**
- Real devices: everything was exercised in headless Edge (phone-sized viewports, `bg-BG` and `en-US`) and a fake DOM. Not tested on a real phone, as an installed PWA, with a real on-screen keyboard (iOS/Android), or with a screen reader.
- The centurion art is a set of temporary SVGs; the final portraits are a file swap (spec in `frontend/legion/README.md`).
- "Eaten time" covers the same calendar day only (see Known problems).
- Production archive: a verified archive exists on the server; the off-server SHA-256 copy is still to be made.

**Missing — described, not started**
- Background notifications (push) — see "Next tasks".
- Android package (APK / TWA).
- Ranks and missions for the legion.
- Deploying anything: Stage 1 and Stage 2 are both unpublished.

## Known problems (not fixed on purpose or not yet found)
1. **Release is blocked for Stage 1**: `git push origin master` / merge was refused by the build session's permission layer ("production deploy"). Nothing is wrong with the code; whoever owns the repository runs the commands (below).
2. **Eaten time is same-day only.** `eaten_time` is just "HH:MM" on the day of `created_at`; logging at 00:20 for a 23:30 dinner is not possible yet. Today's entries can't have a time later than the app's clock.
3. **The coach tip and the analyst still use the LOGGED time** (`created_at`), not the eaten time. Deliberately untouched ("no changes to automatic recommendations"); a follow-up if wanted.
4. **Entries added from the meal plan ("Log this")** carry no eaten time until edited; old entries have none and there is no bulk "confirm" action.
5. **Reminders need the app open.** Closing it, or a phone suspending the page, means no reminder; when the page comes back to the foreground it re-evaluates at once. Grace (30 min) and window (3 h) are constants in `frontend/schedule.js`, not settings.
6. **Reminders follow the app's clock (Europe/Sofia)**, not the phone's: someone in another time zone sees Sofia times.
7. The 14-day chart is the only history range. A "count this day" choice is per day, as before.
8. The Roman layout of Today is taller than Normal's (portrait + line); its calm line can name the next meal and repeats the "Next:" note under the meals heading.
9. Time fields are the browser's native time input: 24 h or AM/PM follows the phone's setting.
10. Services that only work over HTTPS (service worker, "Secure" cookie) were exercised on localhost only; the production address must be re-checked after release (checklist below).
11. Housekeeping: database backups next to the live database (`backend/*.db.bak*`) are git-ignored; never `git add` a whole directory without looking at what it stages.
12. `AGENTS.md` (untracked, ignored by the image) is a local file; leave it out of commits.

## Next tasks (described, not started)

**Background notifications.** Today's reminders are drawn by the open page. To nudge a closed app: Web Push (VAPID keys in server env, never in the repo), a `push_subscriptions` table keyed by profile (+ endpoint, keys, user agent), a service-worker `push` handler, an explicit permission step in the schedule dialog (never on first load), and a server scheduler that evaluates each profile's schedule in the profile's own time zone (needs a `timezone` column; today everything is Europe/Sofia) using the same rules as `schedule.js` (port them, keep one set of tests). iOS only delivers web push to an installed PWA (16.4+). No AI is needed or wanted for this.

**APK.** A Trusted Web Activity / Capacitor wrapper around the HTTPS address: needs a public HTTPS domain, Digital Asset Links, an Android toolchain, a signing key kept outside the repo. Do it after the background-notification decision (a native shell can use native notifications instead of web push).

**Ranks and missions.** Not designed. Prerequisites: decide what counts (only CONFIRMED eaten times and logged meals, never upload times), where the numbers live (new tables, additive), and that they must not touch nutrition formulas or targets. Roman style only; Normal style must stay free of it. The centurion's four reactions and `CSLegion.reaction(kind, lang, n, vars)` are the hooks.

**Smaller follow-ups**: cross-midnight eaten time (store a full timestamp instead of "HH:MM"); use the eaten time in the coach prompt; a "confirm times" review for old entries; a range switch on the chart.

## Running it

```
# backend (Python 3.12 in production; 3.14 works locally)
cd backend
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt     # Windows; use .venv/bin/python elsewhere
.venv/Scripts/python -m uvicorn main:app --host 0.0.0.0 --port 8420                       # or start.bat
# needs backend/.env with ANTHROPIC_API_KEY for photo analysis, tips and meal plans (never commit it)

# tests (no paid requests: every AI client raises if a test reaches it)
cd backend && .venv/Scripts/python -m unittest discover -s tests -t .
node --test tests/js/*.test.js                                                            # Node 18+; a directory argument does not work on Node 24

# the real UI on invented people with stubbed AI and a movable clock (for screenshots / browser tests)
backend/.venv/Scripts/python backend/tests/ui_server.py 8423      # /api/__test/clock?hhmm=19:20 moves the app's clock
```
Dependencies: `backend/requirements.txt` (runtime) and `backend/requirements-dev.txt` (adds `httpx` for the test client). There is no front-end build step and no npm dependency (Node is only the test runner).

## Order of release (when the review cycle is finished)
1. Stage 1 first, from a machine that may push: `git checkout master && git merge --ff-only stage1-sessions && git push origin master` (Coolify builds and deploys from `master`). Before it: a verified archive of the production database and uploads (`backend/tools/SERVER_BACKUP.md`, `archive_window.sh`).
2. After Stage 1 is verified live (HTTPS cookie flags, profile/photo isolation, data unchanged, PWA install), Stage 2: `git merge --ff-only stage2-ui` and push. The Stage 2 migration is additive and runs at start-up: `entries.eaten_time` (NULL for everything that exists), tables `meal_schedule` and `reminder_settings`. Take a fresh archive first and compare afterwards: `db_snapshot.py compare ... --allow-new-table meal_schedule --allow-new-table reminder_settings --allow-new-column entries.eaten_time`.
3. Post-release checklist: sign in over HTTPS; today's entries unchanged and old ones show "Записано в ..." (not "Ядено в ..."); add a meal with a time; schedule dialog saves; reminders stay OFF for everyone until switched on; the service worker updates (cache name in `frontend/sw.js`); then the off-server checksum copy of the archive.

## Rolling back
- **Code**: redeploy the previous image / revert the merge. Stage 1 code runs on a Stage 2 database unchanged (verified by running the Stage 1 app on a migrated file: sign-in, Today, log, edit, delete, history). The extra column and tables are ignored by older code and cost nothing.
- **Data**: nothing needs undoing; no existing row is modified by the Stage 2 migration (proved by `tests/test_schedule_times.py::StageOneUpgradeTests`). If the server's volume itself must be restored, use `backup.py restore` from the pre-release archive into an empty location (`SERVER_BACKUP.md`).
- **Old PINs**: a profile that signed in after Stage 1 holds a new-format PIN hash that pre-Stage-1 code cannot verify; rolling back past Stage 1 needs the old `pin_hash` value restored from the archive for that profile.
