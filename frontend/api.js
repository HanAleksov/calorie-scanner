// Network layer for the page. Everything that talks to /api goes through here so the rules live in one
// place and can be tested without a browser (see tests/js):
//
//   * The session is an HttpOnly cookie (JS can't read it); the page only holds the CSRF token that
//     GET/POST /api/session hands back, and sends it on every state-changing request.
//   * `request()` never throws and NEVER retries. A write whose outcome is unknown (network dropped
//     after the request left) is reported as such — repeating it automatically could double-log a meal.
//   * A 401 / stale-CSRF answer calls `onUnauthorized` once, so the page can show the sign-in screen
//     without discarding what the user was typing.
//   * `guard()` makes a button single-flight: while its request is pending, further clicks are ignored.
(function (root) {
  "use strict";

  const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

  function parseError(status, body) {
    const d = body && body.detail;
    if (typeof d === "string") return { code: "error", message: d };
    if (Array.isArray(d)) return { code: "invalid", message: (d[0] && d[0].msg) || "invalid request" };
    if (d && typeof d === "object") return { ...d };
    return { code: "error", message: "" };
  }

  function createApi({ fetchImpl, onUnauthorized } = {}) {
    let csrf = null;
    const doFetch = (path, opts) => (fetchImpl || ((p, o) => root.fetch(p, o)))(path, opts);
    let notified = false;

    function build(method, headers, json, form) {
      const opts = { method, headers: { ...(headers || {}) }, credentials: "same-origin" };
      if (json !== undefined) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(json);
      } else if (form !== undefined) {
        opts.body = form;
      }
      if (UNSAFE.has(method) && csrf) opts.headers["X-CSRF-Token"] = csrf;
      return opts;
    }

    function maybeNotify(path, status, error) {
      const signInAttempt = path === "/api/session" && status === 401;     // wrong PIN is not "expired"
      const lost = (status === 401 && !signInAttempt) || (status === 403 && error.code === "csrf");
      if (lost && !notified) {
        notified = true;
        if (onUnauthorized) onUnauthorized({ status, code: error.code });
      }
    }

    // Result style: { ok, status, data, error, network }. For writes.
    async function request(path, { method = "GET", json, form, headers, quiet } = {}) {
      method = method.toUpperCase();
      let res;
      try {
        res = await doFetch(path, build(method, headers, json, form));
      } catch (e) {
        return { ok: false, status: 0, network: true, error: { code: "network", message: String(e && e.message || e) } };
      }
      let body = null;
      try { body = await res.json(); } catch (e) { /* empty or non-JSON body */ }
      if (res.ok) return { ok: true, status: res.status, data: body };
      const error = parseError(res.status, body);
      if (!quiet) maybeNotify(path, res.status, error);
      return { ok: false, status: res.status, error, retryAfter: res.headers && res.headers.get && res.headers.get("Retry-After") };
    }

    // Response style, for read calls that already use `res.ok` / `res.json()`.
    async function raw(path, { method = "GET", json, form, headers, quiet } = {}) {
      method = method.toUpperCase();
      const res = await doFetch(path, build(method, headers, json, form));
      if (!quiet && (res.status === 401 || res.status === 403)) {
        let error = { code: "error" };
        try { error = parseError(res.status, await res.clone().json()); } catch (e) { /* ignore */ }
        maybeNotify(path, res.status, error);
      }
      return res;
    }

    return {
      request, raw,
      setCsrf(token) { csrf = token || null; notified = false; },
      hasCsrf() { return !!csrf; },
      rearm() { notified = false; },
    };
  }

  // Single-flight: while `fn` is pending, further calls with the same key do nothing and return undefined.
  function createGuard() {
    const busy = new Set();
    return async function guard(key, fn) {
      if (busy.has(key)) return undefined;
      busy.add(key);
      try { return await fn(); } finally { busy.delete(key); }
    };
  }

  // Turns a failed result into one user-facing sentence. `tr(key, vars)` is the app's t(); `label(field)`
  // returns a human field name.
  function describeError(result, tr, label) {
    label = label || ((f) => f);
    const e = result.error || {};
    if (result.network) return tr("err_network_unclear");
    if (result.status === 401 || (result.status === 403 && e.code === "csrf")) return tr("err_session_expired");
    if (result.status === 429 || e.code === "locked") {
      return tr("err_locked", { minutes: Math.max(1, Math.ceil((e.retry_after || Number(result.retryAfter) || 900) / 60)) });
    }
    if (result.status === 422 && e.field) {
      const field = label(e.field);
      if (e.code === "out_of_range") return tr("err_out_of_range", { field, min: e.min, max: e.max });
      if (e.code === "required") return tr("err_required", { field });
      if (e.code === "too_long") return tr("err_too_long", { field, max: e.max });
      if (e.code === "inconsistent") return tr("err_inconsistent", { field });
      if (e.code === "in_future") return tr("err_time_future");
      if (e.code === "invalid_time") return tr("err_invalid_time", { field });
      if (e.code === "duplicate") return tr("err_duplicate_time");
      if (e.code === "too_many") return tr("err_too_many");
      return tr("err_invalid_number", { field });
    }
    return typeof e.message === "string" && e.message ? e.message : tr("something_wrong");
  }

  const api = { createApi, createGuard, describeError, parseError };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CSApi = api;
})(typeof window !== "undefined" ? window : globalThis);
