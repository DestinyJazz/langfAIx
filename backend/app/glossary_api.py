"""Glossary endpoints: sign-in, lookup, editing, bulk import, export, people and roles, change log.

Every endpoint except password sign-in needs one of these in Authorization: Bearer ...
  - a LiteLLM virtual key (sk-...). The browser extension uses it, and so does the first
    visit to the admin page
  - a session token (lfs_...), obtained by signing in with name and password (accounts.py)

Roles:
  viewer  any valid key: read, look up, export
  editor  also add, change, delete, import
  admin   also set other people's roles

Database access is synchronous (store.py) and these endpoints are async, so every
database call goes through run_in_threadpool to keep other requests moving.
"""

import asyncio
import base64
import binascii
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

from app.accounts import (
    PASSWORDS_AVAILABLE,
    SESSION_PREFIX,
    SESSION_SECONDS,
    LoginThrottle,
    check_password,
    clean_login,
    hash_password,
    hash_token,
    login_key,
    login_problems,
    new_session_token,
    password_problems,
)
from app.glossary import Entry
from app.identity import Identity, IdentityError, IdentityService, bearer
from app.sheets import SheetError, read_sheet, to_csv, to_xlsx
from app.store import ROLES, GlossaryStore, Invalid, NotFound, clean_input

# Role ranking, for "at least this role" checks.
RANK = {role: level for level, role in enumerate(ROLES)}


class TermBody(BaseModel):
    """Body for adding or changing one glossary row."""

    en: str = ""
    zh: str = ""
    category: str = ""
    applies_to: str = ""
    variants: list[str] = Field(default_factory=list)
    note: str = ""


class PreviewBody(BaseModel):
    """Import preview. Either a file (base64 content) or pasted text."""

    filename: str = ""
    content_base64: str = ""
    text: str = ""
    # Normally detected. The page sends them again, corrected, when detection was wrong.
    mapping: dict[str, int] | None = None
    has_header: bool | None = None
    # True: add new rows and update existing ones. False: only add; existing rows stay as they are.
    update_existing: bool = True


class ImportBody(BaseModel):
    rows: list[dict]
    update_existing: bool = True


class RoleBody(BaseModel):
    role: str


class LoginBody(BaseModel):
    login: str = ""
    password: str = ""


class PasswordBody(BaseModel):
    """Set or change the password. Someone signed in with a password must give the current one again."""

    login: str = ""
    password: str = ""
    current_password: str = ""


@dataclass(frozen=True)
class User:
    identity: Identity
    role: str
    via: str = "key"  # how this request authenticated: key (virtual key) or password (session token)
    token_hash: str = ""  # hash of the session token, used to revoke it on sign-out

    @property
    def name(self) -> str:
        return self.identity.alias


def term_json(entry: Entry) -> dict:
    return {
        "id": entry.id,
        "zh": entry.zh,
        "en": entry.en,
        "category": entry.category,
        "applies_to": entry.applies_to,
        "variants": list(entry.variants),
        "note": entry.note,
        "created_by": entry.created_by,
        "created_at": entry.created_at,
        "updated_by": entry.updated_by,
        "updated_at": entry.updated_at,
    }


def _counts(results) -> dict:
    return {status: sum(1 for result in results if result.status == status) for status in ("new", "update", "same", "skip", "error")}


def _result_json(result) -> dict:
    return {"line": result.line, "status": result.status, "messages": result.messages, "id": result.id, "data": result.data}


def build_router(state, identities: IdentityService) -> APIRouter:
    """state is the GlossaryState from main.py (database connection and current glossary)."""
    router = APIRouter(prefix="/glossary", tags=["glossary"])

    def store() -> GlossaryStore:
        if state.store is None:
            # The database is not connected yet (e.g. Postgres still starting). Rule checks are unaffected.
            raise HTTPException(status_code=503, detail="the glossary database is not available right now, try again in a moment")
        return state.store

    # Wrong-password tracking, and a gate on concurrent password hashing: one hash costs
    # 50 ms and 16 MB, so without a gate a flood of sign-in requests could slow the service.
    throttle = LoginThrottle()
    # Password sign-in needs lookup by hash (LITELLM_ADMIN_KEY set) and a working scrypt.
    passwords_on = identities.can_look_up_by_hash and PASSWORDS_AVAILABLE
    hashing = asyncio.Semaphore(2)

    async def password_matches(password: str, stored: str | None) -> bool:
        async with hashing:
            return await run_in_threadpool(check_password, password, stored)

    key_gone = "the API key behind this account is no longer valid. Ask the administrator for a new key, then sign in with that key."

    async def identity_of_account(request: Request, key_hash: str) -> Identity:
        """For someone signed in with a password: only the key's hash is known, so ask LiteLLM whether that key is still valid."""
        try:
            return await identities.resolve_hash(request.app.state.http, key_hash)
        except IdentityError as exc:
            detail = key_gone if exc.status_code == 401 else exc.message
            raise HTTPException(status_code=exc.status_code, detail=detail) from exc

    async def start_session(key_hash: str) -> dict:
        """Issue a session token. The token itself appears only in this response; the database keeps its hash."""
        token = new_session_token()
        now = int(time.time())
        await run_in_threadpool(store().create_session, key_hash, hash_token(token), now + SESSION_SECONDS, now)
        expires = datetime.fromtimestamp(now + SESSION_SECONDS, timezone.utc).isoformat(timespec="seconds")
        return {"token": token, "expires_at": expires}

    async def current_user(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> User:
        secret = credentials.credentials.strip() if credentials else ""
        via, token_hash = "key", ""
        if secret.startswith(SESSION_PREFIX):
            # Session token: find which key it belongs to in our database, then confirm the key is still valid.
            via, token_hash = "password", hash_token(secret)
            key_hash = await run_in_threadpool(store().session_owner, token_hash, int(time.time()))
            if key_hash is None:
                raise HTTPException(status_code=401, detail="your sign-in has expired. Sign in again.")
            identity = await identity_of_account(request, key_hash)
        else:
            try:
                identity = await identities.resolve(request.app.state.http, secret)
            except IdentityError as exc:
                raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
        if identities.is_admin(identity):
            return User(identity, "admin", via, token_hash)
        return User(identity, await run_in_threadpool(store().role_of, identity.key_hash), via, token_hash)

    def at_least(role: str):
        """Build a dependency that requires at least the given role."""

        async def check(user: User = Depends(current_user)) -> User:
            if RANK.get(user.role, 0) < RANK[role]:
                raise HTTPException(status_code=403, detail=f"this needs the {role} role, and you are a {user.role}. Ask a glossary administrator.")
            return user

        return check

    def invalid(exc: Invalid) -> HTTPException:
        # 422: well-formed request, unacceptable content (e.g. a duplicate row).
        return HTTPException(status_code=422, detail=" ".join(exc.messages))

    missing = HTTPException(status_code=404, detail="this row does not exist any more. It may have been deleted by someone else.")

    # ---------- Who am I ----------

    @router.get("/me")
    async def me(user: User = Depends(current_user)) -> dict:
        # Record the visit, so an admin can see this person and grant a role.
        await run_in_threadpool(store().sign_in, user.identity.key_hash, user.identity.alias)
        account = await run_in_threadpool(store().account_of, user.identity.key_hash)
        return {
            "alias": user.identity.alias,
            "id": user.identity.short_id,
            "role": user.role,
            "can_edit": RANK[user.role] >= RANK["editor"],
            "is_admin": user.role == "admin",
            # For the sign-in page: whether a password is set, and how this request authenticated.
            "login": account["login"] if account else "",
            "has_password": account is not None,
            "signed_in_with": user.via,
            # Whether this server offers password sign-in at all. If not, the page does not mention it.
            "password_sign_in": passwords_on,
        }

    # ---------- Name and password ----------

    @router.post("/login")
    async def login(body: LoginBody, request: Request) -> dict:
        """Sign in with name and password and get a session token. The only endpoint that needs no key or token."""
        name = login_key(body.login)
        wait = throttle.wait_seconds(name)
        if wait:
            minutes = (wait + 59) // 60
            raise HTTPException(
                status_code=429,
                detail=f"too many wrong passwords for this name. Try again in {minutes} {'minute' if minutes == 1 else 'minutes'}, or sign in with your API key.",
            )
        account = await run_in_threadpool(store().account_by_login, name) if name else None
        if not await password_matches(body.password, account["password_hash"] if account else None):
            throttle.failed(name)
            # Unknown name and wrong password give the same answer, so names cannot be probed.
            raise HTTPException(status_code=401, detail="wrong name or password")
        throttle.succeeded(name)
        # The password is right; the key behind the account must still be valid too.
        await identity_of_account(request, account["key_hash"])
        return {"login": account["login"], **await start_session(account["key_hash"])}

    @router.post("/password")
    async def set_password(
        body: PasswordBody,
        request: Request,
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
        user: User = Depends(current_user),
    ) -> dict:
        """Set a password, or change the sign-in name and password. Returns a new session token
        and revokes all of this person's earlier ones.

        Signed in with a key: set it directly (this is the "forgot my password" path).
        Signed in with a session token: the current password is required again, so nobody can
        change it at an unattended desk.
        """
        if not passwords_on:
            why = "LITELLM_ADMIN_KEY is not set" if not identities.can_look_up_by_hash else "this Python has no scrypt"
            raise HTTPException(status_code=503, detail=f"signing in with a password is not available on this server ({why})")
        current = store()
        key_hash = user.identity.key_hash
        account = await run_in_threadpool(current.account_of, key_hash)

        if user.via == "password":
            guard = f"change:{key_hash}"
            if throttle.wait_seconds(guard):
                raise HTTPException(status_code=429, detail="too many wrong passwords. Try again later, or sign in with your API key to set a new password.")
            if not await password_matches(body.current_password, account["password_hash"] if account else None):
                throttle.failed(guard)
                raise HTTPException(status_code=403, detail="the current password is wrong")
            throttle.succeeded(guard)

        # No name given: keep the existing one, or use the key alias for a new account.
        name = clean_login(body.login) or (account["login"] if account else user.identity.alias)
        key = credentials.credentials.strip() if credentials and user.via == "key" else ""
        problems = login_problems(name) + password_problems(body.password, name, key)
        if problems:
            raise HTTPException(status_code=422, detail=" ".join(problems))

        # The name belongs to another key's account. If that key no longer exists (the person
        # lost it and the admin issued a new one), the old account can never sign in again, so
        # the name is released.
        owner = await run_in_threadpool(current.account_by_login, login_key(name))
        if owner and owner["key_hash"] != key_hash:
            try:
                await identities.resolve_hash(request.app.state.http, owner["key_hash"])
            except IdentityError as exc:
                if exc.status_code != 401:
                    raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
                await run_in_threadpool(current.delete_account, owner["key_hash"])
            else:
                raise HTTPException(status_code=422, detail=current.NAME_TAKEN)

        async with hashing:
            hashed = await run_in_threadpool(hash_password, body.password)
        try:
            await run_in_threadpool(current.save_account, key_hash, name, login_key(name), hashed)
        except Invalid as exc:
            raise invalid(exc) from exc
        # Anyone with an account must appear on the People page, so an admin can grant a role.
        await run_in_threadpool(current.sign_in, key_hash, user.identity.alias)
        # Password changed: revoke every earlier token (other browsers must sign in again) and issue a new one.
        await run_in_threadpool(current.delete_sessions, key_hash)
        return {"login": name, **await start_session(key_hash)}

    @router.post("/logout", status_code=204)
    async def logout(user: User = Depends(current_user)) -> Response:
        """Sign out: revoke this session token. A key has no token to revoke."""
        if user.token_hash:
            await run_in_threadpool(store().delete_session, user.token_hash)
        return Response(status_code=204)

    # ---------- Lookup and listing ----------

    @router.get("/profile")
    async def profile(user: User = Depends(at_least("viewer"))) -> dict:
        """What the glossary is about, so the admin page can label its columns and filters."""
        return {
            "source_language": state.profile.source_name,
            # False for a glossary without a source language: the page hides that column.
            "has_source": state.profile.has_source,
            "categories": list(state.profile.categories),
        }

    @router.get("/lookup")
    async def lookup(q: str = "", user: User = Depends(at_least("viewer"))) -> dict:
        """Look a word up in Chinese or English; the 20 best rows. Used by the extension's lookup box."""
        return {"results": [term_json(entry) for entry in state.glossary.lookup(q)]}

    @router.get("/terms")
    async def list_terms(user: User = Depends(at_least("viewer"))) -> dict:
        current = store()
        return {"terms": [term_json(entry) for entry in current.entries()], "categories": current.book.categories()}

    # ---------- Add, change, delete ----------

    @router.post("/terms", status_code=201)
    async def add_term(body: TermBody, user: User = Depends(at_least("editor"))) -> dict:
        try:
            entry = await run_in_threadpool(store().add, clean_input(**body.model_dump()), user.name)
        except Invalid as exc:
            raise invalid(exc) from exc
        return term_json(entry)

    @router.put("/terms/{term_id}")
    async def update_term(term_id: int, body: TermBody, user: User = Depends(at_least("editor"))) -> dict:
        try:
            entry = await run_in_threadpool(store().update, term_id, clean_input(**body.model_dump()), user.name)
        except Invalid as exc:
            raise invalid(exc) from exc
        except NotFound as exc:
            raise missing from exc
        return term_json(entry)

    @router.delete("/terms/{term_id}", status_code=204)
    async def delete_term(term_id: int, user: User = Depends(at_least("editor"))) -> Response:
        try:
            await run_in_threadpool(store().delete, term_id, user.name)
        except NotFound as exc:
            raise missing from exc
        return Response(status_code=204)

    # ---------- Bulk import ----------

    @router.post("/import/preview")
    async def preview_import(body: PreviewBody, user: User = Depends(at_least("editor"))) -> dict:
        """Read the file and report what importing each row would do. Writes nothing."""
        try:
            raw = base64.b64decode(body.content_base64, validate=True) if body.content_base64 else None
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(status_code=400, detail="the uploaded file could not be decoded") from exc
        try:
            sheet = await run_in_threadpool(read_sheet, body.filename, raw, body.text, body.mapping, body.has_header, state.profile)
        except SheetError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if "en" not in sheet.mapping:
            # The English column could not be identified: return the column names so the user can map them.
            return {"columns": sheet.columns, "mapping": sheet.mapping, "has_header": sheet.has_header, "rows": [], "counts": _counts([]), "needs_mapping": True}
        results = await run_in_threadpool(store().classify, sheet.rows(), body.update_existing)
        return {
            "columns": sheet.columns,
            "mapping": sheet.mapping,
            "has_header": sheet.has_header,
            "rows": [_result_json(result) for result in results],
            "counts": _counts(results),
            "needs_mapping": False,
        }

    @router.post("/import")
    async def run_import(body: ImportBody, user: User = Depends(at_least("editor"))) -> dict:
        """Write previewed rows. Every row is validated again here; the page's verdict is not trusted."""
        if len(body.rows) > 20000:
            raise HTTPException(status_code=413, detail="too many rows in one import (the limit is 20000)")
        results = await run_in_threadpool(store().import_rows, body.rows, body.update_existing, user.name)
        problems = [_result_json(result) for result in results if result.status in ("error", "skip")]
        return {"counts": _counts(results), "problems": problems}

    # ---------- Export ----------

    @router.get("/export")
    async def export(format: str = "xlsx", user: User = Depends(at_least("viewer"))) -> Response:
        entries = store().entries()
        if format == "csv":
            content, media, name = await run_in_threadpool(to_csv, entries, state.profile), "text/csv; charset=utf-8", "glossary.csv"
        elif format == "xlsx":
            media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            content, name = await run_in_threadpool(to_xlsx, entries, state.profile), "glossary.xlsx"
        else:
            raise HTTPException(status_code=400, detail="format must be xlsx or csv")
        return Response(content=content, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})

    # ---------- People and roles ----------

    @router.get("/people")
    async def people(user: User = Depends(at_least("admin"))) -> dict:
        rows = await run_in_threadpool(store().people)
        logins = await run_in_threadpool(store().logins)
        result = []
        for row in rows:
            fixed = identities.is_admin(Identity(row["key_hash"], row["alias"]))
            result.append(
                {
                    "key_hash": row["key_hash"],
                    "id": row["key_hash"][:12],
                    "alias": row["alias"],
                    # The sign-in name this person chose; empty if no password was set.
                    "login": logins.get(row["key_hash"], ""),
                    # Admins named in the environment are always admin and cannot be changed on the page.
                    "role": "admin" if fixed else row["role"],
                    "fixed": fixed,
                    "first_seen": row["first_seen"],
                    "last_seen": row["last_seen"],
                }
            )
        return {"people": result}

    @router.put("/people/{key_hash}")
    async def set_role(key_hash: str, body: RoleBody, user: User = Depends(at_least("admin"))) -> dict:
        try:
            await run_in_threadpool(store().set_role, key_hash, body.role, user.name)
        except Invalid as exc:
            raise invalid(exc) from exc
        except NotFound as exc:
            raise HTTPException(status_code=404, detail="this person has not signed in yet") from exc
        return {"key_hash": key_hash, "role": body.role}

    # ---------- Change log ----------

    @router.get("/changes")
    async def changes(user: User = Depends(at_least("viewer"))) -> dict:
        return {"changes": await run_in_threadpool(store().changes)}

    return router
