"""Sessions, CSRF, PIN lockout, profile switching, expiry, PIN-hash upgrade."""

import hashlib

import auth
import db
from tests.base import AppTestCase


class IdentityTests(AppTestCase):
    def test_claimed_user_id_header_is_not_authentication(self):
        pinless = self.make_user("NoPin")
        pinned = self.make_user("Pinned", pin="1234")
        c = self.new_client()
        for uid in (pinless, pinned):
            for path in ("/api/today", "/api/goals", "/api/users/me", "/api/history"):
                r = c.get(path, headers={"X-User-Id": str(uid)})
                self.assertEqual(r.status_code, 401, f"{path} accepted X-User-Id for user {uid}")

    def test_a_claimed_id_never_overrides_a_real_session(self):
        a, b = self.make_user("A"), self.make_user("B", pin="1234")
        self.add_entry(a, calories=111)
        self.add_entry(b, calories=999)
        c = self.signed_in_client(a)
        claim = {"X-User-Id": str(b)}
        self.assertEqual(c.get("/api/today", headers=claim).json()["totals"]["calories"], 111)
        self.assertEqual(c.get("/api/users/me", headers=claim).json()["id"], a)
        self.assertEqual(self.call(c, "POST", "/api/water", json={"ml": 250}, headers=claim).status_code, 200)
        self.assertEqual([r["user_id"] for r in self.rows("SELECT user_id FROM water_log")], [a])

    def test_pinless_profile_unlocks_explicitly_without_a_password(self):
        uid = self.make_user("NoPin")
        c = self.new_client()
        r = c.post("/api/session", json={"user_id": uid})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["user"]["id"], uid)
        self.assertFalse(r.json()["user"]["has_pin"])
        self.assertEqual(c.get("/api/today").status_code, 200)

    def test_pin_profile_needs_the_right_pin(self):
        uid = self.make_user("Pinned", pin="1234")
        c = self.new_client()
        r = c.post("/api/session", json={"user_id": uid})
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (401, "pin_required"))
        r = c.post("/api/session", json={"user_id": uid, "pin": "0000"})
        self.assertEqual((r.status_code, r.json()["detail"]["code"], r.json()["detail"]["attempts_left"]),
                         (401, "wrong_pin", 4))
        self.assertEqual(c.get("/api/today").status_code, 401)
        self.assertEqual(c.post("/api/session", json={"user_id": uid, "pin": "1234"}).status_code, 200)
        self.assertEqual(c.get("/api/today").status_code, 200)

    def test_unknown_or_malformed_user_id(self):
        c = self.new_client()
        self.assertEqual(c.post("/api/session", json={"user_id": 9999}).status_code, 404)
        self.assertEqual(c.post("/api/session", json={"user_id": "1"}).status_code, 422)
        self.assertEqual(c.post("/api/session", json={"user_id": True}).status_code, 422)
        self.assertEqual(c.post("/api/session", json={}).status_code, 422)

    def test_user_list_selects_profiles_but_exposes_no_secrets(self):
        self.make_user("A", pin="1234")
        body = self.new_client().get("/api/users").text
        self.assertNotIn("pin_hash", body)
        self.assertNotIn("pbkdf2", body)

    def test_api_responses_are_not_stored_by_the_browser(self):
        uid = self.make_user("A")
        c = self.signed_in_client(uid)
        self.assertEqual(c.get("/api/today").headers["cache-control"], "no-store")
        self.assertEqual(self.new_client().get("/api/today").headers["cache-control"], "no-store")  # even the 401


class PinLockoutTests(AppTestCase):
    def setUp(self):
        super().setUp()
        self.uid = self.make_user("Pinned", pin="1234")
        self.c = self.new_client()

    def wrong(self):
        return self.c.post("/api/session", json={"user_id": self.uid, "pin": "9999"})

    def test_five_wrong_pins_lock_the_profile_even_against_the_right_pin(self):
        for _ in range(4):
            self.assertEqual(self.wrong().status_code, 401)
        r = self.wrong()
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["detail"]["code"], "locked")
        self.assertIn("retry-after", r.headers)
        # correct PIN while locked is still refused
        r = self.c.post("/api/session", json={"user_id": self.uid, "pin": "1234"})
        self.assertEqual(r.status_code, 429)
        self.assertEqual(self.c.get("/api/today").status_code, 401)

    def test_lock_expires_after_fifteen_minutes(self):
        for _ in range(5):
            self.wrong()
        self.clock[0] += auth.PIN_LOCK_SECONDS - 5
        self.assertEqual(self.c.post("/api/session", json={"user_id": self.uid, "pin": "1234"}).status_code, 429)
        self.clock[0] += 10
        self.assertEqual(self.c.post("/api/session", json={"user_id": self.uid, "pin": "1234"}).status_code, 200)
        row = self.rows("SELECT pin_failed_count, pin_locked_until FROM users WHERE id=?", (self.uid,))[0]
        self.assertEqual((row["pin_failed_count"], row["pin_locked_until"]), (0, None))

    def test_after_a_lock_runs_out_counting_starts_again(self):
        for _ in range(5):
            self.wrong()
        self.clock[0] += auth.PIN_LOCK_SECONDS + 1
        r = self.wrong()
        self.assertEqual((r.status_code, r.json()["detail"]["attempts_left"]), (401, 4))

    def test_success_resets_the_failure_counter(self):
        for _ in range(3):
            self.wrong()
        self.assertEqual(self.c.post("/api/session", json={"user_id": self.uid, "pin": "1234"}).status_code, 200)
        r = self.wrong()
        self.assertEqual(r.json()["detail"]["attempts_left"], 4)

    def test_wrong_attempts_are_counted_even_though_the_request_fails(self):
        self.wrong()
        self.wrong()
        row = self.rows("SELECT pin_failed_count FROM users WHERE id=?", (self.uid,))[0]
        self.assertEqual(row["pin_failed_count"], 2)  # persisted, not rolled back with the 401

    def test_locking_one_profile_does_not_affect_another(self):
        other = self.make_user("Other", pin="4321")
        for _ in range(5):
            self.wrong()
        self.assertEqual(self.c.post("/api/session", json={"user_id": other, "pin": "4321"}).status_code, 200)

    def test_pinless_profiles_can_not_be_locked(self):
        uid = self.make_user("Open")
        for _ in range(10):
            self.assertEqual(self.c.post("/api/session", json={"user_id": uid, "pin": "0000"}).status_code, 200)

    def test_changing_the_pin_counts_wrong_old_pins_too(self):
        c = self.signed_in_client(self.uid, "1234")
        for i in range(4):
            r = self.call(c, "PUT", "/api/users/me/pin", json={"old_pin": "0000", "new_pin": "5555"})
            self.assertEqual(r.status_code, 403)
        r = self.call(c, "PUT", "/api/users/me/pin", json={"old_pin": "0000", "new_pin": "5555"})
        self.assertEqual(r.status_code, 429)
        r = self.call(c, "PUT", "/api/users/me/pin", json={"old_pin": "1234", "new_pin": "5555"})
        self.assertEqual(r.status_code, 429)  # locked: even the right old PIN is refused


class CookieAndCsrfTests(AppTestCase):
    def test_cookie_is_httponly_samesite_and_the_database_holds_only_a_hash(self):
        uid = self.make_user("A")
        c = self.new_client()
        r = c.post("/api/session", json={"user_id": uid})
        cookie = r.headers["set-cookie"]
        low = cookie.lower()
        self.assertIn("httponly", low)
        self.assertIn("samesite=strict", low)
        self.assertIn("path=/", low)
        self.assertIn("max-age=", low)
        self.assertNotIn("secure", low.replace("samesite", ""))   # plain http: no Secure flag
        token = c.cookies.get(auth.SESSION_COOKIE)
        stored = self.rows("SELECT * FROM sessions")[0]
        self.assertNotEqual(stored["token_hash"], token)
        self.assertEqual(stored["token_hash"], hashlib.sha256(token.encode()).hexdigest())

    def test_cookie_is_secure_when_the_browser_used_https_even_behind_a_proxy(self):
        uid = self.make_user("A")
        r = self.new_client().post("/api/session", json={"user_id": uid}, headers={"X-Forwarded-Proto": "https"})
        self.assertIn("secure", r.headers["set-cookie"].lower())
        r = self.new_client(base_url="https://testserver").post("/api/session", json={"user_id": uid})
        self.assertIn("secure", r.headers["set-cookie"].lower())

    def test_state_changing_requests_need_the_csrf_token(self):
        uid = self.make_user("A")
        c = self.signed_in_client(uid)
        body = {"ml": 250}
        self.assertEqual(c.post("/api/water", json=body).status_code, 403)                        # missing
        self.assertEqual(c.post("/api/water", json=body, headers={"X-CSRF-Token": "nope"}).status_code, 403)
        self.assertEqual(self.call(c, "POST", "/api/water", json=body).status_code, 200)
        self.assertEqual(c.get("/api/today").status_code, 200)                                      # reads need none
        for method, path in (("PUT", "/api/goals"), ("DELETE", "/api/today"), ("PUT", "/api/profile"),
                             ("DELETE", "/api/users/me")):
            self.assertEqual(c.request(method, path, json={}).status_code, 403, f"{method} {path} skipped CSRF")
        self.assertEqual(self.rows("SELECT COUNT(*) n FROM users")[0]["n"], 1)

    def test_csrf_token_of_another_session_is_rejected(self):
        a, b = self.make_user("A"), self.make_user("B")
        ca, cb = self.signed_in_client(a), self.signed_in_client(b)
        r = ca.post("/api/water", json={"ml": 250}, headers={"X-CSRF-Token": cb.csrf})
        self.assertEqual(r.status_code, 403)

    def test_cross_origin_requests_are_blocked_even_with_a_valid_token(self):
        uid = self.make_user("A")
        c = self.signed_in_client(uid)
        r = self.call(c, "POST", "/api/water", json={"ml": 250}, headers={"Origin": "https://evil.example"})
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (403, "cross_origin"))
        r = c.post("/api/session", json={"user_id": uid}, headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)          # sign-in can't be forged cross-site either
        r = self.call(c, "POST", "/api/water", json={"ml": 250}, headers={"Origin": "http://testserver"})
        self.assertEqual(r.status_code, 200)
        r = self.call(c, "POST", "/api/water", json={"ml": 250}, headers={"Origin": "null"})
        self.assertEqual(r.status_code, 403)

    def test_forwarded_host_is_what_the_origin_is_compared_with(self):
        uid = self.make_user("A")
        c = self.signed_in_client(uid)
        r = self.call(c, "POST", "/api/water", json={"ml": 250},
                      headers={"Origin": "https://app.example", "X-Forwarded-Host": "app.example"})
        self.assertEqual(r.status_code, 200)


class SessionLifetimeTests(AppTestCase):
    def setUp(self):
        super().setUp()
        self.uid = self.make_user("A")
        self.c = self.signed_in_client(self.uid)

    def ok(self):
        return self.c.get("/api/today").status_code == 200

    def test_idle_session_expires(self):
        self.clock[0] += auth.SESSION_IDLE_SECONDS - 60
        self.assertTrue(self.ok())
        self.clock[0] += auth.SESSION_IDLE_SECONDS + 60       # unused for longer than the idle limit
        self.assertFalse(self.ok())
        self.assertEqual(self.rows("SELECT COUNT(*) n FROM sessions")[0]["n"], 0)   # expired row removed

    def test_use_slides_the_idle_window(self):
        for _ in range(3):
            self.clock[0] += 20 * 24 * 3600
            self.assertTrue(self.ok())                        # 20, 40, 60 days in — each use renews it

    def test_absolute_lifetime_caps_a_session_that_is_always_in_use(self):
        day = 24 * 3600
        for _ in range(4):                                    # 20-day hops: 20, 40, 60, 80
            self.clock[0] += 20 * day
            self.assertTrue(self.ok())
        self.clock[0] += 11 * day                             # 91 days after sign-in, used 11 days ago
        self.assertFalse(self.ok())

    def test_expired_session_cannot_write_and_keeps_nothing(self):
        self.clock[0] += auth.SESSION_IDLE_SECONDS + 1
        r = self.call(self.c, "POST", "/api/water", json={"ml": 250})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.rows("SELECT COUNT(*) n FROM water_log")[0]["n"], 0)

    def test_expired_sessions_are_purged_on_next_sign_in(self):
        other = self.make_user("B")
        self.clock[0] += auth.SESSION_ABSOLUTE_SECONDS + 1
        self.sign_in(self.new_client(), other)
        self.assertEqual([r["user_id"] for r in self.rows("SELECT user_id FROM sessions")], [other])


class SignOutAndSwitchTests(AppTestCase):
    def test_sign_out_kills_the_session_server_side(self):
        uid = self.make_user("A")
        c = self.signed_in_client(uid)
        token = c.cookies.get(auth.SESSION_COOKIE)
        self.assertEqual(self.call(c, "DELETE", "/api/session").status_code, 200)
        self.assertEqual(c.get("/api/today").status_code, 401)
        replay = self.new_client()
        replay.cookies.set(auth.SESSION_COOKIE, token)         # someone who kept the old cookie
        self.assertEqual(replay.get("/api/today").status_code, 401)

    def test_sign_out_without_csrf_is_refused_and_without_a_session_is_a_noop(self):
        uid = self.make_user("A")
        c = self.signed_in_client(uid)
        self.assertEqual(c.delete("/api/session").status_code, 403)
        self.assertEqual(c.get("/api/today").status_code, 200)
        self.assertEqual(self.new_client().delete("/api/session").status_code, 200)

    def test_switching_profile_ends_the_old_session_and_shows_none_of_its_data(self):
        a, b = self.make_user("A"), self.make_user("B")
        self.write_image("a-photo.jpg")
        entry_a = self.add_entry(a, calories=777, image="a-photo.jpg")
        self.add_entry(b, calories=111)
        c = self.signed_in_client(a)
        old_token = c.cookies.get(auth.SESSION_COOKIE)
        self.assertEqual(c.get("/api/today").json()["totals"]["calories"], 777)
        self.assertEqual(c.get("/uploads/a-photo.jpg").status_code, 200)

        self.sign_in(c, b)                                      # same browser, now profile B
        self.assertEqual(c.get("/api/today").json()["totals"]["calories"], 111)
        self.assertEqual(c.get(f"/api/entries/{entry_a['id']}").status_code, 404)
        self.assertEqual(c.get("/uploads/a-photo.jpg").status_code, 404)
        self.assertEqual(self.rows("SELECT COUNT(*) n FROM sessions WHERE user_id=?", (a,))[0]["n"], 0)
        stale = self.new_client()
        stale.cookies.set(auth.SESSION_COOKIE, old_token)
        self.assertEqual(stale.get("/api/today").status_code, 401)
        self.assertEqual(stale.get("/uploads/a-photo.jpg").status_code, 401)

    def test_old_csrf_token_dies_with_the_old_session(self):
        a, b = self.make_user("A"), self.make_user("B")
        c = self.signed_in_client(a)
        old_csrf = c.csrf
        self.sign_in(c, b)
        r = c.post("/api/water", json={"ml": 250}, headers={"X-CSRF-Token": old_csrf})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.rows("SELECT COUNT(*) n FROM water_log")[0]["n"], 0)

    def test_session_endpoint_reports_the_current_profile(self):
        a = self.make_user("Ana", pin="1234")
        c = self.signed_in_client(a, "1234")
        body = c.get("/api/session").json()
        self.assertEqual((body["user"]["name"], body["user"]["has_pin"], body["csrf_token"]), ("Ana", True, c.csrf))
        self.assertEqual(self.new_client().get("/api/session").status_code, 401)


class PinStorageTests(AppTestCase):
    def legacy_user(self, name, pin):
        with db.get_conn() as conn:
            uid = db.create_user(conn, name, None)["id"]
            conn.execute("UPDATE users SET pin_hash=? WHERE id=?",
                         (hashlib.sha256(f"calorie-scanner:{pin}".encode()).hexdigest(), uid))
        return uid

    def pin_hash(self, uid):
        return self.rows("SELECT pin_hash FROM users WHERE id=?", (uid,))[0]["pin_hash"]

    def test_legacy_pin_still_works_and_is_upgraded_only_after_a_correct_pin(self):
        a, b = self.legacy_user("A", "1234"), self.legacy_user("B", "4321")
        before_a, before_b = self.pin_hash(a), self.pin_hash(b)
        self.assertFalse(before_a.startswith("pbkdf2"))
        c = self.new_client()
        self.assertEqual(c.post("/api/session", json={"user_id": a, "pin": "0000"}).status_code, 401)
        self.assertEqual(self.pin_hash(a), before_a)                    # wrong PIN never rewrites the hash
        self.assertEqual(c.post("/api/session", json={"user_id": a, "pin": "1234"}).status_code, 200)
        after_a = self.pin_hash(a)
        self.assertTrue(after_a.startswith("pbkdf2_sha256$"))
        self.assertEqual(self.pin_hash(b), before_b)                    # other profiles untouched
        # the same PIN keeps working against the new format; a different one doesn't
        self.assertEqual(self.new_client().post("/api/session", json={"user_id": a, "pin": "1234"}).status_code, 200)
        self.assertEqual(self.new_client().post("/api/session", json={"user_id": a, "pin": "1235"}).status_code, 401)
        self.assertEqual(self.pin_hash(a), after_a)                     # not re-hashed on every login

    def test_new_hashes_are_salted(self):
        self.assertNotEqual(auth.hash_pin("1234"), auth.hash_pin("1234"))
        self.assertTrue(auth.check_pin_hash(auth.hash_pin("1234"), "1234"))
        self.assertFalse(auth.check_pin_hash(auth.hash_pin("1234"), "1235"))
        self.assertFalse(auth.check_pin_hash("pbkdf2_sha256$garbage", "1234"))

    def test_changing_the_pin_signs_out_other_devices_but_not_this_one(self):
        uid = self.make_user("A", pin="1234")
        phone, laptop = self.signed_in_client(uid, "1234"), self.signed_in_client(uid, "1234")
        r = self.call(phone, "PUT", "/api/users/me/pin", json={"old_pin": "1234", "new_pin": "5555"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(phone.get("/api/today").status_code, 200)
        self.assertEqual(laptop.get("/api/today").status_code, 401)
        self.assertEqual(self.new_client().post("/api/session", json={"user_id": uid, "pin": "1234"}).status_code, 401)
        self.assertEqual(self.new_client().post("/api/session", json={"user_id": uid, "pin": "5555"}).status_code, 200)

    def test_a_pin_is_required_to_change_an_existing_pin(self):
        uid = self.make_user("A", pin="1234")
        c = self.signed_in_client(uid, "1234")
        r = self.call(c, "PUT", "/api/users/me/pin", json={"new_pin": "5555"})
        self.assertEqual(r.status_code, 400)

    def test_deleting_a_profile_removes_its_sessions_and_photos(self):
        uid = self.make_user("A")
        self.write_image("gone.jpg")
        self.add_entry(uid, image="gone.jpg")
        c = self.signed_in_client(uid)
        self.assertEqual(self.call(c, "DELETE", "/api/users/me").status_code, 200)
        self.assertEqual(self.rows("SELECT COUNT(*) n FROM sessions")[0]["n"], 0)
        self.assertFalse((main_uploads() / "gone.jpg").exists())
        self.assertEqual(c.get("/api/today").status_code, 401)


def main_uploads():
    import main
    return main.UPLOADS_DIR
