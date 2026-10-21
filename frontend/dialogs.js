// Which dialogs are open, in the order they were OPENED (not DOM order), and where to go when one closes.
// Pure logic with no DOM, so it is unit-tested; app.js adapts it to the real sheets (focus, inert, z-index, Esc).
//
// Rules:
//   * the TOP dialog is the last one opened: it gets Tab/Escape, the dialogs under it are inert;
//   * every open dialog gets a higher z-index than the one under it, so a later one can never be covered by an
//     earlier one just because it comes earlier in the page;
//   * a dialog can be opened "from" another one (Settings -> What's New): the first one is closed, and when the second
//     closes by ANY route (Close, Escape, drag, programmatic) the first comes back, with focus on the control that
//     opened the second.
(function (root) {
  "use strict";

  const BASE_Z = 20;

  function createStack() {
    const order = [];                 // ids, oldest first
    const returns = new Map();        // id -> id to bring back when `id` closes

    return {
      get order() { return order.slice(); },
      get top() { return order.length ? order[order.length - 1] : null; },
      isOpen: (id) => order.includes(id),
      zIndex: (id) => BASE_Z + order.indexOf(id),
      // Remember, BEFORE the first dialog closes, that closing `id` should bring `back` again.
      returnTo(id, back) { returns.set(id, back); },
      open(id) {
        const i = order.indexOf(id);
        if (i >= 0) order.splice(i, 1);        // re-opened: it is now the newest
        order.push(id);
        return { top: id, underneath: order.slice(0, -1) };
      },
      // -> { top: the dialog that is now on top (or null), reopen: the dialog to bring back (or null) }
      close(id) {
        const i = order.indexOf(id);
        if (i >= 0) order.splice(i, 1);
        const back = returns.get(id) || null;
        returns.delete(id);
        return { top: order.length ? order[order.length - 1] : null, reopen: back && !order.includes(back) ? back : null };
      },
    };
  }

  const zIndexAt = (position) => BASE_Z + position;

  const api = { BASE_Z, zIndexAt, createStack };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CSDialogs = api;
})(typeof window !== "undefined" ? window : globalThis);
