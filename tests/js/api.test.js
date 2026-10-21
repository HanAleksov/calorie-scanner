// Run: node --test tests/js     (Node 18+, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApi, createGuard, describeError } = require("../../frontend/api.js");

const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(headers || {}) } });

function fakeFetch(...responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (path, opts) => {
    calls.push({ path, opts });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next.clone ? next.clone() : next;
  };
  fn.calls = calls;
  return fn;
}

test("CSRF token is sent on state-changing requests only, and cookies are same-origin", async () => {
  const f = fakeFetch(json(200, { ok: true }));
  const api = createApi({ fetchImpl: f });
  api.setCsrf("tok123");
  await api.request("/api/today");
  await api.request("/api/water", { method: "POST", json: { ml: 250 } });
  await api.request("/api/goals", { method: "put", json: {} });
  await api.request("/api/today", { method: "DELETE" });
  const [get, post, put, del] = f.calls.map((c) => c.opts);
  assert.equal(get.headers["X-CSRF-Token"], undefined);
  for (const o of [post, put, del]) assert.equal(o.headers["X-CSRF-Token"], "tok123");
  for (const o of f.calls.map((c) => c.opts)) assert.equal(o.credentials, "same-origin");
  assert.equal(post.headers["Content-Type"], "application/json");
  assert.equal(post.body, JSON.stringify({ ml: 250 }));
});

test("no CSRF header before sign-in, and none is invented after it is cleared", async () => {
  const f = fakeFetch(json(200, {}));
  const api = createApi({ fetchImpl: f });
  await api.request("/api/session", { method: "POST", json: { user_id: 1 } });
  api.setCsrf("t");
  api.setCsrf(null);
  await api.request("/api/water", { method: "POST", json: { ml: 1 } });
  assert.equal(f.calls[0].opts.headers["X-CSRF-Token"], undefined);
  assert.equal(f.calls[1].opts.headers["X-CSRF-Token"], undefined);
});

test("multipart bodies are passed through untouched (no JSON content type)", async () => {
  const f = fakeFetch(json(200, {}));
  const api = createApi({ fetchImpl: f });
  api.setCsrf("t");
  const form = new FormData();
  form.append("description", "oats");
  await api.request("/api/log-manual", { method: "POST", form });
  assert.equal(f.calls[0].opts.body, form);
  assert.equal(f.calls[0].opts.headers["Content-Type"], undefined);
});

test("401 notifies once; a wrong PIN at sign-in is not 'session expired'", async () => {
  let notified = 0;
  const f = fakeFetch(json(401, { detail: { code: "unauthenticated" } }));
  const api = createApi({ fetchImpl: f, onUnauthorized: () => notified++ });
  await api.request("/api/today");
  await api.request("/api/goals");
  assert.equal(notified, 1, "a burst of 401s must open the sign-in screen once");
  api.setCsrf("again");                       // signed in again -> a later expiry notifies again
  await api.request("/api/today");
  assert.equal(notified, 2);

  const g = fakeFetch(json(401, { detail: { code: "wrong_pin", attempts_left: 3 } }));
  let n2 = 0;
  const api2 = createApi({ fetchImpl: g, onUnauthorized: () => n2++ });
  const r = await api2.request("/api/session", { method: "POST", json: { user_id: 1, pin: "0" } });
  assert.equal(n2, 0);
  assert.equal(r.error.attempts_left, 3);
});

test("a stale CSRF token (403 csrf) is treated like a lost session; other 403s are not", async () => {
  let n = 0;
  const api = createApi({ fetchImpl: fakeFetch(json(403, { detail: { code: "csrf" } })), onUnauthorized: () => n++ });
  await api.request("/api/water", { method: "POST", json: { ml: 1 } });
  assert.equal(n, 1);
  let m = 0;
  const api2 = createApi({ fetchImpl: fakeFetch(json(403, { detail: { code: "cross_origin" } })), onUnauthorized: () => m++ });
  await api2.request("/api/water", { method: "POST", json: { ml: 1 } });
  assert.equal(m, 0);
});

test("quiet requests (boot-time session probe) don't raise the sign-in alarm", async () => {
  let n = 0;
  const api = createApi({ fetchImpl: fakeFetch(json(401, { detail: "x" })), onUnauthorized: () => n++ });
  await api.raw("/api/session", { quiet: true });
  await api.request("/api/session", { quiet: true });
  assert.equal(n, 0);
});

test("a dropped connection is reported as 'unclear' and is NOT retried", async () => {
  const f = fakeFetch(new TypeError("Failed to fetch"));
  const api = createApi({ fetchImpl: f });
  api.setCsrf("t");
  const r = await api.request("/api/log-manual", { method: "POST", json: { total_calories: 300 } });
  assert.deepEqual([r.ok, r.network, r.status], [false, true, 0]);
  assert.equal(f.calls.length, 1, "an unknown-outcome write must never be repeated automatically");
});

test("server errors are not retried either, and the body is parsed", async () => {
  const f = fakeFetch(json(500, { detail: "boom" }));
  const api = createApi({ fetchImpl: f });
  const r = await api.request("/api/water", { method: "POST", json: { ml: 1 } });
  assert.equal(f.calls.length, 1);
  assert.equal(r.status, 500);
  assert.equal(r.error.message, "boom");
});

test("422 detail objects keep field/code/range; FastAPI list details degrade gracefully", async () => {
  const api = createApi({ fetchImpl: fakeFetch(json(422, { detail: { code: "out_of_range", field: "height_cm", min: 100, max: 250 } })) });
  const r = await api.request("/api/profile", { method: "PUT", json: {} });
  assert.deepEqual([r.error.code, r.error.field, r.error.min, r.error.max], ["out_of_range", "height_cm", 100, 250]);
  const api2 = createApi({ fetchImpl: fakeFetch(json(422, { detail: [{ msg: "field required" }] })) });
  assert.equal((await api2.request("/api/x", { method: "POST", json: {} })).error.message, "field required");
});

test("guard: a second click while the first request is pending is ignored (held request)", async () => {
  const guard = createGuard();
  let release;
  const held = new Promise((r) => (release = r));
  let started = 0;
  const first = guard("save", async () => { started++; await held; return "saved"; });
  const second = await guard("save", async () => { started++; return "again"; });
  const third = await guard("save", async () => { started++; return "again"; });
  assert.equal(second, undefined);
  assert.equal(third, undefined);
  assert.equal(started, 1);
  release();
  assert.equal(await first, "saved");
  assert.equal(await guard("save", async () => { started++; return "later"; }), "later");   // free again afterwards
  assert.equal(started, 2);
});

test("guard: different keys don't block each other, and a throwing handler releases the lock", async () => {
  const guard = createGuard();
  let release;
  const held = new Promise((r) => (release = r));
  const a = guard("a", () => held);
  assert.equal(await guard("b", async () => "b-ran"), "b-ran");
  release();
  await a;
  await assert.rejects(guard("c", async () => { throw new Error("x"); }));
  assert.equal(await guard("c", async () => "ok"), "ok");
});

test("double click through a real request: one fetch, held until the response arrives", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = fakeFetch(() => gate.then(() => json(200, { id: 1 })));
  const api = createApi({ fetchImpl: f });
  api.setCsrf("t");
  const guard = createGuard();
  const click = () => guard("manual-save", () => api.request("/api/log-manual", { method: "POST", json: { total_calories: 300 } }));
  const p1 = click();
  const p2 = click();
  assert.equal(await p2, undefined);
  assert.equal(f.calls.length, 1);
  release();
  assert.equal((await p1).ok, true);
  assert.equal(f.calls.length, 1);
});

test("describeError picks a localized message per failure kind", () => {
  const tr = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ""}`;
  const label = (f) => `<${f}>`;
  assert.equal(describeError({ network: true, status: 0, error: {} }, tr, label), "err_network_unclear");
  assert.equal(describeError({ status: 401, error: { code: "unauthenticated" } }, tr, label), "err_session_expired");
  assert.equal(describeError({ status: 403, error: { code: "csrf" } }, tr, label), "err_session_expired");
  assert.equal(describeError({ status: 422, error: { code: "out_of_range", field: "weight_kg", min: 30, max: 300 } }, tr, label),
    'err_out_of_range{"field":"<weight_kg>","min":30,"max":300}');
  assert.equal(describeError({ status: 422, error: { code: "invalid_number", field: "age" } }, tr, label), 'err_invalid_number{"field":"<age>"}');
  assert.equal(describeError({ status: 422, error: { code: "required", field: "description" } }, tr, label), 'err_required{"field":"<description>"}');
  assert.equal(describeError({ status: 429, error: { code: "locked", retry_after: 600 } }, tr, label), 'err_locked{"minutes":10}');
  assert.equal(describeError({ status: 502, error: { message: "model unavailable" } }, tr, label), "model unavailable");
  assert.equal(describeError({ status: 500, error: {} }, tr, label), "something_wrong");
});
