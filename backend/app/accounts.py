"""Name-and-password sign-in for the glossary admin page.

A virtual key is long and impossible to remember. After the first sign-in with a key,
the user picks a sign-in name and a password and uses those from then on.

The key stays the root of the identity:
  - the account hangs off the key's hash (the key itself is not stored), and so does the role
  - every password sign-in and every request with a session token re-checks the key with
    LiteLLM. Disabling a key in LiteLLM also ends that person's password sign-in
  - forgot the password: sign in with the key once more and set a new one

Only the parts that do not touch the database live here: hashing passwords, creating
session tokens, throttling wrong guesses. Tables are in store.py, endpoints in glossary_api.py.
"""

import base64
import functools
import hashlib
import hmac
import secrets
import time
import unicodedata

# Prefix of a session token; it tells tokens apart from virtual keys (sk-...).
SESSION_PREFIX = "lfs_"
# How long one password sign-in lasts.
SESSION_DAYS = 30
SESSION_SECONDS = SESSION_DAYS * 24 * 3600

MIN_LOGIN = 3
MAX_LOGIN = 60
MIN_PASSWORD = 8
MAX_PASSWORD = 200

# Passwords are hashed with scrypt (in the standard library). It is deliberately slow and
# memory-hungry, so a stolen database is hard to brute-force. These parameters cost about
# 50 ms and 16 MB per hash. They are stored with the hash, so raising them later keeps old
# passwords valid.
SCRYPT_N_LOG2 = 14
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16
HASH_BYTES = 32


def login_key(name: str) -> str:
    """The form of a sign-in name used for comparison: case-insensitive, width-insensitive, extra spaces removed."""
    return unicodedata.normalize("NFKC", " ".join(str(name or "").split())).casefold()


def clean_login(name: str) -> str:
    """The form of a sign-in name that is displayed: whitespace tidied only."""
    return " ".join(str(name or "").split())


def login_problems(name: str) -> list[str]:
    if len(name) < MIN_LOGIN:
        return [f"The sign-in name needs at least {MIN_LOGIN} characters."]
    if len(name) > MAX_LOGIN:
        return [f"The sign-in name is too long (the limit is {MAX_LOGIN} characters)."]
    if name.startswith(("sk-", SESSION_PREFIX)):
        # Catch a key pasted into the name field before it is stored and shown as a name.
        return ["The sign-in name looks like an API key. Choose a name, for example your own."]
    return []


def password_problems(password: str, login: str, key: str = "") -> list[str]:
    """Whether the password is acceptable. Length only, no character-class rules: length helps more."""
    if len(password) < MIN_PASSWORD:
        return [f"The password needs at least {MIN_PASSWORD} characters."]
    if len(password) > MAX_PASSWORD:
        return [f"The password is too long (the limit is {MAX_PASSWORD} characters)."]
    if login_key(password) == login_key(login):
        return ["The password must not be the same as the sign-in name."]
    if key and password == key:
        # A key can spend money; a password only manages the glossary. Sharing one string would
        # turn a leaked password into a leaked key.
        return ["Do not use your API key as the password. Choose something you can remember."]
    return []


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _scrypt(password: str, salt: bytes, n_log2: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**n_log2, r=r, p=p, dklen=HASH_BYTES, maxmem=2**27)


def hash_password(password: str) -> str:
    """The string stored in the database: algorithm, parameters, salt and hash, separated by $.

    The salt is random per person, so two people with the same password get different hashes.
    """
    salt = secrets.token_bytes(SALT_BYTES)
    digest = _scrypt(password, salt, SCRYPT_N_LOG2, SCRYPT_R, SCRYPT_P)
    return f"scrypt${SCRYPT_N_LOG2}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    """Whether the password matches. An unreadable stored value counts as no match."""
    if len(password) > MAX_PASSWORD:
        return False
    try:
        algorithm, n_log2, r, p, salt, digest = stored.split("$")
        if algorithm != "scrypt" or not 10 <= int(n_log2) <= 16:
            return False
        expected = base64.b64decode(digest)
        actual = _scrypt(password, base64.b64decode(salt), int(n_log2), int(r), int(p))
    except (ValueError, TypeError):
        return False
    # compare_digest takes the same time wherever the first difference is, so timing leaks nothing.
    return hmac.compare_digest(actual, expected)


# scrypt comes from the OpenSSL that Python was built with. If an environment lacks it,
# only password sign-in should be unavailable; the backend must still start (rule checks
# and AI rewriting do not need it). So only test for it here; do not hash at import time.
PASSWORDS_AVAILABLE = hasattr(hashlib, "scrypt")


@functools.cache
def _dummy_hash() -> str:
    return hash_password(secrets.token_urlsafe(16))


def check_password(password: str, stored: str | None) -> bool:
    if stored is None:
        # Unknown name: still hash against a dummy before answering no. Otherwise unknown names
        # answer faster, and timing would reveal which names exist.
        verify_password(password, _dummy_hash())
        return False
    return verify_password(password, stored)


def new_session_token() -> str:
    """A new session token: a long random string the browser presents instead of the password."""
    return SESSION_PREFIX + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """Only the token's hash is stored. The token is long and random, so plain SHA-256 is enough."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class LoginThrottle:
    """Stop further attempts for a name after too many wrong passwords in a row.

    Kept in memory, so a restart clears it. Only the password path is blocked: the person
    can still sign in with the key.
    """

    MAX_FAILURES = 5
    WINDOW_SECONDS = 15 * 60
    MAX_TRACKED = 5000  # cap on tracked names, so made-up names cannot exhaust memory

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._failures: dict[str, tuple[int, float]] = {}  # name -> (failures, time of the first one)

    def wait_seconds(self, name: str) -> int:
        """Seconds until this name may try again; 0 if it may try now."""
        count, since = self._failures.get(name, (0, 0.0))
        left = since + self.WINDOW_SECONDS - self._clock()
        if left <= 0:
            self._failures.pop(name, None)
            return 0
        return int(left) + 1 if count >= self.MAX_FAILURES else 0

    def failed(self, name: str) -> None:
        now = self._clock()
        count, since = self._failures.get(name, (0, now))
        if now - since >= self.WINDOW_SECONDS:
            count, since = 0, now
        if name not in self._failures and len(self._failures) >= self.MAX_TRACKED:
            self._failures.clear()
        self._failures[name] = (count + 1, since)

    def succeeded(self, name: str) -> None:
        self._failures.pop(name, None)
