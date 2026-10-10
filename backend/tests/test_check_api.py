"""The /check endpoint, from the HTTP request in to the HTTP response out."""

from urllib.parse import parse_qs

import httpx

from app.textpos import utf16_slice
from tests.conftest import SAMPLE_TEXT, lt_spelling, sentence_ranges


def test_healthz(make_client):
    client = make_client(lambda request: httpx.Response(500))
    assert client.get("/healthz").json() == {"status": "ok", "glossary_terms": 0, "glossary_storage": "ok"}


def test_healthz_reports_how_many_glossary_terms_were_loaded(make_client):
    # Used after deploying to confirm the settings were read. Counts only; the terms are not exposed.
    client = make_client(lambda request: httpx.Response(500), terms=["WebUI", "Zyphor", "Zyphor Gateway"])
    body = client.get("/healthz").json()
    assert body == {"status": "ok", "glossary_terms": 3, "glossary_storage": "ok"}
    assert "Zyphor" not in str(body)


def test_check_drops_spelling_matches_for_glossary_terms(make_client):
    text = "Open the WebUI of the Zyphor box and fix the trafic rule."
    reply = {
        "matches": [
            lt_spelling(text, "WebUI", ("Web UI",)),
            lt_spelling(text, "Zyphor", ("Zephyr",)),
            lt_spelling(text, "trafic", ("traffic",)),
        ]
    }
    fake_lt = lambda request: httpx.Response(200, json=reply)  # noqa: E731

    # No glossary: all three are reported.
    plain = make_client(fake_lt).post("/check", json={"text": text}).json()
    assert [m["text"] for m in plain["matches"]] == ["WebUI", "Zyphor", "trafic"]

    # With a glossary: terms are no longer reported, the real typo still is.
    with_glossary = make_client(fake_lt, terms=["WebUI", "Zyphor"]).post("/check", json={"text": text}).json()
    assert [m["text"] for m in with_glossary["matches"]] == ["trafic"]
    assert with_glossary["matches"][0]["replacements"] == ["traffic"]


def test_check_suggests_the_glossary_form_for_wrong_capitalization(make_client):
    text = "Open the webui now."
    reply = {"matches": [lt_spelling(text, "webui", ("web", "Weber"))]}
    client = make_client(lambda request: httpx.Response(200, json=reply), terms=["WebUI"])

    (match,) = client.post("/check", json={"text": text}).json()["matches"]

    assert match["text"] == "webui"
    assert match["replacements"] == ["WebUI"]
    assert utf16_slice(text, match["offset"], match["length"]) == "webui"


def test_check_returns_unified_format(make_client, lt_sample):
    seen = []

    def fake_lt(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=lt_sample)

    client = make_client(fake_lt)
    response = client.post("/check", json={"text": SAMPLE_TEXT, "language": "en-US"})

    assert response.status_code == 200
    body = response.json()
    assert body["language"] == "en-US"
    assert [m["text"] for m in body["matches"]] == ["This are", "sentense"]
    assert set(body["matches"][0]) == {
        "offset", "length", "text", "message", "short_message",
        "replacements", "rule_id", "rule_description", "category", "issue_type",
    }

    # The request we sent to LanguageTool: URL, method, form content.
    (sent,) = seen
    assert sent.method == "POST"
    assert str(sent.url) == "http://lt.test/v2/check"
    form = parse_qs(sent.content.decode("utf-8"))
    assert form == {"text": [SAMPLE_TEXT], "language": ["en-US"]}


def test_check_language_defaults_to_en_us(make_client, lt_sample):
    seen = []

    def fake_lt(request: httpx.Request) -> httpx.Response:
        seen.append(parse_qs(request.content.decode("utf-8")))
        return httpx.Response(200, json=lt_sample)

    client = make_client(fake_lt)
    assert client.post("/check", json={"text": "Hello."}).status_code == 200
    assert seen[0]["language"] == ["en-US"]


def test_check_blank_text_skips_languagetool(make_client):
    calls = []

    def fake_lt(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"matches": []})

    client = make_client(fake_lt)
    response = client.post("/check", json={"text": "   "})

    assert response.status_code == 200
    assert response.json() == {"language": "en-US", "matches": [], "sentences": []}
    assert calls == []  # LanguageTool was not called


def test_check_rejects_too_long_text(make_client):
    client = make_client(lambda request: httpx.Response(200, json={"matches": []}), max_text_chars=10)
    response = client.post("/check", json={"text": "x" * 11})
    assert response.status_code == 413


def test_check_requires_text_field(make_client):
    client = make_client(lambda request: httpx.Response(200, json={"matches": []}))
    assert client.post("/check", json={"language": "en-US"}).status_code == 422


def test_check_when_languagetool_is_down(make_client):
    def fake_lt(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = make_client(fake_lt)
    response = client.post("/check", json={"text": "Hello."})

    assert response.status_code == 502
    assert "LanguageTool" in response.json()["detail"]


def test_check_when_languagetool_returns_server_error(make_client):
    client = make_client(lambda request: httpx.Response(500, text="boom"))
    assert client.post("/check", json={"text": "Hello."}).status_code == 502


def test_check_passes_on_languagetool_rejection(make_client):
    # LanguageTool answers an unknown language code with 400 and a sentence; we pass both on.
    message = "Error: 'xx-YY' is not a language code known to LanguageTool."
    client = make_client(lambda request: httpx.Response(400, text=message))
    response = client.post("/check", json={"text": "Hello.", "language": "xx-YY"})

    assert response.status_code == 400
    assert response.json()["detail"] == message


def test_docs_page_uses_public_prefix(make_client):
    # Deployed under /api, the docs page fetches /api/openapi.json. Without the prefix the
    # page opens but stays blank.
    client = make_client(lambda request: httpx.Response(200, json={"matches": []}), root_path="/api")
    page = client.get("/docs")

    assert page.status_code == 200
    assert "/api/openapi.json" in page.text
    assert "/check" in client.get("/openapi.json").json()["paths"]


def test_check_returns_sentence_ranges(make_client, lt_sample):
    # In the real LanguageTool reply this sentence spans 0 to 28 (the emoji is 2 code units).
    client = make_client(lambda request: httpx.Response(200, json=lt_sample))
    body = client.post("/check", json={"text": SAMPLE_TEXT}).json()

    assert body["sentences"] == [{"offset": 0, "length": 28}]
    only = body["sentences"][0]
    assert utf16_slice(SAMPLE_TEXT, only["offset"], only["length"]) == SAMPLE_TEXT


def test_check_sentences_match_what_ai_improve_would_use(make_client):
    # Several sentences with line breaks. /check must report exactly the sentences /ai/improve
    # splits, or a front end would send one sentence that the AI side treats as two.
    text = "First one here. Second one, e.g. with 10.2.4 inside!\n- bullet item one\n- bullet item two."
    parts = ["First one here.", "Second one, e.g. with 10.2.4 inside!", "- bullet item one\n- bullet item two."]
    reply = {"matches": [], "sentenceRanges": sentence_ranges(text, parts)}
    client = make_client(lambda request: httpx.Response(200, json=reply))

    body = client.post("/check", json={"text": text}).json()

    found = [utf16_slice(text, s["offset"], s["length"]) for s in body["sentences"]]
    # LanguageTool treats the two list items as one sentence; we split at the line break, hence 4.
    assert found == ["First one here.", "Second one, e.g. with 10.2.4 inside!", "- bullet item one", "- bullet item two."]


def test_check_without_sentence_ranges_still_works(make_client):
    # An old LanguageTool gives no sentence ranges: fall back to splitting at line breaks.
    client = make_client(lambda request: httpx.Response(200, json={"matches": []}))
    body = client.post("/check", json={"text": "One. Two.\nThree."}).json()
    assert [(s["offset"], s["length"]) for s in body["sentences"]] == [(0, 9), (10, 6)]
