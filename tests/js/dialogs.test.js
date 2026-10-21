// Run: node --test tests/js/*.test.js
// Which dialog is "on top", the z-index order, and the Settings -> What's New hand-over.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStack, zIndexAt, BASE_Z } = require("../../frontend/dialogs.js");

const front = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "frontend", f), "utf8");

test("the top dialog is the most recently OPENED one, whatever its place in the page", () => {
  const s = createStack();
  s.open("settingsModal");           // later in the DOM
  s.open("whatsNewModal");           // earlier in the DOM
  assert.equal(s.top, "whatsNewModal");
  s.open("settingsModal");           // re-opened: newest again
  assert.equal(s.top, "settingsModal");
  assert.deepEqual(s.order, ["whatsNewModal", "settingsModal"]);
});

test("every open dialog is above the one under it (a later dialog can never be covered by an earlier one)", () => {
  const s = createStack();
  ["a", "b", "c"].forEach((id) => s.open(id));
  const z = s.order.map((_, i) => zIndexAt(i));
  assert.deepEqual(z, [BASE_Z, BASE_Z + 1, BASE_Z + 2]);
  assert.ok(z.every((v, i) => i === 0 || v > z[i - 1]));
});

test("closing a dialog under the top one leaves the top one on top", () => {
  const s = createStack();
  s.open("a"); s.open("b");
  assert.deepEqual(s.close("a"), { top: "b", reopen: null });
  assert.equal(s.top, "b");
});

test("Settings -> What's New: Settings steps aside, and comes back when What's New closes (once)", () => {
  const s = createStack();
  s.open("settingsModal");
  s.returnTo("whatsNewModal", "settingsModal");     // registered before Settings closes
  s.close("settingsModal");
  s.open("whatsNewModal");
  assert.equal(s.top, "whatsNewModal");
  assert.deepEqual(s.order, ["whatsNewModal"], "never both at once");
  const back = s.close("whatsNewModal");
  assert.equal(back.reopen, "settingsModal");
  s.open("settingsModal");
  assert.equal(s.top, "settingsModal");
  s.open("whatsNewModal");                          // opened again later WITHOUT a hand-over
  assert.equal(s.close("whatsNewModal").reopen, null, "the return is used up");
});

test("nothing is brought back if that dialog is already open", () => {
  const s = createStack();
  s.open("settingsModal"); s.open("whatsNewModal");
  s.returnTo("whatsNewModal", "settingsModal");
  assert.equal(s.close("whatsNewModal").reopen, null);
});

test("closing something that is not open is harmless", () => {
  const s = createStack();
  assert.deepEqual(s.close("ghost"), { top: null, reopen: null });
});

// ---- the page wiring that the stack relies on
test("every sheet in the page has a Close/Cancel button wired for Escape, and can be dragged away", () => {
  const html = front("index.html"), app = front("app.js");
  const ids = [...html.matchAll(/<div class="modal-backdrop[^"]*" id="(\w+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 9, ids.join(","));
  const map = app.slice(app.indexOf("const DIALOG_CLOSE_BUTTON"), app.indexOf("};", app.indexOf("const DIALOG_CLOSE_BUTTON")));
  for (const id of ids) {
    const m = new RegExp(`${id}:\\s*"(\\w+)"`).exec(map);
    assert.ok(m, `${id} has no Escape button in DIALOG_CLOSE_BUTTON`);
    assert.ok(html.includes(`id="${m[1]}"`), `${m[1]} (for ${id}) is not in the page`);
    assert.ok(app.includes(`attachSheetDrag($("${id}")`), `${id} cannot be dragged away`);
  }
});

test("Settings opens What's New and the reaction preview through the hand-over, not by just showing them", () => {
  const app = front("app.js");
  assert.match(app, /\$\("whatsNewBtn"\)\.addEventListener\("click", \(\) => openFromSettings\("whatsNewModal", openWhatsNew\)\)/);
  assert.match(app, /openFromSettings\("legionPreviewModal"/);
  assert.match(app, /dialogStack\.returnTo\(modalId, "settingsModal"\)/);
});

test("Escape and the Tab trap follow the stack, not the page order", () => {
  const app = front("app.js");
  assert.match(app, /const topId = dialogStack\.top;/);
  assert.ok(!/openDialogs\(\)\[open\.length - 1\]/.test(app), "the old 'last in the DOM' rule is gone");
});

test("dialogs get a z-index from their position in the stack", () => {
  assert.match(front("app.js"), /m\.style\.zIndex = at >= 0 \? String\(CSDialogs\.zIndexAt\(at\)\)/);
});
