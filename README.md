# Calorie Scanner — ready to use

## Tonight / right now

The server is already running on this PC. To start it again later (after a reboot, etc.):

1. Double-click `start.bat` in this folder.
2. On your phone, connect to the **same WiFi** as this PC, then open a browser and go to:

   **http://192.168.1.156:8420**

   (If that doesn't load, this PC's WiFi address may have changed — run `ipconfig` in a terminal here, look for "IPv4 Address", and use that instead of `192.168.1.156`.)

## Installing it as an app on your phone

**Android (Chrome):** open the link above, then either tap the "Install app" button that appears in the header, or use Chrome's menu → "Install app" / "Add to Home screen".

**iPhone (Safari — must be Safari, not Chrome):** open the link above, tap the **Share** button, then **"Add to Home Screen"**. The app will show a one-time banner reminding you of this the first time you visit.

Once installed, it opens full-screen with its own icon, no browser bar — a real app, just not one that goes through an app store.

## What it does

- Take a photo of a meal (or upload one) → Claude analyzes it and estimates calories, protein, carbs, and fat automatically.
- If the model isn't confident (mixed dishes, sauces, unclear portions), it says so — you'll see a "low confidence" tag rather than a falsely precise number.
- Today's totals with a progress bar against your daily goal, plus per-macro bars.
- Edit or delete any entry.
- Manual entry for anything a photo won't work well for (soup, a protein shake, etc.).
- 14-day history view.
- Set your own daily calorie/macro goals under the Goals tab.
- Dark mode toggle (also follows your phone's system setting automatically).

## About the "real .apk" ask

This machine doesn't have Android/Java build tooling installed, and a genuine installable `.apk` needs that tooling **plus** the app already running on a public HTTPS address (not your home WiFi) for Android to trust it without a warning. Installing to your home screen via the browser (above) gives you the exact same result on your phone — its own icon, full-screen, works offline for the interface — without any of that setup risk.

If you still want an actual `.apk` file later: get this deployed to Render first (see below), then ask and I'll set up the Android packaging on top of that — it's a clean next step, not a redo.

## Putting it online (so it works away from home WiFi too)

Everything is ready for this — `render.yaml` in this folder defines the whole service. It's not deployed yet because that needs a Render account, which I can't create for you. Whenever you're ready:

1. Create a free account at render.com (or tell me you already have one).
2. Push this folder to a GitHub repo (or tell me to do it).
3. In Render, "New" → "Blueprint" → point it at the repo — it reads `render.yaml` automatically.
4. Add your `ANTHROPIC_API_KEY` as an environment variable in the Render dashboard (it's deliberately left out of `render.yaml` so it's never committed to git).

## Cost

Each photo analysis costs a fraction of a cent (Claude Opus 5 vision, a few thousand tokens per image). Logging every meal for a full day costs well under $0.10.

## If something breaks

Check `backend/CLAUDE.md` for the non-obvious bits of how this is wired together.
