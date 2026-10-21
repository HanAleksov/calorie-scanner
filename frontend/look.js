// Appearance preferences. Two INDEPENDENT settings, both remembered on this device only:
//   theme: "system" | "light" | "dark"      (system follows the OS and re-applies when the OS changes)
//   mode:  "normal" | "roman"               (Roman Legion: same data and actions, different presentation)
// Applied as data-theme / data-mode on <html>; style.css keys all colour tokens off the two attributes, so every
// theme x mode combination is a pure CSS state and nothing here knows about colours.
// Loaded in <head> (before first paint) so the page never flashes the wrong look.
(function (root) {
  "use strict";

  const THEMES = ["system", "light", "dark"];
  const MODES = ["normal", "roman"];
  const KEY_THEME = "theme";        // same key the old light/dark toggle used, so existing choices carry over
  const KEY_MODE = "lookMode";

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(storage, key, value) {
    try {
      if (value === null) storage.removeItem(key); else storage.setItem(key, value);
    } catch (e) { /* private mode / blocked storage: the choice just doesn't persist */ }
  }

  function create({ storage, doc, matchMedia }) {
    const mql = matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
    const listeners = [];
    let theme = THEMES.includes(safeGet(storage, KEY_THEME)) ? safeGet(storage, KEY_THEME) : "system";
    let mode = MODES.includes(safeGet(storage, KEY_MODE)) ? safeGet(storage, KEY_MODE) : "normal";

    const effectiveTheme = () => (theme === "system" ? (mql && mql.matches ? "dark" : "light") : theme);

    function apply() {
      const el = doc.documentElement;
      el.setAttribute("data-theme", effectiveTheme());
      el.setAttribute("data-mode", mode);
      listeners.forEach((fn) => fn({ theme, mode, effective: effectiveTheme() }));
    }

    if (mql && mql.addEventListener) mql.addEventListener("change", () => { if (theme === "system") apply(); });

    return {
      get theme() { return theme; },
      get mode() { return mode; },
      effectiveTheme,
      setTheme(next) {
        if (!THEMES.includes(next)) return false;
        theme = next;
        safeSet(storage, KEY_THEME, next === "system" ? null : next);
        apply();
        return true;
      },
      setMode(next) {
        if (!MODES.includes(next)) return false;
        mode = next;
        safeSet(storage, KEY_MODE, next === "normal" ? null : next);
        apply();
        return true;
      },
      onChange(fn) { listeners.push(fn); },
      apply,
    };
  }

  const api = { THEMES, MODES, create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CSLook = api;

  // In the browser: create the shared instance right away.
  if (typeof document !== "undefined" && root.localStorage !== undefined) {
    const look = create({ storage: root.localStorage, doc: document, matchMedia: root.matchMedia && root.matchMedia.bind(root) });
    look.apply();
    root.look = look;
  }
})(typeof window !== "undefined" ? window : globalThis);
