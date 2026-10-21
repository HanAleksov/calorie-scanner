// Loads the REAL frontend scripts (i18n, whatsnew, units, api, app — in index.html's order) into a vm
// context with a permissive fake DOM, so a test can drive the actual handlers in app.js: the same code the
// browser runs, with only the DOM and the network replaced. No dependencies (Node 18+).
//
//   const h = loadApp({ route: async (path, opts) => Response });
//   h.el("heightIn")            -> the fake element behind $("heightIn") (same object every time)
//   h.fire("heightIn", "input") -> runs the listeners the page registered for that event
//   h.run("renderUnitFields()") -> evaluates code inside the page's global scope
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const FRONTEND = path.join(__dirname, "..", "..", "..", "frontend");
const SCRIPTS = ["i18n.js", "whatsnew.js", "units.js", "api.js", "app.js"];

function makeElement(id) {
  const store = {
    id, value: "", innerHTML: "", textContent: "", className: "", disabled: false, hidden: false, checked: false,
    open: false, dataset: {}, style: {}, files: [], listeners: {},
  };
  const classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  return new Proxy(store, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (prop === "classList") return classList;
      if (prop === "addEventListener") return (type, fn) => { (target.listeners[type] ||= []).push(fn); };
      if (prop === "querySelectorAll") return () => [];
      if (prop === "querySelector" || prop === "closest" || prop === "getAttribute") return () => null;
      return () => undefined;                              // focus(), appendChild(), remove(), setAttribute() ...
    },
    set(target, prop, value) {
      target[prop] = prop === "value" ? (value === null || value === undefined ? "" : String(value)) : value;   // like a real <input>
      return true;
    },
  });
}

// CS_APP_SOURCE=<file> runs the same tests against another copy of app.js (used to prove a test fails on the
// code it was written to catch, e.g. the version from before a fix).
function loadApp({ route, appSource = process.env.CS_APP_SOURCE ? fs.readFileSync(process.env.CS_APP_SOURCE, "utf8") : undefined } = {}) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const document = new Proxy({
    getElementById: el,
    createElement: () => makeElement("created"),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    body: el("body"),
    documentElement: el("html"),
  }, { get: (t, p) => (p in t ? t[p] : typeof p === "symbol" ? undefined : () => undefined) });

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const calls = { reloads: 0, fetches: [] };
  const never = new Promise(() => {});                      // a request nobody answers (page boot, etc.)

  const sandbox = {
    document, localStorage, console, setTimeout, clearTimeout, Response, FormData, URL, Date, Math, JSON,
    navigator: { userAgent: "node-test" },
    location: { reload() { calls.reloads += 1; } },
    matchMedia: () => ({ matches: false }),
    fetch: (p, opts) => {
      calls.fetches.push({ path: p, method: (opts && opts.method) || "GET" });
      return route ? route(p, opts || {}) : never;
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  const ctx = vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    const source = file === "app.js" && appSource !== undefined ? appSource : fs.readFileSync(path.join(FRONTEND, file), "utf8");
    vm.runInContext(source, ctx, { filename: file });
  }
  const run = (code) => vm.runInContext(code, ctx);
  return {
    ctx, calls, run, el,
    state: run("state"),
    fire(id, type, event = {}) { (el(id).listeners[type] || []).forEach((fn) => fn(event)); },
    // stop the page's own follow-up reloads (Today, goals form) from touching the fake network
    stub(...names) { names.forEach((n) => run(`${n} = async () => {}`)); },
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function settleFor(rounds = 6) { for (let i = 0; i < rounds; i++) await settle(); }

module.exports = { loadApp, json, settle, settleFor, makeElement };
