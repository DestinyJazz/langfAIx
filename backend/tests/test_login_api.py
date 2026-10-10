"""Name-and-password sign-in for the glossary page, from the HTTP request in to the HTTP response out.

The flow: sign in with the virtual key the first time, set a sign-in name and password,
use those afterwards. The key stays the root of the identity, so once it is disabled in
LiteLLM the password stops working too.

LiteLLM is a fake (it only identifies keys); the database is an in-memory SQLite.
"""

import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import select, update

from app.identity import hash_key
from app.store import accounts_table, sessions_table
from tests.conftest import ADMIN_KEY, FakeKeys

KEYS = {"sk-root": "root", "sk-amy": "amy", "sk-ben": "ben"}
ROOT = {"Authorization": "Bearer sk-root"}
AMY = {"Authorization": "Bearer sk-amy"}
BEN = {"Authorization": "Bearer sk-ben"}

PASSWORD = "correct horse"


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def litellm():
    return FakeKeys(dict(KEYS))


@pytest.fixture
def client(make_client, litellm, monkeypatch):
    # "Whose key is this" is normally cached for 5 minutes. Off here, so disabling a key shows at once.
    monkeypatch.setattr("app.identity.CACHE_SECONDS", 0)
    return make_client(litellm, glossary_admins="root", litellm_admin_key=ADMIN_KEY)


def set_password(client, headers, login="Amy Wong", password=PASSWORD, **extra) -> str:
    response = client.post("/glossary/password", json={"login": login, "password": password, **extra}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["token"]


def sign_in(client, login="Amy Wong", password=PASSWORD):
    return client.post("/glossary/login", json={"login": login, "password": password})


def database(client):
    return client.app.state.glossary.store.engine


# ---------- The whole flow ----------


def test_first_time_with_the_key_then_with_name_and_password(client):
    # First time: with the key. These fields tell the page to offer setting a password.
    first = client.get("/glossary/me", headers=AMY).json()
    assert (first["signed_in_with"], first["has_password"], first["login"], first["password_sign_in"]) == ("key", False, "", True)

    # Set name and password and receive a session token. From here the page no longer keeps the key.
    reply = client.post("/glossary/password", json={"login": "  Amy   Wong ", "password": PASSWORD}, headers=AMY)
    assert reply.status_code == 200
    assert reply.json()["login"] == "Amy Wong"
    token = reply.json()["token"]
    assert token.startswith("lfs_")

    now = client.get("/glossary/me", headers=bearer(token)).json()
    assert (now["alias"], now["id"]) == ("amy", hash_key("sk-amy")[:12])  # still the same person
    assert (now["signed_in_with"], now["has_password"], now["login"]) == ("password", True, "Amy Wong")

    # Later: name and password only. The name is case-insensitive.
    later = sign_in(client, "amy wong")
    assert later.status_code == 200
    assert later.json()["login"] == "Amy Wong"
    assert client.get("/glossary/terms", headers=bearer(later.json()["token"])).status_code == 200


def test_the_role_belongs_to_the_person_however_they_sign_in(client):
    token = set_password(client, AMY)
    viewer = client.post("/glossary/terms", json={"en": "WebUI"}, headers=bearer(token))
    assert viewer.status_code == 403

    client.put(f"/glossary/people/{hash_key('sk-amy')}", json={"role": "editor"}, headers=ROOT)
    added = client.post("/glossary/terms", json={"en": "WebUI"}, headers=bearer(token))
    assert added.status_code == 201
    assert added.json()["created_by"] == "amy"  # the change is recorded under this person, as with a key sign-in


def test_an_admin_from_the_setting_is_an_admin_with_a_password_too(client):
    token = set_password(client, ROOT, login="the boss")
    assert client.get("/glossary/me", headers=bearer(token)).json()["role"] == "admin"
    assert client.get("/glossary/people", headers=bearer(token)).status_code == 200


def test_the_key_still_works_after_a_password_is_set(client):
    # The browser extension keeps using the key for lookups; setting a password must not affect it.
    set_password(client, AMY)
    assert client.get("/glossary/lookup?q=x", headers=AMY).status_code == 200
    assert client.get("/glossary/me", headers=AMY).json()["has_password"] is True


# ---------- Failed sign-ins ----------


def test_a_wrong_name_and_a_wrong_password_get_the_same_answer(client):
    set_password(client, AMY)
    wrong_password = sign_in(client, password="not the password")
    wrong_name = sign_in(client, login="nobody at all")
    empty = client.post("/glossary/login", json={})
    for response in (wrong_password, wrong_name, empty):
        assert response.status_code == 401
        assert response.json()["detail"] == "wrong name or password"


def test_too_many_wrong_passwords_lock_the_name_but_not_the_key(client):
    set_password(client, AMY)
    for _ in range(5):
        assert sign_in(client, password="not the password").status_code == 401

    locked = sign_in(client)  # the right password this time, but still has to wait
    assert locked.status_code == 429
    assert "15 minutes" in locked.json()["detail"] and "API key" in locked.json()["detail"]
    # The key path is unaffected: a locked-out person can come in with the key and reset the password.
    assert client.get("/glossary/me", headers=AMY).status_code == 200
    token = set_password(client, AMY, password="another long one")
    assert client.get("/glossary/me", headers=bearer(token)).status_code == 200
    # Other people are unaffected too.
    set_password(client, BEN, login="ben")
    assert sign_in(client, "ben").status_code == 200


def test_a_made_up_or_expired_token_is_refused(client):
    token = set_password(client, AMY)
    made_up = client.get("/glossary/me", headers=bearer("lfs_this-was-never-issued"))
    assert made_up.status_code == 401
    assert "Sign in again" in made_up.json()["detail"]

    # Move the expiry into the past.
    with database(client).begin() as connection:
        connection.execute(update(sessions_table).values(expires_at=1))
    expired = client.get("/glossary/me", headers=bearer(token))
    assert expired.status_code == 401
    assert "expired" in expired.json()["detail"]


# ---------- The key stays the root ----------


def test_stopping_the_key_in_litellm_stops_the_password_too(client, litellm):
    token = set_password(client, AMY)
    assert client.get("/glossary/terms", headers=bearer(token)).status_code == 200

    del litellm.by_hash[hash_key("sk-amy")]  # the admin deleted this key in LiteLLM

    with_token = client.get("/glossary/terms", headers=bearer(token))
    assert with_token.status_code == 401
    assert "no longer valid" in with_token.json()["detail"]
    with_password = sign_in(client)
    assert with_password.status_code == 401
    assert "no longer valid" in with_password.json()["detail"]


def test_while_the_answer_is_remembered_litellm_is_not_asked_on_every_request(make_client, litellm):
    # The 5-minute cache stays on here: several requests with the token ask LiteLLM only once.
    client = make_client(litellm, glossary_admins="root", litellm_admin_key=ADMIN_KEY)
    token = set_password(client, AMY)
    litellm.requests.clear()
    for _ in range(3):
        assert client.get("/glossary/terms", headers=bearer(token)).status_code == 200
    assert len(litellm.requests) == 0  # asked when the password was set; still cached


def test_the_server_looks_the_key_up_by_its_hash(client, litellm):
    token = set_password(client, AMY)
    litellm.requests.clear()
    client.get("/glossary/me", headers=bearer(token))
    (request,) = litellm.requests
    assert request.headers["authorization"] == f"Bearer {ADMIN_KEY}"
    assert request.url.params["key"] == hash_key("sk-amy")


def test_without_the_server_key_there_is_no_password_sign_in(make_client):
    # Without LITELLM_ADMIN_KEY the backend cannot look a key up by hash, so there is no password sign-in and the page does not offer it.
    client = make_client(FakeKeys(dict(KEYS), restricted=False), glossary_admins="root")
    assert client.get("/glossary/me", headers=AMY).json()["password_sign_in"] is False
    refused = client.post("/glossary/password", json={"login": "amy", "password": PASSWORD}, headers=AMY)
    assert refused.status_code == 503
    assert "LITELLM_ADMIN_KEY" in refused.json()["detail"]


def test_without_scrypt_only_the_password_sign_in_is_off(make_client, monkeypatch):
    # Password hashing needs the OpenSSL that Python uses. Without it only password sign-in is unavailable; the rest works.
    monkeypatch.setattr("app.glossary_api.PASSWORDS_AVAILABLE", False)
    client = make_client(FakeKeys(dict(KEYS)), glossary_admins="root", litellm_admin_key=ADMIN_KEY)
    assert client.get("/healthz").status_code == 200
    assert client.get("/glossary/me", headers=AMY).json()["password_sign_in"] is False
    refused = client.post("/glossary/password", json={"login": "amy", "password": PASSWORD}, headers=AMY)
    assert refused.status_code == 503
    assert "scrypt" in refused.json()["detail"]


def test_the_backend_still_loads_where_there_is_no_scrypt():
    # Start another Python, remove scrypt, then import the backend. Hashing at import time would crash here.
    code = "import hashlib; del hashlib.scrypt; import app.main, app.accounts; print(app.accounts.PASSWORDS_AVAILABLE)"
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=Path(__file__).parent.parent, timeout=60)
    assert done.returncode == 0, done.stderr[-500:]
    assert done.stdout.strip() == "False"


# ---------- Changing the password, forgetting it, signing out ----------


def test_changing_the_password_needs_the_current_one(client):
    token = set_password(client, AMY)
    new = {"login": "Amy Wong", "password": "a brand new one"}

    missing = client.post("/glossary/password", json=new, headers=bearer(token))
    wrong = client.post("/glossary/password", json={**new, "current_password": "a guess"}, headers=bearer(token))
    assert (missing.status_code, wrong.status_code) == (403, 403)
    assert sign_in(client).status_code == 200  # the password was not changed

    changed = client.post("/glossary/password", json={**new, "current_password": PASSWORD}, headers=bearer(token))
    assert changed.status_code == 200
    assert sign_in(client).status_code == 401  # the old password no longer works
    assert sign_in(client, password="a brand new one").status_code == 200
    # The old session token is revoked as well; this response carries a new one.
    assert client.get("/glossary/me", headers=bearer(token)).status_code == 401
    assert client.get("/glossary/me", headers=bearer(changed.json()["token"])).status_code == 200


def test_guessing_the_current_password_is_limited_too(client):
    token = set_password(client, AMY)
    for _ in range(5):
        guess = client.post("/glossary/password", json={"password": "another long one", "current_password": "a guess"}, headers=bearer(token))
        assert guess.status_code == 403
    locked = client.post("/glossary/password", json={"password": "another long one", "current_password": PASSWORD}, headers=bearer(token))
    assert locked.status_code == 429


def test_forgot_the_password_sign_in_with_the_key_and_set_a_new_one(client):
    old_token = set_password(client, AMY)
    # With the key the old password is not required. An omitted name keeps the existing one.
    reply = client.post("/glossary/password", json={"password": "the second one"}, headers=AMY)
    assert reply.status_code == 200
    assert reply.json()["login"] == "Amy Wong"
    assert sign_in(client).status_code == 401
    assert sign_in(client, password="the second one").status_code == 200
    assert client.get("/glossary/me", headers=bearer(old_token)).status_code == 401


def test_the_name_defaults_to_the_key_alias(client):
    reply = client.post("/glossary/password", json={"password": PASSWORD}, headers=AMY)
    assert reply.json()["login"] == "amy"
    assert sign_in(client, "amy").status_code == 200


def test_signing_out_ends_that_one_sign_in(client):
    set_password(client, AMY)
    here = sign_in(client).json()["token"]
    elsewhere = sign_in(client).json()["token"]

    assert client.post("/glossary/logout", headers=bearer(here)).status_code == 204
    assert client.get("/glossary/me", headers=bearer(here)).status_code == 401
    assert client.get("/glossary/me", headers=bearer(elsewhere)).status_code == 200  # the other browser is not affected
    # Signing out with a key: no token to revoke, and not an error.
    assert client.post("/glossary/logout", headers=AMY).status_code == 204


# ---------- Rules ----------


def test_weak_or_odd_input_is_explained(client):
    def attempt(**body):
        response = client.post("/glossary/password", json=body, headers=AMY)
        assert response.status_code == 422, body
        return response.json()["detail"]

    assert "at least 8" in attempt(login="amy", password="short")
    assert "same as the sign-in name" in attempt(login="amy wong 1", password="Amy Wong 1")
    assert "at least 3" in attempt(login="ab", password=PASSWORD)
    assert "looks like an API key" in attempt(login="sk-amy-pasted-here", password=PASSWORD)
    assert client.get("/glossary/me", headers=AMY).json()["has_password"] is False  # nothing was stored


def test_the_api_key_itself_cannot_be_the_password(make_client):
    keys = {"sk-a-long-enough-key": "amy"}
    client = make_client(FakeKeys(keys), litellm_admin_key=ADMIN_KEY)
    refused = client.post("/glossary/password", json={"login": "amy", "password": "sk-a-long-enough-key"}, headers=bearer("sk-a-long-enough-key"))
    assert refused.status_code == 422
    assert "Do not use your API key" in refused.json()["detail"]


def test_one_name_belongs_to_one_person(client):
    set_password(client, AMY, login="Docs Team")
    taken = client.post("/glossary/password", json={"login": "docs  team", "password": PASSWORD}, headers=BEN)
    assert taken.status_code == 422
    assert "already taken" in taken.json()["detail"]
    # amy keeps her own name when changing her password: not a clash.
    set_password(client, AMY, login="Docs Team", password="another long one")


def test_a_name_is_freed_when_its_key_no_longer_exists(client, litellm):
    # This person lost both key and password, and the admin issued a new key in LiteLLM (a
    # new hash, so a different person to us). Coming in with the new key, they should still
    # get their old name back.
    old_token = set_password(client, AMY, login="amy")
    del litellm.by_hash[hash_key("sk-amy")]
    litellm.by_hash[hash_key("sk-amy-2")] = "amy"

    token = set_password(client, bearer("sk-amy-2"), login="amy", password="the second one")
    assert client.get("/glossary/me", headers=bearer(token)).json()["id"] == hash_key("sk-amy-2")[:12]
    assert sign_in(client, "amy", "the second one").status_code == 200
    assert sign_in(client, "amy", PASSWORD).status_code == 401
    assert client.get("/glossary/me", headers=bearer(old_token)).status_code == 401
    # The old account is gone entirely; no two accounts share the name.
    with database(client).connect() as connection:
        assert [row.key_hash for row in connection.execute(select(accounts_table))] == [hash_key("sk-amy-2")]


# ---------- What is stored ----------


def test_neither_the_password_nor_the_token_nor_the_key_is_stored(client):
    token = set_password(client, AMY)
    with database(client).connect() as connection:
        (account,) = connection.execute(select(accounts_table)).mappings().all()
        (session,) = connection.execute(select(sessions_table)).mappings().all()
    everything = " ".join(str(value) for row in (account, session) for value in row.values())
    assert PASSWORD not in everything
    assert token not in everything
    assert "sk-amy" not in everything
    assert account["password_hash"].startswith("scrypt$")
    assert account["key_hash"] == session["key_hash"] == hash_key("sk-amy")


def test_people_shows_who_chose_which_name(client):
    set_password(client, AMY)
    client.get("/glossary/me", headers=BEN)
    people = {person["alias"]: person["login"] for person in client.get("/glossary/people", headers=ROOT).json()["people"]}
    assert people["amy"] == "Amy Wong"
    assert people["ben"] == ""
