"""Shared fixtures.

Tests never reach a real LanguageTool or LiteLLM. They use httpx's MockTransport: no
network, each request is answered by a function we write. So the tests run anywhere,
fast, with fixed results and at no cost.
"""

import hashlib
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.textpos import utf16_len

FIXTURES = Path(__file__).parent / "fixtures"

# The text that goes with fixtures/lt_response.json. It starts with an emoji on purpose, to test position conversion.
SAMPLE_TEXT = "\U0001F600 This are a test sentense."

LT_URL = "http://lt.test"
LLM_URL = "http://llm.test"


@pytest.fixture
def lt_sample() -> dict:
    """A real LanguageTool reply, fetched from LanguageTool's public API for SAMPLE_TEXT."""
    return json.loads((FIXTURES / "lt_response.json").read_text(encoding="utf-8"))


@pytest.fixture
def make_client():
    """Returns a function: give it the fake services' behaviour, get a test client back.

    handler receives every request the backend sends out (to LanguageTool and to LiteLLM)
    and decides the reply. The other arguments override settings.

    terms: rows to put in the glossary first. Each is an English string, or a dict with
    Chinese, wrong forms and so on. The glossary is an in-memory SQLite, one per test.
    """
    clients = []

    def _make(handler, terms=None, **overrides) -> TestClient:
        values = {
            "languagetool_url": LT_URL,
            "max_text_chars": 20000,
            "lt_timeout_seconds": 5,
            "litellm_url": LLM_URL,
            "ai_model": "test-model",
        }
        values.update(overrides)
        app = create_app(settings=Settings(**values), transport=httpx.MockTransport(handler))
        client = TestClient(app)
        client.__enter__()  # startup (and the shared HTTP client) only runs inside the context
        clients.append(client)
        if terms:
            rows = [{"en": term} if isinstance(term, str) else dict(term) for term in terms]
            results = app.state.glossary.store.import_rows(rows, update_existing=True, by="test")
            problems = [result.messages for result in results if result.status != "new"]
            assert not problems, f"could not put the test terms into the glossary: {problems}"
        return client

    yield _make
    for client in clients:
        client.__exit__(None, None, None)


def sentence_ranges(text: str, sentences: list[str]) -> list[list[int]]:
    """The sentence ranges LanguageTool would give: start and end of each sentence in text (UTF-16)."""
    ranges = []
    cursor = 0
    for sentence in sentences:
        position = text.index(sentence, cursor)
        start = utf16_len(text[:position])
        ranges.append([start, start + utf16_len(sentence)])
        cursor = position + len(sentence)
    return ranges


# The backend's own LiteLLM admin key in tests.
ADMIN_KEY = "sk-master-for-tests"


class FakeKeys:
    """A fake LiteLLM that only answers "whose key is this", plus a fake LanguageTool that reports nothing.

    It behaves like LiteLLM v1.103.3, partly observed on a deployment, partly confirmed in its source:
      - a key handed to users may only call models; asking /key/info with itself gives 403 (observed)
      - an admin key can look up any key by hash: /key/info?key=<hash> (source)
      - an unknown key gives 404 (source)
      - asking with an unknown key gives 401 (observed)

    keys maps key -> alias. With restricted False the keys are default-type and can look themselves up.
    """

    def __init__(self, keys: dict[str, str], lt_reply: dict | None = None, restricted: bool = True):
        self.keys = keys
        self.by_hash = {hashlib.sha256(key.encode()).hexdigest(): alias for key, alias in keys.items()}
        self.lt_reply = lt_reply or {"matches": []}
        self.restricted = restricted
        self.requests: list[httpx.Request] = []

    @staticmethod
    def _info(alias: str) -> httpx.Response:
        info = {"key_alias": alias, "status": "active", "blocked": None, "expires": None, "metadata": {}, "spend": 0.0, "user_id": "default_user_id"}
        return httpx.Response(200, json={"key": "...", "info": info})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/key/info" and str(request.url).startswith(LLM_URL):
            self.requests.append(request)
            caller = request.headers.get("authorization", "").removeprefix("Bearer ")
            wanted = request.url.params.get("key")
            if caller == ADMIN_KEY:
                if wanted in self.by_hash:
                    return self._info(self.by_hash[wanted])
                error = {"message": "Key not found in database", "type": "not_found_error", "param": "key", "code": "404"}
                return httpx.Response(404, json={"error": error})
            if caller in self.keys:
                if self.restricted:
                    detail = "Virtual key is not allowed to call this route. Only allowed to call routes: ['llm_api_routes']. Tried to call route: /key/info"
                    return httpx.Response(403, json={"detail": detail})
                return self._info(self.keys[caller])
            error = {"message": "Authentication Error, Invalid proxy server token passed.", "type": "token_not_found_in_db", "param": "key", "code": "401"}
            return httpx.Response(401, json={"error": error})
        if str(request.url) == f"{LT_URL}/v2/check":
            return httpx.Response(200, json=self.lt_reply)
        raise AssertionError(f"unexpected request to {request.url}")


def lt_spelling(text: str, word: str, replacements: tuple[str, ...] = ()) -> dict:
    """A LanguageTool-format result saying that word is misspelled, shaped like a real reply."""
    position = text.index(word)
    return {
        "message": "Possible spelling mistake found.",
        "shortMessage": "Spelling mistake",
        "replacements": [{"value": value} for value in replacements],
        "offset": utf16_len(text[:position]),
        "length": utf16_len(word),
        "rule": {
            "id": "MORFOLOGIK_RULE_EN_US",
            "description": "Possible spelling mistake",
            "issueType": "misspelling",
            "category": {"id": "TYPOS", "name": "Possible Typo"},
        },
    }


def llm_reply(edits: list[dict], prompt_tokens=400, cached_tokens=0, completion_tokens=20, cost=None, content=None):
    """A fake LiteLLM reply, shaped like a real /v1/chat/completions reply.

    cost goes into the x-litellm-response-cost header. content simulates a malformed answer.
    """
    body = {
        "model": "test-model",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": content if content is not None else json.dumps({"edits": edits}),
                },
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
            "prompt_tokens_details": {"cached_tokens": cached_tokens},
        },
    }
    headers = {} if cost is None else {"x-litellm-response-cost": str(cost)}
    return httpx.Response(200, json=body, headers=headers)


def model_info(input_price=0.4e-6, output_price=1.6e-6, cached_price=0.1e-6, provider="openai", name="test-model"):
    """A fake /v1/model/info reply. Default prices per million tokens: input 0.40, cached 0.10, output 1.60 USD."""
    return httpx.Response(
        200,
        json={
            "data": [
                {
                    "model_name": name,
                    "litellm_params": {"model": f"{provider}/{name}"},
                    "model_info": {
                        "input_cost_per_token": input_price,
                        "output_cost_per_token": output_price,
                        "cache_read_input_token_cost": cached_price,
                        "litellm_provider": provider,
                    },
                }
            ]
        },
    )
