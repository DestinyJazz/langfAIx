"""Ask the model, through LiteLLM, to check one sentence.

One call per sentence, so each sentence's token count and cost are real, not estimated.
"""

from dataclasses import dataclass

import httpx

from app.config import Settings
from app.pricing import read_header_cost, read_usage
from app.prompt import RESPONSE_FORMAT, build_messages
from app.schemas import Usage


class LLMRejected(Exception):
    """LiteLLM refused the request (4xx): bad key, budget used up, no access to the model.

    Another sentence would fail the same way, so the whole request stops.
    """

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class LLMFailed(Exception):
    """This call failed for a reason unrelated to the request: network, timeout, upstream
    error, malformed reply. Other sentences may still work, so only this one is marked failed.
    """


@dataclass(frozen=True)
class LLMReply:
    # The model's reply; expected to be JSON.
    content: str
    usage: Usage
    # Cost reported in LiteLLM's response header, or None.
    header_cost: float | None


async def ask_model(
    client: httpx.AsyncClient,
    settings: Settings,
    authorization: str,
    sentence: str,
    glossary_lines: list[str] | None = None,
    language: str = "English",
    source_name: str = "Chinese",
) -> LLMReply:
    """Send one sentence to the model. Returns its raw answer, token usage and header cost.

    glossary_lines: the glossary terms found in this sentence, already phrased for the model.
    language: English name of the language the sentence is written in; it decides the prompt.
    source_name: the glossary's source language, empty if it has none (see prompt.glossary_note).
    """
    body = {
        "model": settings.ai_model,
        "messages": build_messages(
            sentence, glossary_lines, language, settings.ai_prompt_domain, settings.ai_prompt_extra, source_name
        ),
        "response_format": RESPONSE_FORMAT,
        # No streaming: LiteLLM does not return the cost header on streamed responses.
    }
    try:
        response = await client.post(
            f"{settings.litellm_url}/v1/chat/completions",
            json=body,
            # The caller's virtual key is passed through; LiteLLM validates it, bills it and enforces the budget.
            headers={"Authorization": authorization},
            timeout=settings.ai_timeout_seconds,
        )
    except httpx.TimeoutException as exc:
        raise LLMFailed("the model did not answer in time") from exc
    except httpx.HTTPError as exc:
        raise LLMFailed(f"cannot reach LiteLLM: {exc.__class__.__name__}") from exc

    if 400 <= response.status_code < 500:
        raise LLMRejected(response.status_code, _error_message(response))
    if response.status_code >= 500:
        raise LLMFailed(f"LiteLLM returned HTTP {response.status_code}: {_error_message(response)}")

    try:
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise LLMFailed("unexpected response format from LiteLLM") from exc

    return LLMReply(
        content=content or "",
        usage=read_usage(payload),
        header_cost=read_header_cost(response.headers),
    )


def _error_message(response: httpx.Response) -> str:
    """The human-readable message from a LiteLLM error response."""
    try:
        error = response.json().get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])[:500]
        if isinstance(error, str):
            return error[:500]
    except (ValueError, AttributeError):
        pass
    return response.text.strip()[:500] or f"HTTP {response.status_code}"
