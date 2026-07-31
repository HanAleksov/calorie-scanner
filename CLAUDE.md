# Calorie Scanner — gotchas

- Backend and frontend are one FastAPI app: `backend/main.py` serves the API under `/api/*` and mounts `frontend/` as static files at `/`. There is no separate frontend server or build step.
- Vision calls go through `backend/vision.py`, model `claude-opus-5`, using `output_config.format` (json_schema) — the response is guaranteed valid JSON, no prompt-parsing fallback needed. If Anthropic ever deprecates `claude-opus-5`, only this one string needs to change.
- `ANTHROPIC_API_KEY` lives in `backend/.env` (gitignored). Never commit it.
- DB path and uploads dir are overridable via `CALORIE_DB_PATH` / `CALORIE_UPLOADS_DIR` env vars — used for Render's persistent disk and for test isolation. Don't hardcode paths in `db.py` or `main.py`.
- SQLite file and uploaded photos are gitignored — they're runtime data, not source.
- The service worker (`frontend/sw.js`) explicitly skips caching anything under `/api/` or `/uploads/` — cache-first there would show stale meal data or serve a 404 for a new photo. If you add new API routes, they're already excluded by prefix, no sw.js change needed.
- iOS does not read `manifest.json` for install — the `<meta name="apple-mobile-web-app-*">` tags and `apple-touch-icon` link in `index.html` are load-bearing for iOS home-screen install, not decorative.
- `est_grams` is `None`/`null` for manually-logged entries (no photo to estimate portions from) — the frontend must not assume it's always a number.
- **Bump `CACHE_NAME` in `frontend/sw.js` on every frontend change.** The service worker only re-checks its own script for byte changes; if `sw.js` is byte-identical to what's already installed, the browser never notices anything else changed. `app.js` and `style.css` are served network-first (fall back to cache offline) specifically so an installed PWA doesn't get stuck on stale UI — don't revert that to cache-first without a strong reason.
- `nutrition.py` and `meal_plan.py` are separate from `vision.py` on purpose — same Claude Opus 5 model, but text-only (no image), structured JSON output via `output_config.format`. `nutrition.py` is pure arithmetic (Mifflin-St Jeor), no API call.
- Profile fields can be `NULL` (nothing filled in yet) — `/api/goals/suggested` requires all of them and 400s otherwise; don't assume `db.get_profile()` returns a fully populated row.
