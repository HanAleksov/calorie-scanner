"""Server-side sessions and PIN verification.

The browser holds one opaque, random session token in an HttpOnly cookie; the server stores only its
SHA-256 (the `sessions` table), so a leaked database can't be replayed as a login. A numeric user id is
only ever used to *choose* a profile at the gate — it never proves access.

PIN storage: new/changed PINs use salted PBKDF2-SHA256. PINs saved before this existed are an unsalted
SHA-256 of "calorie-scanner:<pin>"; they keep working and are upgraded to the new format only after the
same PIN has been verified successfully (never before — we can't derive the new hash without the PIN).
A 4-digit PIN is brute-forceable offline whatever the hash is, so the real protection is the online
lockout below, not the hash.
"""

import hashlib
import hmac
import secrets
import time

SESSION_COOKIE = "cs_session"
CSRF_HEADER = "X-CSRF-Token"

SESSION_IDLE_SECONDS = 30 * 24 * 3600       # sliding: expires this long after last use
SESSION_ABSOLUTE_SECONDS = 90 * 24 * 3600   # hard cap since login, however often it's used
SESSION_TOUCH_INTERVAL_SECONDS = 600        # don't write to the DB on every request

PIN_MAX_FAILURES = 5
PIN_LOCK_SECONDS = 15 * 60

PBKDF2_ITERATIONS = 200_000
_PBKDF2_PREFIX = "pbkdf2_sha256"


def now() -> float:
    """Wall clock in epoch seconds. Indirection so tests can move time."""
    return time.time()


# ---------- PIN hashing ----------

def _legacy_hash(pin: str) -> str:
    return hashlib.sha256(f"calorie-scanner:{pin}".encode()).hexdigest()


def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", str(pin).encode(), salt, PBKDF2_ITERATIONS)
    return f"{_PBKDF2_PREFIX}${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def is_legacy_hash(stored: str) -> bool:
    return not stored.startswith(_PBKDF2_PREFIX + "$")


def check_pin_hash(stored: str, pin: str) -> bool:
    pin = str(pin)
    if is_legacy_hash(stored):
        return hmac.compare_digest(stored, _legacy_hash(pin))
    try:
        _, iterations, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt_hex), int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), digest_hex)


# ---------- tokens ----------

def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def tokens_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


# ---------- PIN attempts with lockout ----------

class LoginResult:
    OK = "ok"
    NO_USER = "no_user"
    WRONG_PIN = "wrong_pin"
    PIN_REQUIRED = "pin_required"
    LOCKED = "locked"

    def __init__(self, status: str, retry_after: int = 0, attempts_left: int | None = None):
        self.status = status
        self.retry_after = retry_after
        self.attempts_left = attempts_left


def check_pin_with_lockout(conn, user_id: int, pin) -> LoginResult:
    """Verifies a profile's PIN, counting failures. A profile with no PIN opens without one (that is the
    explicit, chosen behaviour for PIN-less profiles). While locked, even the correct PIN is refused."""
    row = conn.execute(
        "SELECT pin_hash, pin_failed_count, pin_locked_until FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if not row:
        return LoginResult(LoginResult.NO_USER)
    if row["pin_hash"] is None:
        return LoginResult(LoginResult.OK)

    t = now()
    locked_until = row["pin_locked_until"] or 0
    failed = row["pin_failed_count"] or 0
    if locked_until > t:
        return LoginResult(LoginResult.LOCKED, retry_after=int(locked_until - t) + 1)
    if locked_until:
        failed = 0  # lock has run out — start counting afresh

    if pin is None or str(pin) == "":
        return LoginResult(LoginResult.PIN_REQUIRED)

    if check_pin_hash(row["pin_hash"], pin):
        updates = ["pin_failed_count = 0", "pin_locked_until = NULL"]
        params: list = []
        if is_legacy_hash(row["pin_hash"]):
            updates.append("pin_hash = ?")
            params.append(hash_pin(pin))  # same PIN, stronger format
        conn.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", [*params, user_id])
        return LoginResult(LoginResult.OK)

    failed += 1
    if failed >= PIN_MAX_FAILURES:
        conn.execute("UPDATE users SET pin_failed_count = 0, pin_locked_until = ? WHERE id = ?",
                     (t + PIN_LOCK_SECONDS, user_id))
        return LoginResult(LoginResult.LOCKED, retry_after=PIN_LOCK_SECONDS)
    conn.execute("UPDATE users SET pin_failed_count = ?, pin_locked_until = NULL WHERE id = ?", (failed, user_id))
    return LoginResult(LoginResult.WRONG_PIN, attempts_left=PIN_MAX_FAILURES - failed)
