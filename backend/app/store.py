"""Glossary storage: the tables, and add, change, delete and bulk import.

The data lives in the stack's Postgres, but in a database of its own (langfaix by
default), apart from LiteLLM's tables: LiteLLM migrates its own database on upgrades.

Access is through SQLAlchemy Core, because the same code then runs on Postgres
(production) and on SQLite (tests), so every operation is testable without a database
server. The schema therefore uses only what both support: duplicates are detected with
normalised _key columns, and timestamps are stored as text.

A prepared Glossary is also kept in memory and rebuilt after every write, so /check
never touches the database.
"""

import json
import re
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from sqlalchemy import BigInteger, Column, Integer, MetaData, Table, Text, UniqueConstraint, create_engine, delete, insert, select, text, update
from sqlalchemy.engine import URL, Engine, make_url
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError
from sqlalchemy.pool import StaticPool

from app.glossary import Entry, Glossary, en_key, tidy, zh_key
# DEFAULT_CATEGORIES is re-exported: the categories are free text on a row, and the
# dropdown on the page shows the profile's categories plus any that are already in use.
from app.glossary_profile import DEFAULT_CATEGORIES, DEFAULT_PROFILE, Profile

SCHEMA_VERSION = 1
ROLES = ("viewer", "editor", "admin")

# Length limits, so nobody pastes in something unrelated.
MAX_TERM = 200
MAX_CATEGORY = 60
MAX_APPLIES_TO = 120
MAX_NOTE = 2000
MAX_VARIANTS = 30

metadata = MetaData()

terms_table = Table(
    "terms",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("zh", Text, nullable=False),
    Column("en", Text, nullable=False),
    Column("category", Text, nullable=False),
    Column("applies_to", Text, nullable=False),
    Column("variants", Text, nullable=False),  # list of wrong forms, as JSON text
    Column("note", Text, nullable=False),
    # Duplicate detection: case, width and extra spaces normalised. A row is a duplicate only if all three match.
    Column("zh_key", Text, nullable=False),
    Column("en_key", Text, nullable=False),
    Column("applies_to_key", Text, nullable=False),
    Column("created_by", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_by", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    UniqueConstraint("zh_key", "en_key", "applies_to_key", name="uq_terms_identity"),
)

people_table = Table(
    "people",
    metadata,
    # SHA-256 of the virtual key: the person's identity. The key itself is not stored.
    Column("key_hash", Text, primary_key=True),
    Column("alias", Text, nullable=False),
    Column("role", Text, nullable=False),
    Column("first_seen", Text, nullable=False),
    Column("last_seen", Text, nullable=False),
)

changes_table = Table(
    "changes",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("at", Text, nullable=False),
    Column("by", Text, nullable=False),
    Column("action", Text, nullable=False),  # add / update / delete / import / role
    Column("summary", Text, nullable=False),  # one line for people
    Column("details", Text, nullable=False),  # before and after, as JSON text
)

schema_table = Table("schema_version", metadata, Column("version", Integer, primary_key=True))

# The two tables for name-and-password sign-in (accounts.py). They were added later:
# create_all at startup only creates missing tables and leaves existing ones alone, so no
# migration step is needed.
accounts_table = Table(
    "accounts",
    metadata,
    # The virtual key the account hangs off. One account per key at most.
    Column("key_hash", Text, primary_key=True),
    Column("login", Text, nullable=False),  # sign-in name, chosen by the user
    Column("login_key", Text, nullable=False, unique=True),  # case-folded name, for uniqueness and sign-in
    Column("password_hash", Text, nullable=False),  # scrypt hash, never the password
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)

sessions_table = Table(
    "sessions",
    metadata,
    # SHA-256 of the session token. The token is not stored, so reading the database does not let anyone impersonate a user.
    Column("token_hash", Text, primary_key=True),
    Column("key_hash", Text, nullable=False, index=True),
    Column("created_at", Text, nullable=False),
    Column("expires_at", BigInteger, nullable=False),  # expiry, in seconds since 1970
)


class Invalid(Exception):
    """The content cannot be saved. messages are the reasons, for the user; there may be several."""

    def __init__(self, messages: list[str]):
        super().__init__("; ".join(messages))
        self.messages = messages


class NotFound(Exception):
    """The row to change or delete does not exist (someone may have just deleted it)."""


@dataclass(frozen=True)
class TermInput:
    """One row as entered by a user, whitespace already tidied."""

    en: str
    zh: str = ""
    category: str = ""
    applies_to: str = ""
    variants: tuple[str, ...] = ()
    note: str = ""

    @property
    def identity(self) -> tuple[str, str, str]:
        return (zh_key(self.zh), en_key(self.en), en_key(self.applies_to))


def clean_input(en="", zh="", category="", applies_to="", variants=(), note="") -> TermInput:
    """Tidy user input: trim whitespace, drop empty and duplicate wrong forms."""
    seen: set[str] = set()
    kept = []
    for variant in variants or ():
        variant = tidy(variant)
        if variant and variant not in seen:
            seen.add(variant)
            kept.append(variant)
    return TermInput(
        en=tidy(en),
        zh=tidy(zh),
        category=tidy(category),
        applies_to=tidy(applies_to),
        variants=tuple(kept),
        note=str(note or "").strip(),
    )


def _identity(entry: Entry) -> tuple[str, str, str]:
    return (zh_key(entry.zh), en_key(entry.en), en_key(entry.applies_to))


class Book:
    """A glossary that can check for conflicts quickly.

    A row is checked against all others before it is saved. Scanning thousands of rows each
    time is too slow, more so for a bulk import of thousands. So the lookups needed are kept
    in a few small indexes and each check takes constant time.
    """

    def __init__(self, entries: list[Entry] | tuple[Entry, ...] = (), profile: Profile | None = None):
        self.profile = profile or DEFAULT_PROFILE
        # Source-script characters, for the "columns swapped" check. None without a source script.
        chars = self.profile.chars
        self._source_char = re.compile(f"[{chars}]") if chars else None
        self.by_id: dict[int, Entry] = {}
        self._identity: dict[tuple[str, str, str], int] = {}  # (Chinese, English, applies-to) -> row id
        self._standard: dict[str, tuple[str, int]] = {}  # English (case-folded) -> (spelling, number of rows using it)
        self._wrong: dict[str, tuple[str, int]] = {}  # wrong form (case-folded) -> (the English it belongs to, number of rows listing it)
        self._wrong_exact: dict[str, int] = {}  # wrong form (as written) -> number of rows listing it
        for entry in entries:
            self.add(entry)

    def add(self, entry: Entry) -> None:
        self.by_id[entry.id] = entry
        self._identity[_identity(entry)] = entry.id
        key = en_key(entry.en)
        self._standard[key] = (entry.en, self._standard.get(key, (entry.en, 0))[1] + 1)
        for variant in entry.variants:
            wrong = en_key(variant)
            self._wrong[wrong] = (key, self._wrong.get(wrong, (key, 0))[1] + 1)
            self._wrong_exact[variant] = self._wrong_exact.get(variant, 0) + 1

    def remove(self, term_id: int) -> Entry | None:
        entry = self.by_id.pop(term_id, None)
        if entry is None:
            return None
        self._identity.pop(_identity(entry), None)
        key = en_key(entry.en)
        self._decrease(self._standard, key)
        for variant in entry.variants:
            self._decrease(self._wrong, en_key(variant))
            if self._wrong_exact.get(variant, 0) <= 1:
                self._wrong_exact.pop(variant, None)
            else:
                self._wrong_exact[variant] -= 1
        return entry

    @staticmethod
    def _decrease(table: dict[str, tuple[str, int]], key: str) -> None:
        value, count = table.get(key, ("", 0))
        if count <= 1:
            table.pop(key, None)
        else:
            table[key] = (value, count - 1)

    def find(self, candidate: TermInput) -> Entry | None:
        """The row with the same Chinese, English and applies-to, if any."""
        term_id = self._identity.get(candidate.identity)
        return self.by_id.get(term_id) if term_id is not None else None

    def problems(self, candidate: TermInput) -> list[str]:
        """Whether this row may enter the table. Returns the reasons, for the user; empty means fine.

        When changing a row, remove the old one first so it does not conflict with itself.
        """
        found = []
        source = self.profile.source_name
        if not candidate.en:
            return ["The English term is required."]
        for label, value, limit in (
            ("English term", candidate.en, MAX_TERM),
            (f"{source} term", candidate.zh, MAX_TERM),
            ("category", candidate.category, MAX_CATEGORY),
            ("applies-to", candidate.applies_to, MAX_APPLIES_TO),
            ("note", candidate.note, MAX_NOTE),
        ):
            if len(value) > limit:
                found.append(f"The {label} is too long ({len(value)} characters, the limit is {limit}).")
        if len(candidate.variants) > MAX_VARIANTS:
            found.append(f"Too many wrong forms ({len(candidate.variants)}, the limit is {MAX_VARIANTS}).")
        # Source-script characters in the English column usually mean the columns were swapped on import.
        if self._source_char and self._source_char.search(candidate.en):
            found.append(f"The English term contains {source} characters. Check that the English and {source} columns are not swapped.")

        if candidate.identity in self._identity:
            found.append(f"This row already exists (same {source}, English and applies-to).")

        key = en_key(candidate.en)
        # One English word must have the same spelling in every row, or there is no standard form.
        existing = self._standard.get(key)
        if existing and existing[0] != candidate.en:
            found.append(f'"{existing[0]}" is already in the glossary with a different spelling of the same word. Use the same spelling.')
        # The English term must not already be registered as a wrong form.
        owner = self._wrong.get(key)
        if owner and (owner[0] != key or self._wrong_exact.get(candidate.en)):
            found.append(f'"{candidate.en}" is registered as a wrong form of "{self._standard[owner[0]][0]}", so it cannot be a term.')

        for variant in candidate.variants:
            wrong = en_key(variant)
            if len(variant) > MAX_TERM:
                found.append(f'The wrong form "{variant[:30]}..." is too long.')
            elif variant == candidate.en:
                found.append("A wrong form cannot be the same as the term itself.")
            elif wrong != key and wrong in self._standard:
                # Example: the name used in an older product version is a term of its own. It must not
                # also be a wrong form of the new name, or people writing docs for the old version get
                # false alarms.
                found.append(f'"{variant}" is a term in the glossary, so it cannot be a wrong form.')
            elif self._standard.get(wrong, ("",))[0] == variant:
                found.append(f'"{variant}" is a term in the glossary, so it cannot be a wrong form.')
            elif wrong in self._wrong and self._wrong[wrong][0] != key:
                other = self._standard[self._wrong[wrong][0]][0]
                found.append(f'"{variant}" is already a wrong form of "{other}".')
        return found

    def categories(self) -> list[str]:
        """Dropdown options for category: the defaults plus those already in use."""
        used = sorted({entry.category for entry in self.by_id.values() if entry.category}, key=str.casefold)
        base = list(self.profile.categories)
        return base + [name for name in used if name not in base]


@dataclass
class RowResult:
    """What happened to one row of a bulk import."""

    line: int  # row number in the sheet, for the user
    status: str  # new / update / same / skip / error
    messages: list[str] = field(default_factory=list)
    id: int | None = None
    data: dict = field(default_factory=dict)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _to_entry(row) -> Entry:
    return Entry(
        id=row["id"],
        en=row["en"],
        zh=row["zh"],
        category=row["category"],
        applies_to=row["applies_to"],
        variants=tuple(json.loads(row["variants"] or "[]")),
        note=row["note"],
        created_by=row["created_by"],
        created_at=row["created_at"],
        updated_by=row["updated_by"],
        updated_at=row["updated_at"],
    )


def _columns(data: TermInput) -> dict:
    """The columns written to the database for one row."""
    zh, en, applies_to = data.identity
    return {
        "zh": data.zh,
        "en": data.en,
        "category": data.category,
        "applies_to": data.applies_to,
        "variants": json.dumps(list(data.variants), ensure_ascii=False),
        "note": data.note,
        "zh_key": zh,
        "en_key": en,
        "applies_to_key": applies_to,
    }


def _same_content(entry: Entry, data: TermInput) -> bool:
    return (entry.en, entry.zh, entry.category, entry.applies_to, entry.variants, entry.note) == (
        data.en,
        data.zh,
        data.category,
        data.applies_to,
        data.variants,
        data.note,
    )


def _snapshot(entry: Entry) -> dict:
    """The form kept in the change log."""
    values = asdict(entry)
    values["variants"] = list(entry.variants)
    return {key: values[key] for key in ("id", "zh", "en", "category", "applies_to", "variants", "note")}


def make_engine(url: str) -> Engine:
    """Connect to the database at this URL. Empty means an in-memory SQLite (development and tests; lost on restart)."""
    parsed = make_url(url or "sqlite+pysqlite:///:memory:")
    if parsed.get_backend_name() == "sqlite":
        options = {"connect_args": {"check_same_thread": False}}
        if parsed.database in (None, "", ":memory:"):
            # Each connection to an in-memory SQLite is its own empty database, so one connection must be shared.
            options["poolclass"] = StaticPool
        return create_engine(parsed, **options)
    _ensure_database(parsed)
    # pool_pre_ping: test a connection before using it, so a Postgres restart needs no restart here.
    return create_engine(parsed, pool_pre_ping=True)


def _ensure_database(url: URL) -> None:
    """Create our database in Postgres if it does not exist, so deploying needs no manual step."""
    probe = create_engine(url)
    try:
        with probe.connect():
            return
    except OperationalError as exc:
        if "does not exist" not in str(exc):
            raise  # unreachable, wrong password and so on: let the caller decide
    finally:
        probe.dispose()

    name = url.database or ""
    # The name is interpolated into the statement (no parameters allowed there), so accept only plain names.
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError(f"unusable database name: {name!r}")
    # CREATE DATABASE cannot run in a transaction, hence autocommit. Connect to the postgres database, which always exists.
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as connection:
            connection.execute(text(f'CREATE DATABASE "{name}"'))
    except ProgrammingError as exc:
        if "already exists" not in str(exc):
            raise  # another process created it first: not an error
    finally:
        admin.dispose()


class GlossaryStore:
    """All reads and writes of the glossary go through here."""

    def __init__(self, url: str = "", profile: Profile | None = None):
        self.profile = profile or DEFAULT_PROFILE
        self.engine = make_engine(url)
        metadata.create_all(self.engine)
        # Everything is serialised: a write is followed by a rebuild of the in-memory glossary,
        # and no other write may slip in between.
        self._lock = threading.RLock()
        with self._lock, self.engine.begin() as connection:
            if connection.execute(select(schema_table.c.version)).first() is None:
                connection.execute(insert(schema_table).values(version=SCHEMA_VERSION))
        self.book = Book(profile=self.profile)
        self.glossary = Glossary(profile=self.profile)
        self.reload()

    def close(self) -> None:
        self.engine.dispose()

    def reload(self) -> None:
        """Read everything again and rebuild the conflict indexes and the matching glossary."""
        with self._lock:
            with self.engine.connect() as connection:
                rows = connection.execute(select(terms_table).order_by(terms_table.c.id)).mappings().all()
            entries = [_to_entry(row) for row in rows]
            self.book = Book(entries, self.profile)
            self.glossary = Glossary(entries, self.profile)

    def entries(self) -> list[Entry]:
        return list(self.glossary.entries)

    # ---------- Row by row ----------

    def add(self, data: TermInput, by: str) -> Entry:
        with self._lock:
            found = self.book.problems(data)
            if found:
                raise Invalid(found)
            now = _now()
            with self.engine.begin() as connection:
                result = connection.execute(
                    insert(terms_table).values(**_columns(data), created_by=by, created_at=now, updated_by=by, updated_at=now)
                )
                term_id = result.inserted_primary_key[0]
                self._log(connection, by, "add", f"Added {data.en}", {"after": {"id": term_id, **asdict(data)}})
            self.reload()
            return self.book.by_id[term_id]

    def update(self, term_id: int, data: TermInput, by: str) -> Entry:
        with self._lock:
            old = self.book.remove(term_id)
            if old is None:
                raise NotFound()
            found = self.book.problems(data)
            if found:
                self.book.add(old)  # not saved: put the removed row back
                raise Invalid(found)
            with self.engine.begin() as connection:
                connection.execute(
                    update(terms_table).where(terms_table.c.id == term_id).values(**_columns(data), updated_by=by, updated_at=_now())
                )
                self._log(connection, by, "update", f"Changed {data.en}", {"before": _snapshot(old), "after": {"id": term_id, **asdict(data)}})
            self.reload()
            return self.book.by_id[term_id]

    def delete(self, term_id: int, by: str) -> None:
        with self._lock:
            old = self.book.by_id.get(term_id)
            if old is None:
                raise NotFound()
            with self.engine.begin() as connection:
                connection.execute(delete(terms_table).where(terms_table.c.id == term_id))
                self._log(connection, by, "delete", f"Deleted {old.en}", {"before": _snapshot(old)})
            self.reload()

    # ---------- Bulk import ----------

    def classify(self, rows: list[dict], update_existing: bool) -> list[RowResult]:
        """What importing these rows would do, without writing. For the preview."""
        with self._lock:
            return self._classify(Book(self.entries(), self.profile), rows, update_existing)

    @staticmethod
    def _classify(book: Book, rows: list[dict], update_existing: bool) -> list[RowResult]:
        """Try each row in turn on a copy and record what happened to it.

        In turn, so conflicts inside the sheet are found: of two contradicting rows in one
        file, the second is reported.
        """
        results = []
        for number, row in enumerate(rows, start=1):
            line = int(row.get("line") or number)
            data = clean_input(row.get("en"), row.get("zh"), row.get("category"), row.get("applies_to"), row.get("variants"), row.get("note"))
            result = RowResult(line=line, status="error", data={**asdict(data), "variants": list(data.variants)})
            results.append(result)

            # Which existing row this is: by id when given, otherwise by (Chinese, English, applies-to).
            raw_id = row.get("id")
            if raw_id not in (None, ""):
                try:
                    target = book.by_id.get(int(raw_id))
                except (TypeError, ValueError):
                    target = None
                if target is None:
                    result.messages = [f"There is no row with id {raw_id}. Remove the id to add this as a new row."]
                    continue
            else:
                target = book.find(data)

            if target is None:
                found = book.problems(data)
                if found:
                    result.messages = found
                    continue
                # Give it a temporary negative id in the copy, so later rows can conflict with it.
                book.add(Entry(id=-number, **asdict(data)))
                result.status = "new"
                continue

            result.id = target.id
            if _same_content(target, data):
                result.status = "same"
                continue
            if not update_existing:
                result.status = "skip"
                result.messages = ["This row is already in the glossary with different details. It is left as it is."]
                continue
            book.remove(target.id)
            found = book.problems(data)
            if found:
                book.add(target)
                result.messages = found
                continue
            book.add(Entry(id=target.id, **asdict(data)))
            result.status = "update"
        return results

    def import_rows(self, rows: list[dict], update_existing: bool, by: str) -> list[RowResult]:
        """Write a batch of rows. Rows with problems are skipped; the rest go in one transaction."""
        with self._lock:
            results = self._classify(Book(self.entries(), self.profile), rows, update_existing)
            now = _now()
            new_rows = []
            with self.engine.begin() as connection:
                for result in results:
                    data = clean_input(**result.data)
                    if result.status == "new":
                        new_rows.append({**_columns(data), "created_by": by, "created_at": now, "updated_by": by, "updated_at": now})
                    elif result.status == "update":
                        connection.execute(
                            update(terms_table).where(terms_table.c.id == result.id).values(**_columns(data), updated_by=by, updated_at=now)
                        )
                if new_rows:
                    connection.execute(insert(terms_table), new_rows)
                counts = {status: sum(1 for result in results if result.status == status) for status in ("new", "update", "same", "skip", "error")}
                if counts["new"] or counts["update"]:
                    self._log(connection, by, "import", f"Imported {counts['new']} new and {counts['update']} changed rows", counts)
            self.reload()
            return results

    # ---------- People and roles ----------

    def sign_in(self, key_hash: str, alias: str) -> str:
        """Record the visit and return the role. A first-time visitor is a viewer."""
        with self._lock, self.engine.begin() as connection:
            now = _now()
            row = connection.execute(select(people_table).where(people_table.c.key_hash == key_hash)).mappings().first()
            if row is None:
                connection.execute(insert(people_table).values(key_hash=key_hash, alias=alias, role="viewer", first_seen=now, last_seen=now))
                return "viewer"
            connection.execute(update(people_table).where(people_table.c.key_hash == key_hash).values(alias=alias, last_seen=now))
            return row["role"]

    def role_of(self, key_hash: str) -> str:
        with self._lock, self.engine.connect() as connection:
            row = connection.execute(select(people_table.c.role).where(people_table.c.key_hash == key_hash)).first()
            return row[0] if row else "viewer"

    def set_role(self, key_hash: str, role: str, by: str) -> None:
        if role not in ROLES:
            raise Invalid([f"Unknown role: {role}"])
        with self._lock, self.engine.begin() as connection:
            row = connection.execute(select(people_table).where(people_table.c.key_hash == key_hash)).mappings().first()
            if row is None:
                raise NotFound()
            connection.execute(update(people_table).where(people_table.c.key_hash == key_hash).values(role=role))
            self._log(connection, by, "role", f"{row['alias']} is now {role}", {"before": row["role"], "after": role})

    def people(self) -> list[dict]:
        with self._lock, self.engine.connect() as connection:
            rows = connection.execute(select(people_table).order_by(people_table.c.alias)).mappings().all()
            return [dict(row) for row in rows]

    # ---------- Name-and-password accounts, and session tokens ----------

    NAME_TAKEN = "This sign-in name is already taken. Choose another one."

    def account_of(self, key_hash: str) -> dict | None:
        """The account under this key, or None if no password was ever set."""
        with self._lock, self.engine.connect() as connection:
            row = connection.execute(select(accounts_table).where(accounts_table.c.key_hash == key_hash)).mappings().first()
            return dict(row) if row else None

    def account_by_login(self, login_key: str) -> dict | None:
        with self._lock, self.engine.connect() as connection:
            row = connection.execute(select(accounts_table).where(accounts_table.c.login_key == login_key)).mappings().first()
            return dict(row) if row else None

    def logins(self) -> dict[str, str]:
        """Key hash -> sign-in name. Lets an admin see on the People page who a sign-in name is."""
        with self._lock, self.engine.connect() as connection:
            rows = connection.execute(select(accounts_table.c.key_hash, accounts_table.c.login)).all()
            return {row[0]: row[1] for row in rows}

    def save_account(self, key_hash: str, login: str, login_key: str, password_hash: str) -> None:
        """Create the account, or change its sign-in name and password. Raises Invalid if the name is taken."""
        with self._lock:
            now = _now()
            try:
                with self.engine.begin() as connection:
                    owner = connection.execute(select(accounts_table.c.key_hash).where(accounts_table.c.login_key == login_key)).first()
                    if owner and owner[0] != key_hash:
                        raise Invalid([self.NAME_TAKEN])
                    exists = connection.execute(select(accounts_table.c.key_hash).where(accounts_table.c.key_hash == key_hash)).first()
                    values = {"login": login, "login_key": login_key, "password_hash": password_hash, "updated_at": now}
                    if exists:
                        connection.execute(update(accounts_table).where(accounts_table.c.key_hash == key_hash).values(**values))
                    else:
                        connection.execute(insert(accounts_table).values(key_hash=key_hash, created_at=now, **values))
            except IntegrityError as exc:
                # Checked above already: reaching this means another process took the name in between,
                # and the unique constraint caught it.
                raise Invalid([self.NAME_TAKEN]) from exc

    def delete_account(self, key_hash: str) -> None:
        """Delete the account together with all its session tokens."""
        with self._lock, self.engine.begin() as connection:
            connection.execute(delete(sessions_table).where(sessions_table.c.key_hash == key_hash))
            connection.execute(delete(accounts_table).where(accounts_table.c.key_hash == key_hash))

    def create_session(self, key_hash: str, token_hash: str, expires_at: int, now: int) -> None:
        with self._lock, self.engine.begin() as connection:
            # Clear expired tokens on the way, so the table does not grow forever.
            connection.execute(delete(sessions_table).where(sessions_table.c.expires_at <= now))
            connection.execute(insert(sessions_table).values(token_hash=token_hash, key_hash=key_hash, created_at=_now(), expires_at=expires_at))

    def session_owner(self, token_hash: str, now: int) -> str | None:
        """The key this session token belongs to, or None if unknown or expired."""
        with self._lock, self.engine.connect() as connection:
            row = connection.execute(select(sessions_table.c.key_hash, sessions_table.c.expires_at).where(sessions_table.c.token_hash == token_hash)).first()
            return row[0] if row and row[1] > now else None

    def delete_session(self, token_hash: str) -> None:
        with self._lock, self.engine.begin() as connection:
            connection.execute(delete(sessions_table).where(sessions_table.c.token_hash == token_hash))

    def delete_sessions(self, key_hash: str) -> None:
        """Sign this person out everywhere. Done after a password change."""
        with self._lock, self.engine.begin() as connection:
            connection.execute(delete(sessions_table).where(sessions_table.c.key_hash == key_hash))

    # ---------- Change log ----------

    @staticmethod
    def _log(connection, by: str, action: str, summary: str, details: dict) -> None:
        connection.execute(
            insert(changes_table).values(at=_now(), by=by, action=action, summary=summary, details=json.dumps(details, ensure_ascii=False))
        )

    def changes(self, limit: int = 200) -> list[dict]:
        with self._lock, self.engine.connect() as connection:
            rows = connection.execute(select(changes_table).order_by(changes_table.c.id.desc()).limit(limit)).mappings().all()
            return [{**dict(row), "details": json.loads(row["details"] or "{}")} for row in rows]
