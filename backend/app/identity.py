"""Identity: ask LiteLLM whose virtual key this is and whether it is still valid.

Managing the glossary needs to know who is acting. There is no separate account system
underneath: everyone already has a virtual key, so its hash is looked up with LiteLLM's
GET /key/info.

  A person is identified by the SHA-256 of the key. It only changes when the key changes.
  The display name is the key alias the admin gave it in LiteLLM.

The lookup uses the backend's own admin key (LITELLM_ADMIN_KEY), not the caller's key.
See _ask_as_admin for why.

The caller's key is never stored and never logged.
"""

import hashlib
import time
from dataclasses import dataclass

import httpx
from fastapi.security import HTTPBearer

# auto_error=False: we return our own, clearer message when the key is missing.
# Declaring the scheme also gives /docs an Authorize button.
bearer = HTTPBearer(auto_error=False, description="Your LiteLLM virtual key (sk-...)")

# Do not ask LiteLLM again for this long. The price: a disabled key keeps working
# here for up to this many seconds.
CACHE_SECONDS = 300
# Above this many cached keys the cache is cleared, so memory cannot grow without bound.
MAX_CACHED = 2000
TIMEOUT_SECONDS = 10


@dataclass(frozen=True)
class Identity:
    key_hash: str  # SHA-256 of the virtual key
    alias: str  # display name

    @property
    def short_id(self) -> str:
        """First 12 characters of the hash: enough to tell people apart on a page."""
        return self.key_hash[:12]


class IdentityError(Exception):
    """The caller could not be identified. status_code is the HTTP status to return."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def hash_key(key: str) -> str:
    """Same hash LiteLLM computes, so it equals the Key Hash shown in the LiteLLM admin UI."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def parse_admins(raw: str | None) -> tuple[str, ...]:
    """The admin list from GLOSSARY_ADMINS, separated by commas or line breaks."""
    names = []
    for piece in (raw or "").replace("\n", ",").split(","):
        name = " ".join(piece.split())
        if name and name not in names:
            names.append(name)
    return tuple(names)


REJECTED = "the API key was rejected: it may be mistyped, expired or disabled"


class IdentityService:
    def __init__(self, litellm_url: str, admins: str | None = "", admin_key: str | None = ""):
        self.litellm_url = litellm_url.rstrip("/")
        # The initial admins. Later grants are made on the admin page and stored in the database.
        self.admins = parse_admins(admins)
        self.admin_key = (admin_key or "").strip()
        self._cache: dict[str, tuple[float, Identity]] = {}

    def is_admin(self, identity: Identity) -> bool:
        """Whether this person is one of the admins named in the environment.

        An entry is a key alias, or the first characters (at least 8) of a key hash. The second
        form is for keys without an alias: the sign-in page shows the start of your own hash.
        """
        for name in self.admins:
            if name == identity.alias:
                return True
            if len(name) >= 8 and identity.key_hash.startswith(name.lower()):
                return True
        return False

    @property
    def can_look_up_by_hash(self) -> bool:
        """Whether a key can be looked up by hash alone. Needs the admin key; password sign-in depends on it."""
        return bool(self.admin_key)

    async def resolve(self, client: httpx.AsyncClient, key: str) -> Identity:
        """Ask LiteLLM whose key this is. Raises IdentityError if it is invalid, blocked or expired."""
        key = (key or "").strip()
        if not key:
            raise IdentityError(401, "missing API key: send your LiteLLM virtual key in the Authorization header as Bearer sk-...")
        return await self._resolve(client, hash_key(key), key)

    async def resolve_hash(self, client: httpx.AsyncClient, key_hash: str) -> Identity:
        """Check a key when only its hash is known (password sign-in: the backend does not hold the key).

        The hash must be one the backend stored itself (accounts or sessions table), never one
        taken from a request.
        """
        if not self.admin_key:
            raise IdentityError(503, "signing in with a password is not available: the server needs LITELLM_ADMIN_KEY to check keys. Sign in with your API key instead.")
        return await self._resolve(client, key_hash, "")

    async def _resolve(self, client: httpx.AsyncClient, key_hash: str, key: str) -> Identity:
        cached = self._cache.get(key_hash)
        if cached and cached[0] > time.monotonic():
            return cached[1]

        response = await (self._ask_as_admin(client, key_hash) if self.admin_key else self._ask_with_own_key(client, key))

        try:
            payload = response.json()
        except ValueError as exc:
            raise IdentityError(502, "unexpected response from LiteLLM while checking the API key") from exc
        # The key's details are documented under "info"; also accept them at the top level.
        info = payload.get("info") if isinstance(payload, dict) and isinstance(payload.get("info"), dict) else payload
        if not isinstance(info, dict):
            raise IdentityError(502, "unexpected response from LiteLLM while checking the API key")

        if info.get("blocked") is True:
            raise IdentityError(403, "this API key is blocked")
        if info.get("status") in ("expired", "revoked", "deleted"):
            raise IdentityError(401, f"this API key is {info['status']}")

        # A key without an alias is named after the start of its hash.
        alias = " ".join(str(info.get("key_alias") or "").split())[:80] or f"key-{key_hash[:8]}"
        identity = Identity(key_hash=key_hash, alias=alias)

        if len(self._cache) >= MAX_CACHED:
            self._cache.clear()
        self._cache[key_hash] = (time.monotonic() + CACHE_SECONDS, identity)
        return identity

    async def _get(self, client: httpx.AsyncClient, authorization: str, params: dict | None = None) -> httpx.Response:
        """One request to LiteLLM's /key/info. Unreachable or 5xx means "cannot check", not "bad key"."""
        try:
            response = await client.get(
                f"{self.litellm_url}/key/info",
                params=params,
                headers={"Authorization": f"Bearer {authorization}"},
                timeout=TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as exc:
            raise IdentityError(502, f"cannot reach LiteLLM to check the API key: {exc.__class__.__name__}") from exc
        if response.status_code >= 500:
            raise IdentityError(502, f"LiteLLM returned HTTP {response.status_code} while checking the API key")
        return response

    async def _ask_as_admin(self, client: httpx.AsyncClient, key_hash: str) -> httpx.Response:
        """The normal path: look the caller's key up by hash with the backend's own admin key.

        Why: keys handed to users are of the "may only call models" type (key_type llm_api).
        LiteLLM does not let such a key call /key/info, so it cannot look itself up (403). That
        restriction is right and should not be loosened just to identify people.

        Confirmed in the LiteLLM v1.103.3 source:
          - the key parameter of /key/info accepts a hash, so the real key never appears in a
            URL or an access log
          - a proxy_admin caller may look up any key
          - an unknown key gives 404
        """
        response = await self._get(client, self.admin_key, {"key": key_hash})
        if response.status_code == 404:
            raise IdentityError(401, REJECTED)
        if response.status_code >= 400:
            # Not the caller's fault: the backend's own key is wrong or lacks permission. Say so.
            raise IdentityError(
                502,
                f"the server could not check your API key: LiteLLM refused the server's own key (LITELLM_ADMIN_KEY) with HTTP {response.status_code}. This is a server setting, not a problem with your key.",
            )
        return response

    async def _ask_with_own_key(self, client: httpx.AsyncClient, key: str) -> httpx.Response:
        """Fallback when no admin key is configured: the caller's key looks itself up.

        Works only for default-type keys. A "may only call models" key gets 403 from LiteLLM.
        """
        response = await self._get(client, key)
        if response.status_code == 403:
            raise IdentityError(
                503,
                "this API key may only call the model, so it cannot be looked up with itself. The server needs LITELLM_ADMIN_KEY to check keys. This is a server setting, not a problem with your key.",
            )
        if response.status_code >= 400:
            # Observed: LiteLLM answers 401 for an unknown key.
            raise IdentityError(401, REJECTED)
        return response
