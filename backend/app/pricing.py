"""Cost: where a model's price comes from and how tokens become money.

Main source: the usage in the reply (token counts) times the unit price.
Cross-check: the amount LiteLLM reports in its response header.
Prices are not hard-coded. They are read from LiteLLM (/v1/model/info), so switching
models needs no code change and we use the same price table LiteLLM bills from.
"""

import logging
import time
from dataclasses import dataclass

import httpx

from app.schemas import Cost, Usage

logger = logging.getLogger("langfaix.pricing")

# Models from these providers count as self-hosted: no per-token billing, tokens only.
SELF_HOSTED_PROVIDERS = {"hosted_vllm", "vllm", "ollama", "ollama_chat", "lm_studio"}

# Cost headers from LiteLLM. Some versions omit the first when it equals the second, so read both.
COST_HEADERS = ("x-litellm-response-cost", "x-litellm-response-cost-original")


@dataclass(frozen=True)
class ModelPrice:
    # USD per token. None when LiteLLM has no price for the model.
    input_per_token: float | None
    output_per_token: float | None
    # Price of cached input tokens, usually lower than normal input.
    cached_input_per_token: float | None
    # Provider, e.g. openai or hosted_vllm.
    provider: str

    @property
    def self_hosted(self) -> bool:
        return self.provider in SELF_HOSTED_PROVIDERS

    @property
    def priced(self) -> bool:
        return self.input_per_token is not None and self.output_per_token is not None


class PriceCache:
    """Remember looked-up prices so LiteLLM is not asked again for a while."""

    def __init__(self, ttl_seconds: float = 600):
        self._ttl = ttl_seconds
        self._items: dict[str, tuple[float, ModelPrice]] = {}

    async def get(
        self, client: httpx.AsyncClient, litellm_url: str, model: str, authorization: str
    ) -> ModelPrice | None:
        """Price of a model, or None. Never raises: a missing price must not fail the rewrite."""
        cached = self._items.get(model)
        if cached and time.monotonic() - cached[0] < self._ttl:
            return cached[1]

        try:
            response = await client.get(f"{litellm_url}/v1/model/info", headers={"Authorization": authorization})
            response.raise_for_status()
            price = _find_price(response.json(), model)
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("could not read model price from LiteLLM: %s", exc)
            return None

        if price is not None:
            self._items[model] = (time.monotonic(), price)
        return price


def _find_price(payload: dict, model: str) -> ModelPrice | None:
    """Pick one model's price out of a /v1/model/info reply."""
    for item in payload.get("data", []):
        if item.get("model_name") != model:
            continue
        info = item.get("model_info") or {}
        return ModelPrice(
            input_per_token=_number(info.get("input_cost_per_token")),
            output_per_token=_number(info.get("output_cost_per_token")),
            cached_input_per_token=_number(info.get("cache_read_input_token_cost")),
            provider=str(info.get("litellm_provider") or ""),
        )
    return None


def _number(value) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def read_usage(payload: dict) -> Usage:
    """Token counts from the model's reply."""
    usage = payload.get("usage") or {}
    details = usage.get("prompt_tokens_details") or {}
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    return Usage(
        prompt_tokens=prompt,
        cached_tokens=int(details.get("cached_tokens") or 0),
        completion_tokens=completion,
        total_tokens=int(usage.get("total_tokens") or prompt + completion),
    )


def read_header_cost(headers) -> float | None:
    """The amount in LiteLLM's response headers, or None."""
    for name in COST_HEADERS:
        value = _number(headers.get(name))
        if value is not None:
            return value
    return None


def compute_cost(usage: Usage, price: ModelPrice | None, header_cost: float | None) -> Cost:
    """Cost of one call, in USD."""
    self_hosted = bool(price and price.self_hosted)
    usd = None
    source = None

    if self_hosted:
        # Self-hosted models have no per-token billing: no amount.
        pass
    elif price and price.priced:
        # Cached input tokens are billed at the discounted price, the rest at the normal price.
        fresh = max(usage.prompt_tokens - usage.cached_tokens, 0)
        cached_price = price.cached_input_per_token
        if cached_price is None:
            cached_price = price.input_per_token  # no cache discount for this model
        usd = (
            fresh * price.input_per_token
            + usage.cached_tokens * cached_price
            + usage.completion_tokens * price.output_per_token
        )
        source = "usage"
        # Cross-check: log a warning when LiteLLM's figure differs by more than 5%.
        if header_cost and abs(usd - header_cost) > 0.05 * header_cost:
            logger.warning("cost mismatch: computed %.8f USD, LiteLLM reported %.8f USD", usd, header_cost)
    elif header_cost is not None:
        # No unit price: fall back to the amount LiteLLM reported.
        usd = header_cost
        source = "litellm"

    return Cost(usd=usd, source=source, litellm_usd=header_cost, self_hosted=self_hosted)
