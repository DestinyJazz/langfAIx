"""The /ai/improve endpoint, from the HTTP request in to the HTTP response out.

LanguageTool and LiteLLM are fakes, defined by each test, so a test controls exactly
what the model answers.
"""

import json

import httpx
import pytest

from app.prompt import DEFAULT_DOMAIN, SYSTEM_PROMPT
from app.textpos import utf16_slice
from tests.conftest import LLM_URL, LT_URL, llm_reply, model_info, sentence_ranges

KEY = {"Authorization": "Bearer sk-user-key"}

TEXT = "It supports user authentication in conjunction with LDAP. Earlier versions do not support this."
SENTENCES = [
    "It supports user authentication in conjunction with LDAP.",
    "Earlier versions do not support this.",
]


class FakeServices:
    """Fake LanguageTool and LiteLLM.

    answers maps sentence -> what the model returns for it (an httpx.Response, or an
    exception to raise). Every request received is recorded for the test to inspect.
    """

    def __init__(self, text: str, sentences: list[str], answers: dict, info=None):
        self.ranges = sentence_ranges(text, sentences)
        self.answers = answers
        self.info = info if info is not None else model_info()
        self.llm_requests: list[httpx.Request] = []
        self.info_requests: list[httpx.Request] = []
        self.lt_requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == f"{LT_URL}/v2/check":
            self.lt_requests.append(request)
            return httpx.Response(200, json={"matches": [], "sentenceRanges": self.ranges})
        if url == f"{LLM_URL}/v1/model/info":
            self.info_requests.append(request)
            return self.info
        if url == f"{LLM_URL}/v1/chat/completions":
            self.llm_requests.append(request)
            sentence = json.loads(request.content)["messages"][-1]["content"]
            answer = self.answers[sentence]
            if isinstance(answer, Exception):
                raise answer
            return answer
        raise AssertionError(f"unexpected request to {url}")


def test_two_sentences_one_changed_one_unchanged(make_client):
    services = FakeServices(
        TEXT,
        SENTENCES,
        {
            SENTENCES[0]: llm_reply(
                [{"original": "in conjunction with", "replacement": "together with", "reason": "Simpler wording."}],
                prompt_tokens=410,
                cached_tokens=0,
                completion_tokens=110,
                cost=0.00034,
            ),
            SENTENCES[1]: llm_reply([], prompt_tokens=410, cached_tokens=300, completion_tokens=10, cost=0.00009),
        },
    )
    client = make_client(services)

    response = client.post("/ai/improve", json={"text": TEXT}, headers=KEY)

    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "test-model"
    first, second = body["sentences"]

    # First sentence: one edit.
    assert first["status"] == "changed"
    assert first["text"] == SENTENCES[0]
    (edit,) = first["edits"]
    assert edit["original"] == "in conjunction with"
    assert edit["replacement"] == "together with"
    assert edit["reason"] == "Simpler wording."
    # Slicing the original text at the edit's position gives the original fragment.
    assert utf16_slice(TEXT, edit["offset"], edit["length"]) == "in conjunction with"
    assert first["usage"] == {"prompt_tokens": 410, "cached_tokens": 0, "completion_tokens": 110, "total_tokens": 520}
    # 410 x 0.40 + 110 x 1.60, in USD per million tokens.
    assert first["cost"]["usd"] == pytest.approx(410 * 0.4e-6 + 110 * 1.6e-6)
    assert first["cost"]["source"] == "usage"
    # USD only; no other currency.
    assert set(first["cost"]) == {"usd", "source", "litellm_usd", "self_hosted"}
    assert first["cost"]["litellm_usd"] == 0.00034

    # Second sentence: no change needed, but it was paid for, so usage and cost are present.
    assert second["status"] == "unchanged"
    assert second["edits"] == []
    assert second["usage"]["cached_tokens"] == 300
    assert second["cost"]["usd"] == pytest.approx(110 * 0.4e-6 + 300 * 0.1e-6 + 10 * 1.6e-6)
    assert utf16_slice(TEXT, second["offset"], second["length"]) == SENTENCES[1]


def test_request_sent_to_litellm(make_client):
    services = FakeServices(TEXT, SENTENCES, {s: llm_reply([]) for s in SENTENCES})
    client = make_client(services)

    client.post("/ai/improve", json={"text": TEXT}, headers=KEY)

    # One call per sentence.
    assert len(services.llm_requests) == 2
    for request, sentence in zip(services.llm_requests, SENTENCES):
        # The caller's key is passed to LiteLLM as is.
        assert request.headers["authorization"] == "Bearer sk-user-key"
        sent = json.loads(request.content)
        assert sent["model"] == "test-model"
        # Fixed prompt first, the sentence last (for prompt caching).
        assert [m["role"] for m in sent["messages"]] == ["system", "user"]
        assert sent["messages"][-1]["content"] == sentence
        assert sent["response_format"]["type"] == "json_schema"
        # No streaming.
        assert "stream" not in sent

    # Both sentences use the identical system prompt.
    systems = {json.loads(r.content)["messages"][0]["content"] for r in services.llm_requests}
    assert len(systems) == 1

    # The price is looked up once, here with the caller's key.
    assert len(services.info_requests) == 1
    assert services.info_requests[0].headers["authorization"] == "Bearer sk-user-key"


def test_missing_key_is_rejected_before_any_call(make_client):
    services = FakeServices(TEXT, SENTENCES, {})
    client = make_client(services)

    response = client.post("/ai/improve", json={"text": TEXT})

    assert response.status_code == 401
    # Without a key nothing happens, not even sentence splitting.
    assert services.lt_requests == [] and services.llm_requests == []


def test_invalid_key_stops_after_first_sentence(make_client):
    rejected = httpx.Response(401, json={"error": {"message": "Authentication Error, Invalid proxy server token passed"}})
    services = FakeServices(TEXT, SENTENCES, {s: rejected for s in SENTENCES})
    client = make_client(services)

    response = client.post("/ai/improve", json={"text": TEXT}, headers=KEY)

    assert response.status_code == 401
    assert "Invalid proxy server token" in response.json()["detail"]
    # Stopped after the first sentence was rejected: no second sentence, no price lookup.
    assert len(services.llm_requests) == 1
    assert services.info_requests == []


def test_budget_exceeded_is_passed_to_caller(make_client):
    rejected = httpx.Response(
        400, json={"error": {"message": "Budget has been exceeded! Current cost: 1.02, Max budget: 1.0"}}
    )
    services = FakeServices(TEXT, SENTENCES, {s: rejected for s in SENTENCES})
    client = make_client(services)

    response = client.post("/ai/improve", json={"text": TEXT}, headers=KEY)

    assert response.status_code == 400
    assert "Budget has been exceeded" in response.json()["detail"]


def test_one_sentence_fails_others_still_returned(make_client):
    services = FakeServices(
        TEXT,
        SENTENCES,
        {
            SENTENCES[0]: llm_reply([{"original": "supports", "replacement": "provides", "reason": "r"}]),
            SENTENCES[1]: httpx.ConnectError("connection reset"),
        },
    )
    client = make_client(services)

    response = client.post("/ai/improve", json={"text": TEXT}, headers=KEY)

    assert response.status_code == 200
    first, second = response.json()["sentences"]
    assert first["status"] == "changed"
    assert second["status"] == "error"
    assert "LiteLLM" in second["error"]
    # The call failed: no usage and no cost.
    assert second["usage"] is None and second["cost"] is None


def test_unparseable_answer_still_reports_cost(make_client):
    # The model answered with something that is not JSON. The sentence fails, but the money is spent: usage and cost are still reported.
    services = FakeServices(
        TEXT,
        SENTENCES,
        {
            SENTENCES[0]: llm_reply([], content="Sure! The sentence looks fine.", prompt_tokens=400, completion_tokens=8),
            SENTENCES[1]: llm_reply([]),
        },
    )
    client = make_client(services)

    first, second = client.post("/ai/improve", json={"text": TEXT}, headers=KEY).json()["sentences"]

    assert first["status"] == "error"
    assert "valid JSON" in first["error"]
    assert first["usage"]["prompt_tokens"] == 400
    assert first["cost"]["usd"] == pytest.approx(400 * 0.4e-6 + 8 * 1.6e-6)
    assert second["status"] == "unchanged"


def test_edit_that_cannot_be_located_is_dropped(make_client):
    services = FakeServices(
        TEXT,
        SENTENCES,
        {
            SENTENCES[0]: llm_reply([{"original": "not in the sentence", "replacement": "x", "reason": "r"}]),
            SENTENCES[1]: llm_reply([]),
        },
    )
    client = make_client(services)

    first, _ = client.post("/ai/improve", json={"text": TEXT}, headers=KEY).json()["sentences"]

    assert first["status"] == "unchanged"
    assert first["edits"] == []
    assert first["dropped_edits"] == 1


def test_price_lookup_failure_falls_back_to_litellm_cost(make_client):
    services = FakeServices(
        TEXT, SENTENCES, {s: llm_reply([], cost=0.0002) for s in SENTENCES}, info=httpx.Response(500, text="boom")
    )
    client = make_client(services)

    first, _ = client.post("/ai/improve", json={"text": TEXT}, headers=KEY).json()["sentences"]

    assert first["cost"]["usd"] == 0.0002
    assert first["cost"]["source"] == "litellm"


def test_self_hosted_model_reports_tokens_only(make_client):
    services = FakeServices(
        TEXT,
        SENTENCES,
        {s: llm_reply([], cost=0.0) for s in SENTENCES},
        info=model_info(input_price=None, output_price=None, cached_price=None, provider="hosted_vllm"),
    )
    client = make_client(services)

    first, _ = client.post("/ai/improve", json={"text": TEXT}, headers=KEY).json()["sentences"]

    assert first["usage"]["prompt_tokens"] == 400
    assert first["cost"]["self_hosted"] is True
    assert first["cost"]["usd"] is None


def test_blank_text_costs_nothing(make_client):
    services = FakeServices("", [], {})
    client = make_client(services)

    response = client.post("/ai/improve", json={"text": "  \n "}, headers=KEY)

    assert response.status_code == 200
    assert response.json()["sentences"] == []
    assert services.lt_requests == [] and services.llm_requests == []


def test_text_too_long(make_client):
    services = FakeServices("", [], {})
    client = make_client(services, ai_max_text_chars=20)

    response = client.post("/ai/improve", json={"text": "x" * 21}, headers=KEY)

    assert response.status_code == 413
    assert services.llm_requests == []


def test_too_many_sentences(make_client):
    services = FakeServices(TEXT, SENTENCES, {s: llm_reply([]) for s in SENTENCES})
    client = make_client(services, ai_max_sentences=1)

    response = client.post("/ai/improve", json={"text": TEXT}, headers=KEY)

    assert response.status_code == 413
    assert "2 sentences" in response.json()["detail"]
    # Over the limit nothing is done at all, not just the first few sentences.
    assert services.llm_requests == []


def test_languagetool_down_means_no_ai_call(make_client):
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url).startswith(LT_URL):
            raise httpx.ConnectError("refused")
        raise AssertionError("LiteLLM must not be called when sentence splitting failed")

    client = make_client(handler)
    assert client.post("/ai/improve", json={"text": TEXT}, headers=KEY).status_code == 502


def test_sentence_order_is_kept_with_many_sentences(make_client):
    sentences = [f"Sentence number {i} is here." for i in range(12)]
    text = " ".join(sentences)
    services = FakeServices(text, sentences, {s: llm_reply([]) for s in sentences})
    client = make_client(services, ai_concurrency=3)

    body = client.post("/ai/improve", json={"text": text}, headers=KEY).json()

    assert [s["text"] for s in body["sentences"]] == sentences
    assert len(services.llm_requests) == 12
    # The first sentence goes alone, so it is always the first request sent.
    assert json.loads(services.llm_requests[0].content)["messages"][-1]["content"] == sentences[0]


# ---------- Team glossary ----------
# The terms in the examples are made up.

GLOSSARY_TEXT = "The WebUI of the Zyphor Gateway dont load. Earlier versions work fine."
GLOSSARY_SENTENCES = ["The WebUI of the Zyphor Gateway dont load.", "Earlier versions work fine."]


def system_prompt_of(request: httpx.Request) -> str:
    return json.loads(request.content)["messages"][0]["content"]


def test_only_the_glossary_terms_in_a_sentence_go_into_its_prompt(make_client):
    services = FakeServices(GLOSSARY_TEXT, GLOSSARY_SENTENCES, {s: llm_reply([]) for s in GLOSSARY_SENTENCES})
    client = make_client(services, terms=["FlowGuard", "WebUI", "Zyphor Gateway"])

    client.post("/ai/improve", json={"text": GLOSSARY_TEXT}, headers=KEY)

    first, second = (system_prompt_of(request) for request in services.llm_requests)
    # Two terms in the first sentence: the fixed prompt comes first unchanged (for caching), then the two terms.
    assert first.startswith(SYSTEM_PROMPT)
    assert first[len(SYSTEM_PROMPT) :].strip().startswith("Glossary.")
    assert first.endswith("- WebUI\n- Zyphor Gateway\n")
    # Glossary terms not in this sentence are left out, so no prompt money is wasted.
    assert "FlowGuard" not in first
    # No term in the second sentence: the prompt is identical to having no glossary.
    assert second == SYSTEM_PROMPT
    # The sentence itself is still alone in the final user message.
    for request, sentence in zip(services.llm_requests, GLOSSARY_SENTENCES):
        assert json.loads(request.content)["messages"][-1] == {"role": "user", "content": sentence}


def test_without_a_glossary_the_prompt_is_the_fixed_one(make_client):
    services = FakeServices(GLOSSARY_TEXT, GLOSSARY_SENTENCES, {s: llm_reply([]) for s in GLOSSARY_SENTENCES})
    client = make_client(services)

    client.post("/ai/improve", json={"text": GLOSSARY_TEXT}, headers=KEY)

    assert [system_prompt_of(request) for request in services.llm_requests] == [SYSTEM_PROMPT, SYSTEM_PROMPT]


def test_the_domain_and_the_style_notes_of_a_deployment_go_into_the_prompt(make_client):
    services = FakeServices(GLOSSARY_TEXT, GLOSSARY_SENTENCES, {s: llm_reply([]) for s in GLOSSARY_SENTENCES})
    client = make_client(services, ai_prompt_domain="legal contracts", ai_prompt_extra="Use British spelling.")

    client.post("/ai/improve", json={"text": GLOSSARY_TEXT}, headers=KEY)

    for request in services.llm_requests:
        prompt = system_prompt_of(request)
        assert prompt.startswith("You are a careful copy editor for legal contracts.")
        assert DEFAULT_DOMAIN not in prompt
        # The rules the parser depends on are still all there, and the notes come after them.
        assert SYSTEM_PROMPT.split("\n\n", 1)[1] in prompt
        assert prompt.rstrip().endswith("Use British spelling.")


def test_an_unset_domain_and_empty_notes_leave_the_prompt_exactly_as_it_was():
    from app.prompt import system_prompt

    assert system_prompt() == SYSTEM_PROMPT
    assert system_prompt(domain="  ", extra="   \n") == SYSTEM_PROMPT
    assert f"copy editor for {DEFAULT_DOMAIN}." in SYSTEM_PROMPT


def test_an_edit_that_changes_a_glossary_term_is_dropped(make_client):
    # The model disobeys and "corrects" a term. That edit is dropped; the others are used.
    answer = llm_reply(
        [
            {"original": "WebUI", "replacement": "Web UI", "reason": "Two words."},
            {"original": "Gateway", "replacement": "gateway", "reason": "Lower case."},
            {"original": "dont", "replacement": "does not", "reason": "Missing apostrophe."},
        ]
    )
    services = FakeServices(GLOSSARY_TEXT, GLOSSARY_SENTENCES, {GLOSSARY_SENTENCES[0]: answer, GLOSSARY_SENTENCES[1]: llm_reply([])})
    client = make_client(services, terms=["WebUI", "Zyphor Gateway"])

    first = client.post("/ai/improve", json={"text": GLOSSARY_TEXT}, headers=KEY).json()["sentences"][0]

    assert first["status"] == "changed"
    assert [(edit["original"], edit["replacement"]) for edit in first["edits"]] == [("dont", "does not")]
    assert first["dropped_edits"] == 2
    # The money is spent: usage and cost are still reported.
    assert first["usage"]["prompt_tokens"] == 400


def test_when_every_edit_touches_a_term_the_sentence_counts_as_unchanged(make_client):
    answer = llm_reply([{"original": "WebUI", "replacement": "web interface", "reason": "Clearer."}])
    services = FakeServices(GLOSSARY_TEXT, GLOSSARY_SENTENCES, {GLOSSARY_SENTENCES[0]: answer, GLOSSARY_SENTENCES[1]: llm_reply([])})
    client = make_client(services, terms=["WebUI"])

    first = client.post("/ai/improve", json={"text": GLOSSARY_TEXT}, headers=KEY).json()["sentences"][0]

    assert first["status"] == "unchanged"
    assert first["edits"] == []
    assert first["dropped_edits"] == 1


def test_with_the_glossary_switched_off_the_model_is_told_nothing_and_nothing_is_guarded(make_client):
    # Glossary turned off by the user: the prompt mentions no terms and edits to terms are not blocked.
    answer = llm_reply([{"original": "WebUI", "replacement": "Web UI", "reason": "Two words."}])
    services = FakeServices(GLOSSARY_TEXT, GLOSSARY_SENTENCES, {GLOSSARY_SENTENCES[0]: answer, GLOSSARY_SENTENCES[1]: llm_reply([])})
    client = make_client(services, terms=["WebUI", "Zyphor Gateway"])

    first = client.post("/ai/improve", json={"text": GLOSSARY_TEXT, "glossary": False}, headers=KEY).json()["sentences"][0]

    assert [system_prompt_of(request) for request in services.llm_requests] == [SYSTEM_PROMPT, SYSTEM_PROMPT]
    assert [(edit["original"], edit["replacement"]) for edit in first["edits"]] == [("WebUI", "Web UI")]
    assert first["dropped_edits"] == 0


# ---------- Whose key looks up the price ----------


def test_prices_are_looked_up_with_the_server_key_when_there_is_one(make_client):
    # A user's key may only call models and cannot read model info, so the backend looks the price up with its own admin key.
    services = FakeServices(TEXT, SENTENCES, {s: llm_reply([]) for s in SENTENCES})
    client = make_client(services, litellm_admin_key="sk-master-for-tests")

    client.post("/ai/improve", json={"text": TEXT}, headers=KEY)

    assert [request.headers["authorization"] for request in services.info_requests] == ["Bearer sk-master-for-tests"]
    # The model call itself still uses the caller's key: the spend and the budget are theirs.
    assert {request.headers["authorization"] for request in services.llm_requests} == {"Bearer sk-user-key"}


def test_without_a_server_key_prices_are_looked_up_with_the_users_key(make_client):
    services = FakeServices(TEXT, SENTENCES, {s: llm_reply([]) for s in SENTENCES})
    client = make_client(services)

    client.post("/ai/improve", json={"text": TEXT}, headers=KEY)

    assert [request.headers["authorization"] for request in services.info_requests] == ["Bearer sk-user-key"]


def test_a_refused_price_lookup_still_gives_a_cost(make_client):
    # Without an admin key, the caller's key gets 403 on model info. The rewrite must not
    # fail for that: the amount falls back to the one in LiteLLM's response header.
    refused = httpx.Response(403, json={"detail": "Virtual key is not allowed to call this route."})
    services = FakeServices(TEXT, SENTENCES, {s: llm_reply([], cost=0.00021) for s in SENTENCES}, info=refused)
    client = make_client(services)

    first = client.post("/ai/improve", json={"text": TEXT}, headers=KEY).json()["sentences"][0]

    assert first["cost"]["usd"] == 0.00021
    assert first["cost"]["source"] == "litellm"
