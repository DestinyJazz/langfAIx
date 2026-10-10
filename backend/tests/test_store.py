"""Glossary storage: validation rules, add/change/delete, bulk import, people and roles, change log.

The database here is an in-memory SQLite. Production uses Postgres, which the tests do
not have, so a last group compiles every table and statement type for the Postgres
dialect to confirm it accepts them.
"""

import pytest
from sqlalchemy import delete, insert, select, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable

from app.store import (
    DEFAULT_CATEGORIES,
    Book,
    GlossaryStore,
    Invalid,
    NotFound,
    accounts_table,
    changes_table,
    clean_input,
    metadata,
    people_table,
    sessions_table,
    terms_table,
)
from app.glossary import Entry


@pytest.fixture
def store():
    made = GlossaryStore()  # empty URL: in-memory SQLite
    yield made
    made.close()


def row(en, zh="", **extra) -> dict:
    return {"en": en, "zh": zh, **extra}


# ---------- Tidying input ----------


def test_input_is_tidied():
    data = clean_input(en="  Zyphor   Gateway ", zh=" 网关 ", variants=[" Zyfor Gateway ", "", "Zyfor Gateway", "ZG"], note="  keep\ninner lines  ")
    assert data.en == "Zyphor Gateway"
    assert data.zh == "网关"
    assert data.variants == ("Zyfor Gateway", "ZG")  # empty and duplicate ones are dropped
    assert data.note == "keep\ninner lines"


# ---------- Validation rules ----------


def test_english_is_required_but_chinese_is_not(store):
    with pytest.raises(Invalid) as error:
        store.add(clean_input(en="", zh="网关"), "amy")
    assert error.value.messages == ["The English term is required."]
    assert store.add(clean_input(en="ZX3.1.60", category="Version"), "amy").zh == ""


def test_the_same_chinese_can_have_several_english_terms(store):
    store.add(clean_input(en="Archiving Center", zh="归档中心", applies_to="before 3.1.60"), "amy")
    store.add(clean_input(en="Archive Center", zh="归档中心", applies_to="3.1.60 and later"), "amy")
    assert [entry.en for entry in store.entries()] == ["Archiving Center", "Archive Center"]


def test_the_same_row_twice_is_rejected(store):
    store.add(clean_input(en="WebUI", zh="网页管理界面"), "amy")
    with pytest.raises(Invalid) as error:
        store.add(clean_input(en="webui", zh="网页管理界面"), "amy")  # a different case is still the same row
    assert "already exists" in error.value.messages[0]


def test_the_same_english_must_be_spelled_the_same_in_every_row(store):
    store.add(clean_input(en="WebUI", zh="网页管理界面"), "amy")
    with pytest.raises(Invalid) as error:
        store.add(clean_input(en="Webui", zh="管理页面"), "amy")
    assert '"WebUI" is already in the glossary' in error.value.messages[0]
    # Fine as long as the spelling matches: one English term for two Chinese terms.
    store.add(clean_input(en="WebUI", zh="管理页面"), "amy")


def test_a_wrong_form_cannot_be_a_term_and_a_term_cannot_be_a_wrong_form(store):
    store.add(clean_input(en="Archiving Center", zh="归档中心", applies_to="before 3.1.60"), "amy")
    # The old name is a term of its own, so it cannot be a wrong form of the new name.
    with pytest.raises(Invalid) as error:
        store.add(clean_input(en="Archive Center", zh="归档中心", applies_to="3.1.60 and later", variants=["Archiving Center"]), "amy")
    assert error.value.messages == ['"Archiving Center" is a term in the glossary, so it cannot be a wrong form.']

    store.add(clean_input(en="WebUI", variants=["Web UI"]), "amy")
    with pytest.raises(Invalid) as error:
        store.add(clean_input(en="Web UI", zh="网页界面"), "amy")
    assert error.value.messages == ['"Web UI" is registered as a wrong form of "WebUI", so it cannot be a term.']


def test_a_wrong_form_belongs_to_one_term_only(store):
    store.add(clean_input(en="WebUI", variants=["Web UI"]), "amy")
    with pytest.raises(Invalid) as error:
        store.add(clean_input(en="Web Console", variants=["web ui"]), "amy")
    assert error.value.messages == ['"web ui" is already a wrong form of "WebUI".']
    # Another row of the same term may list the same wrong form again.
    store.add(clean_input(en="WebUI", zh="网页管理界面", variants=["Web UI"]), "amy")


def test_a_wrong_form_may_differ_from_the_term_only_by_capitalization(store):
    # To have webui always flagged, register it as a wrong form. But it cannot be identical to the standard form.
    store.add(clean_input(en="WebUI", variants=["webui"]), "amy")
    with pytest.raises(Invalid) as error:
        store.add(clean_input(en="Zyphor", variants=["Zyphor"]), "amy")
    assert error.value.messages == ["A wrong form cannot be the same as the term itself."]


def test_overlong_fields_are_rejected(store):
    with pytest.raises(Invalid) as error:
        store.add(clean_input(en="x" * 201, note="y" * 2001), "amy")
    assert len(error.value.messages) == 2


# ---------- Add, change, delete ----------


def test_add_records_who_and_when_and_takes_effect_at_once(store):
    entry = store.add(clean_input(en="WebUI", zh="网页管理界面", category="Feature", variants=["Web UI"], note="main page"), "amy")

    assert entry.id > 0
    assert (entry.created_by, entry.updated_by) == ("amy", "amy")
    assert entry.created_at and entry.created_at == entry.updated_at
    assert entry.variants == ("Web UI",)
    # The matching glossary has the row at once, without a restart.
    assert store.glossary.prompt_lines("Open the WebUI now.") == ["- WebUI"]


def test_update_changes_the_row_and_keeps_who_created_it(store):
    entry = store.add(clean_input(en="WebUI", zh="网页管理界面"), "amy")
    changed = store.update(entry.id, clean_input(en="WebUI", zh="网页管理界面", category="Feature", variants=["Web UI"]), "ben")

    assert changed.id == entry.id
    assert changed.category == "Feature" and changed.variants == ("Web UI",)
    assert (changed.created_by, changed.updated_by) == ("amy", "ben")


def test_a_row_does_not_conflict_with_itself_when_updated(store):
    entry = store.add(clean_input(en="WebUI", zh="网页管理界面", variants=["Web UI"]), "amy")
    # Saving unchanged, or changing only the note, must not report "already exists".
    store.update(entry.id, clean_input(en="WebUI", zh="网页管理界面", variants=["Web UI"], note="new note"), "amy")
    # Changing the case of the English is fine too, since no other row uses the old spelling.
    assert store.update(entry.id, clean_input(en="WebUi", zh="网页管理界面"), "amy").en == "WebUi"


def test_a_failed_update_leaves_everything_as_it_was(store):
    first = store.add(clean_input(en="WebUI", zh="网页管理界面"), "amy")
    second = store.add(clean_input(en="Zyphor", zh="厂商"), "amy")
    with pytest.raises(Invalid):
        store.update(second.id, clean_input(en="WebUI", zh="网页管理界面"), "amy")  # would duplicate the first row

    assert [(entry.id, entry.en) for entry in store.entries()] == [(first.id, "WebUI"), (second.id, "Zyphor")]
    # The conflict indexes are intact: the second row's original content still counts as existing.
    with pytest.raises(Invalid):
        store.add(clean_input(en="Zyphor", zh="厂商"), "amy")


def test_delete_removes_the_row(store):
    entry = store.add(clean_input(en="WebUI"), "amy")
    store.delete(entry.id, "amy")
    assert store.entries() == []
    assert store.glossary.prompt_lines("Open the WebUI now.") == []
    # After deletion the same content can be added again.
    store.add(clean_input(en="WebUI"), "amy")


def test_updating_or_deleting_a_missing_row_says_so(store):
    with pytest.raises(NotFound):
        store.update(99, clean_input(en="WebUI"), "amy")
    with pytest.raises(NotFound):
        store.delete(99, "amy")


# ---------- Bulk import ----------


def test_preview_says_what_would_happen_without_writing(store):
    store.add(clean_input(en="WebUI", zh="网页管理界面"), "amy")
    rows = [
        row("WebUI", "网页管理界面"),  # exists, same content
        row("WebUI", "网页管理界面", category="Feature"),  # exists, different content
        row("Zyphor", "厂商"),  # new
        row("", "空的"),  # has a problem
    ]

    statuses = [result.status for result in store.classify(rows, update_existing=True)]
    assert statuses == ["same", "update", "new", "error"]
    # Add-only mode: the row with different details stays as it is.
    statuses = [result.status for result in store.classify(rows, update_existing=False)]
    assert statuses == ["same", "skip", "new", "error"]
    # A preview writes nothing.
    assert [entry.en for entry in store.entries()] == ["WebUI"]


def test_preview_finds_conflicts_inside_the_file(store):
    rows = [
        row("WebUI", "网页管理界面", variants=["Web UI"]),
        row("WebUI", "网页管理界面"),  # the same row as the previous one
        row("Web UI", "网页界面"),  # just registered as a wrong form above
        row("Webui", "管理页面"),  # same word, inconsistent spelling
    ]
    results = store.classify(rows, update_existing=False)
    assert [result.status for result in results] == ["new", "skip", "error", "error"]
    assert "wrong form" in results[2].messages[0]
    assert results[3].line == 4


def test_import_writes_the_good_rows_and_reports_the_rest(store):
    kept = store.add(clean_input(en="WebUI", zh="网页管理界面"), "amy")
    rows = [
        row("WebUI", "网页管理界面", category="Feature", variants=["Web UI"]),
        row("Zyphor Gateway", "网关", applies_to="8.0"),
        row("", "空的"),
    ]

    results = store.import_rows(rows, update_existing=True, by="ben")

    assert [result.status for result in results] == ["update", "new", "error"]
    entries = {entry.en: entry for entry in store.entries()}
    assert set(entries) == {"WebUI", "Zyphor Gateway"}
    assert entries["WebUI"].id == kept.id  # the existing row was updated, not a new one added
    assert (entries["WebUI"].created_by, entries["WebUI"].updated_by) == ("amy", "ben")
    assert entries["Zyphor Gateway"].created_by == "ben"
    assert store.glossary.prompt_lines("the Zyphor Gateway") == ["- Zyphor Gateway"]


def test_rows_with_an_id_update_exactly_that_row(store):
    # An exported sheet carries ids. Re-importing after fixing the English must update that row, not add one.
    entry = store.add(clean_input(en="Archivng Center", zh="归档中心"), "amy")

    results = store.import_rows([row("Archiving Center", "归档中心", id=entry.id)], update_existing=True, by="ben")

    assert [result.status for result in results] == ["update"]
    assert [(item.id, item.en) for item in store.entries()] == [(entry.id, "Archiving Center")]


def test_an_unknown_id_is_an_error_not_a_new_row(store):
    (result,) = store.import_rows([row("Zyphor", id=12345)], update_existing=True, by="ben")
    assert result.status == "error" and "no row with id 12345" in result.messages[0]
    assert store.entries() == []


def test_a_large_import_is_quick(store):
    rows = [row(f"Zyphor Unit{number}", f"单元{number}号", variants=[f"Zyfor Unit{number}"]) for number in range(3000)]
    results = store.import_rows(rows, update_existing=True, by="amy")
    assert all(result.status == "new" for result in results)
    assert len(store.entries()) == 3000
    # Imported again: everything is "no change".
    assert all(result.status == "same" for result in store.classify(rows, update_existing=True))


# ---------- Categories ----------


def test_categories_are_the_defaults_plus_the_ones_in_use(store):
    assert "Version" in DEFAULT_CATEGORIES  # the Version category is required
    store.add(clean_input(en="Zyphor", category="Vendor"), "amy")
    store.add(clean_input(en="ZX3.1.60", category="Version"), "amy")
    assert store.book.categories() == list(DEFAULT_CATEGORIES) + ["Vendor"]


# ---------- People and roles ----------


def test_people_start_as_viewers_and_keep_their_role(store):
    assert store.sign_in("hash-amy", "amy") == "viewer"
    store.set_role("hash-amy", "editor", by="root")
    # Again: the role is kept, and a changed alias is still the same person (identity is the key hash).
    assert store.sign_in("hash-amy", "amy-new-name") == "editor"
    assert store.role_of("hash-amy") == "editor"
    assert store.role_of("someone-who-never-came") == "viewer"
    (person,) = store.people()
    assert (person["alias"], person["role"]) == ("amy-new-name", "editor")


def test_roles_are_checked(store):
    store.sign_in("hash-amy", "amy")
    with pytest.raises(Invalid):
        store.set_role("hash-amy", "owner", by="root")
    with pytest.raises(NotFound):
        store.set_role("hash-nobody", "editor", by="root")


# ---------- Change log ----------


def test_every_change_is_logged_with_who_did_it(store):
    entry = store.add(clean_input(en="WebUI", zh="网页管理界面"), "amy")
    store.update(entry.id, clean_input(en="WebUI", zh="网页管理界面", note="x"), "ben")
    store.delete(entry.id, "cat")
    store.import_rows([row("Zyphor")], update_existing=True, by="dan")

    log = store.changes()
    assert [(item["action"], item["by"]) for item in log] == [("import", "dan"), ("delete", "cat"), ("update", "ben"), ("add", "amy")]
    # Before and after are both kept, so a wrong deletion can be re-entered from the log.
    assert log[1]["details"]["before"]["en"] == "WebUI"
    assert log[2]["details"]["after"]["note"] == "x"


# ---------- Accounts and session tokens ----------


def test_an_account_is_one_per_key_and_one_per_name(store):
    assert store.account_of("hash-amy") is None
    store.save_account("hash-amy", "Amy", "amy", "scrypt$one")
    assert store.account_of("hash-amy")["login"] == "Amy"
    assert store.account_by_login("amy")["key_hash"] == "hash-amy"

    # Saving again for the same person changes name and password; it does not add an account.
    store.save_account("hash-amy", "Amy W", "amy w", "scrypt$two")
    assert store.account_by_login("amy") is None
    assert store.account_of("hash-amy")["password_hash"] == "scrypt$two"
    assert store.logins() == {"hash-amy": "Amy W"}

    with pytest.raises(Invalid) as taken:
        store.save_account("hash-ben", "AMY W", "amy w", "scrypt$three")
    assert "already taken" in taken.value.messages[0]
    assert store.account_of("hash-ben") is None


def test_sessions_end_when_they_expire_or_are_deleted(store):
    store.create_session("hash-amy", "token-1", expires_at=2000, now=1000)
    store.create_session("hash-amy", "token-2", expires_at=3000, now=1000)
    store.create_session("hash-ben", "token-3", expires_at=3000, now=1000)
    assert store.session_owner("token-1", now=1500) == "hash-amy"
    assert store.session_owner("token-1", now=2000) is None  # at the second of expiry it no longer counts
    assert store.session_owner("never-issued", now=1500) is None

    store.delete_session("token-2")
    assert store.session_owner("token-2", now=1500) is None
    store.delete_sessions("hash-ben")
    assert store.session_owner("token-3", now=1500) is None


def test_expired_sessions_are_cleaned_up_when_a_new_one_is_made(store):
    store.create_session("hash-amy", "old", expires_at=2000, now=1000)
    store.create_session("hash-amy", "new", expires_at=9000, now=5000)
    with store.engine.connect() as connection:
        assert [row.token_hash for row in connection.execute(select(sessions_table))] == ["new"]


def test_deleting_an_account_takes_its_sessions_along(store):
    store.save_account("hash-amy", "Amy", "amy", "scrypt$one")
    store.create_session("hash-amy", "token-1", expires_at=2000, now=1000)
    store.delete_account("hash-amy")
    assert store.account_of("hash-amy") is None
    assert store.session_owner("token-1", now=1500) is None


def test_an_older_database_gets_the_new_tables_on_start(tmp_path):
    # A database created before password sign-in existed lacks the two tables. Startup must add them and leave the existing terms alone.
    url = f"sqlite+pysqlite:///{(tmp_path / 'glossary.db').as_posix()}"
    first = GlossaryStore(url)
    first.add(clean_input(en="WebUI"), "amy")
    with first.engine.begin() as connection:
        sessions_table.drop(connection)
        accounts_table.drop(connection)
    first.close()

    second = GlossaryStore(url)
    assert [entry.en for entry in second.entries()] == ["WebUI"]
    second.save_account("hash-amy", "Amy", "amy", "scrypt$one")
    second.create_session("hash-amy", "token-1", expires_at=2000, now=1000)
    assert second.session_owner("token-1", now=1500) == "hash-amy"
    second.close()


# ---------- Data survives ----------


def test_data_survives_a_restart(tmp_path):
    url = f"sqlite+pysqlite:///{(tmp_path / 'glossary.db').as_posix()}"
    first = GlossaryStore(url)
    first.add(clean_input(en="WebUI", zh="网页管理界面", variants=["Web UI"]), "amy")
    first.close()

    second = GlossaryStore(url)  # equivalent to a backend restart
    assert [(entry.en, entry.zh, entry.variants) for entry in second.entries()] == [("WebUI", "网页管理界面", ("Web UI",))]
    second.close()


# ---------- Conflict indexes ----------


def test_the_book_stays_consistent_when_rows_come_and_go():
    one = Entry(id=1, en="WebUI", zh="网页管理界面", variants=("Web UI",))
    two = Entry(id=2, en="WebUI", zh="管理页面", variants=("Web UI",))
    book = Book([one, two])

    book.remove(1)
    # Another row still uses WebUI and its wrong form, so both rules still apply.
    assert book.problems(clean_input(en="Webui"))
    assert book.problems(clean_input(en="Other", variants=["web ui"]))
    book.remove(2)
    assert book.problems(clean_input(en="Webui")) == []
    assert book.problems(clean_input(en="Other", variants=["web ui"])) == []
    assert book.remove(2) is None


# ---------- Production is Postgres: compile the statements for its dialect ----------


def test_tables_and_statements_compile_for_postgres():
    dialect = postgresql.dialect()
    for table in metadata.sorted_tables:
        ddl = str(CreateTable(table).compile(dialect=dialect))
        assert f"CREATE TABLE {table.name}" in ddl
    assert "SERIAL" in str(CreateTable(terms_table).compile(dialect=dialect))  # ids are assigned by the database

    statements = [
        select(terms_table).order_by(terms_table.c.id),
        insert(terms_table).values(zh="", en="x"),
        update(terms_table).where(terms_table.c.id == 1).values(en="y"),
        delete(terms_table).where(terms_table.c.id == 1),
        select(people_table).where(people_table.c.key_hash == "h"),
        select(changes_table).order_by(changes_table.c.id.desc()).limit(200),
        select(accounts_table).where(accounts_table.c.login_key == "amy"),
        insert(accounts_table).values(key_hash="h", login="Amy", login_key="amy", password_hash="x", created_at="t", updated_at="t"),
        update(accounts_table).where(accounts_table.c.key_hash == "h").values(password_hash="y"),
        insert(sessions_table).values(token_hash="t", key_hash="h", created_at="t", expires_at=1_900_000_000),
        select(sessions_table.c.key_hash, sessions_table.c.expires_at).where(sessions_table.c.token_hash == "t"),
        delete(sessions_table).where(sessions_table.c.expires_at <= 1_900_000_000),
    ]
    # The expiry is in seconds; after 2038 a plain integer column is too small, hence BIGINT.
    assert "expires_at BIGINT" in str(CreateTable(sessions_table).compile(dialect=dialect))
    assert "UNIQUE (login_key)" in str(CreateTable(accounts_table).compile(dialect=dialect))
    for statement in statements:
        assert str(statement.compile(dialect=dialect))

# ---------- A glossary for another language ----------


def test_a_store_follows_its_profile():
    from app.glossary_profile import make_profile

    made = GlossaryStore(profile=make_profile("Russian", "cyrillic", "Hardware"))
    try:
        assert made.book.categories() == ["Hardware"]
        with pytest.raises(Invalid) as error:
            made.add(clean_input(en="Политики"), "amy")
        assert "contains Russian characters" in str(error.value)
        made.add(clean_input(en="Policies", zh="Политики", category="Other"), "amy")
        assert made.book.categories() == ["Hardware", "Other"]
        found = made.glossary.filter_matches("Go to Политики and open the page.", [])
        assert [match.text for match in found] == ["Политики"]
    finally:
        made.close()