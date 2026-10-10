"""Identity: asking LiteLLM whose virtual key this is. LiteLLM is a fake."""

import asyncio

import httpx
import pytest

from app.identity import Identity, IdentityError, IdentityService, hash_key, parse_admins

LLM = "http://llm.test"


def ask(service: IdentityService, handler, key: str) -> Identity:
    """Ask once, against a fake LiteLLM (handler)."""

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await service.resolve(client, key)

    return asyncio.run(run())


def info(**values) -> httpx.Response:
    return httpx.Response(200, json={"key": "sk-...", "info": {"key_alias": "amy", "status": "active", "blocked": None, **values}})


def test_the_key_hash_is_the_same_one_litellm_shows():
    # Checked once against a real LiteLLM with this made-up key: the Key Hash in its error message started with this.
    assert hash_key("sk-not-a-real-key-for-testing").startswith("81b543754408f9")


def test_a_valid_key_gives_its_alias_and_hash():
    seen = []

    def litellm(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return info(key_alias="amy")

    identity = ask(IdentityService(LLM), litellm, "sk-amy")

    assert identity == Identity(key_hash=hash_key("sk-amy"), alias="amy")
    assert identity.short_id == hash_key("sk-amy")[:12]
    # The request goes to /key/info without parameters, the key in a header (not in the URL, where access logs would record it).
    (request,) = seen
    assert str(request.url) == f"{LLM}/key/info"
    assert request.headers["authorization"] == "Bearer sk-amy"


def test_the_answer_is_remembered_for_a_while():
    calls = []

    def litellm(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return info()

    service = IdentityService(LLM)
    ask(service, litellm, "sk-amy")
    ask(service, litellm, "sk-amy")
    ask(service, litellm, "sk-ben")
    assert len(calls) == 2  # the same key is not asked about twice


def test_an_unknown_key_is_rejected_and_not_remembered():
    def litellm(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "Authentication Error", "type": "token_not_found_in_db", "code": "401"}})

    service = IdentityService(LLM)
    for _ in range(2):
        with pytest.raises(IdentityError) as error:
            ask(service, litellm, "sk-wrong")
        assert error.value.status_code == 401
        assert "rejected" in error.value.message


def test_a_missing_key_never_reaches_litellm():
    def litellm(request: httpx.Request) -> httpx.Response:
        raise AssertionError("LiteLLM must not be asked without a key")

    with pytest.raises(IdentityError) as error:
        ask(IdentityService(LLM), litellm, "   ")
    assert error.value.status_code == 401 and "missing API key" in error.value.message


def test_blocked_and_expired_keys_are_refused():
    with pytest.raises(IdentityError) as error:
        ask(IdentityService(LLM), lambda request: info(blocked=True), "sk-amy")
    assert error.value.status_code == 403

    with pytest.raises(IdentityError) as error:
        ask(IdentityService(LLM), lambda request: info(status="expired"), "sk-amy")
    assert error.value.status_code == 401 and "expired" in error.value.message


def test_litellm_problems_are_not_blamed_on_the_key():
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    for handler in (down, lambda request: httpx.Response(500, text="boom"), lambda request: httpx.Response(200, text="not json")):
        with pytest.raises(IdentityError) as error:
            ask(IdentityService(LLM), handler, "sk-amy")
        assert error.value.status_code == 502


def test_a_key_without_an_alias_still_gets_a_name():
    identity = ask(IdentityService(LLM), lambda request: info(key_alias=None), "sk-amy")
    assert identity.alias == f"key-{hash_key('sk-amy')[:8]}"


def test_the_info_is_found_even_if_it_is_not_nested():
    # The docs put the details under "info". A version that puts them at the top level must work too.
    flat = lambda request: httpx.Response(200, json={"key_alias": "amy", "status": "active"})  # noqa: E731
    assert ask(IdentityService(LLM), flat, "sk-amy").alias == "amy"


# ---------- The normal path: the backend asks with its own admin key ----------
#
# The fake LiteLLM below follows the v1.103.3 source (info_key_fn in
# management_endpoints/key_management_endpoints.py): an admin can look up any key by hash;
# an unknown key gives 404; the reply is {"key": ..., "info": {...}} with a computed status.

MASTER = "sk-master"


def litellm_for_admin(known: dict[str, dict]):
    """known maps key -> its details in LiteLLM. Only the admin key may look things up."""
    by_hash = {hash_key(key): row for key, row in known.items()}
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.headers["authorization"] != f"Bearer {MASTER}":
            return httpx.Response(403, json={"detail": "Virtual key is not allowed to call this route."})
        row = by_hash.get(request.url.params.get("key"))
        if row is None:
            return httpx.Response(404, json={"error": {"message": "Key not found in database", "type": "not_found_error", "code": "404"}})
        return httpx.Response(200, json={"key": request.url.params["key"], "info": {"status": "active", "blocked": None, **row}})

    return handler, seen


def test_with_a_server_key_the_lookup_is_by_hash():
    handler, seen = litellm_for_admin({"sk-amy": {"key_alias": "amy"}})
    identity = ask(IdentityService(LLM, admin_key=MASTER), handler, "sk-amy")

    assert identity == Identity(key_hash=hash_key("sk-amy"), alias="amy")
    (request,) = seen
    # The backend's own key is used; the caller's key appears only as a hash.
    assert request.headers["authorization"] == f"Bearer {MASTER}"
    assert request.url.params["key"] == hash_key("sk-amy")
    assert "sk-amy" not in str(request.url)


def test_with_a_server_key_an_unknown_key_is_rejected():
    handler, _ = litellm_for_admin({"sk-amy": {"key_alias": "amy"}})
    with pytest.raises(IdentityError) as error:
        ask(IdentityService(LLM, admin_key=MASTER), handler, "sk-someone-else")
    assert error.value.status_code == 401 and "rejected" in error.value.message


def test_with_a_server_key_revoked_expired_and_deleted_keys_are_refused():
    # An admin lookup by hash also returns disabled, expired and deleted keys, so the status must be checked here.
    for status, code in (("revoked", 401), ("expired", 401), ("deleted", 401)):
        handler, _ = litellm_for_admin({"sk-amy": {"key_alias": "amy", "status": status}})
        with pytest.raises(IdentityError) as error:
            ask(IdentityService(LLM, admin_key=MASTER), handler, "sk-amy")
        assert error.value.status_code == code and status in error.value.message

    handler, _ = litellm_for_admin({"sk-amy": {"key_alias": "amy", "blocked": True}})
    with pytest.raises(IdentityError) as error:
        ask(IdentityService(LLM, admin_key=MASTER), handler, "sk-amy")
    assert error.value.status_code == 403


def test_a_refused_server_key_is_reported_as_a_server_problem():
    handler, _ = litellm_for_admin({"sk-amy": {"key_alias": "amy"}})
    with pytest.raises(IdentityError) as error:
        ask(IdentityService(LLM, admin_key="sk-not-the-master"), handler, "sk-amy")
    assert error.value.status_code == 502
    assert "LITELLM_ADMIN_KEY" in error.value.message and "not a problem with your key" in error.value.message


def test_without_a_server_key_a_model_only_key_cannot_identify_itself():
    # Seen on a deployment: a user's key may only call models, and LiteLLM answers 403 when it asks /key/info about itself.
    refused = lambda request: httpx.Response(403, json={"detail": "Virtual key is not allowed to call this route. Only allowed to call routes: ['llm_api_routes']. Tried to call route: /key/info"})  # noqa: E731
    with pytest.raises(IdentityError) as error:
        ask(IdentityService(LLM), refused, "sk-amy")
    assert error.value.status_code == 503
    assert "LITELLM_ADMIN_KEY" in error.value.message


def test_admins_come_from_the_setting_by_alias_or_by_hash():
    assert parse_admins(" root , ops lead\nroot,, ") == ("root", "ops lead")

    amy = Identity(key_hash=hash_key("sk-amy"), alias="amy")
    assert IdentityService(LLM, "root, amy").is_admin(amy)
    assert not IdentityService(LLM, "root").is_admin(amy)
    assert not IdentityService(LLM, "").is_admin(amy)
    # For a key without an alias, the start of the hash shown on the sign-in page can go in the admin list.
    assert IdentityService(LLM, hash_key("sk-amy")[:12]).is_admin(amy)
    assert not IdentityService(LLM, hash_key("sk-amy")[:4]).is_admin(amy)  # too short to count, so it cannot match by chance
