# Centurion portraits (TEMPORARY placeholders)

Four files, one per state, loaded by `frontend/legion.js` (`CSLegion.ASSETS`):

| state | file | when |
|---|---|---|
| idle | `portrait-idle.svg` | the normal, serious face |
| approve | `portrait-approve.svg` | a meal was just logged |
| remind | `portrait-remind.svg` | before a chosen meal time (not wired yet) |
| demand | `portrait-demand.svg` | an expected record is missing (not wired yet) |

**These four SVGs are placeholders drawn in code.** To use the final art, replace the files (keep the names, or change the
four paths in `ASSETS` in `legion.js`; any format an `<img>` can show works: svg, png, webp).

Spec for the final portraits: the same serious, mature character in all four, shoulders-up, **3:4 portrait ratio**
(e.g. 720x960 px, transparent background), subject centred with some head-room, readable at ~100 px wide.
States differ by expression only (brows, gaze, mouth, head angle); no props, effects or caricature.
Keep each file small (< 150 kB). The service worker serves these network-first, so a replaced file reaches the app
at the next load.
