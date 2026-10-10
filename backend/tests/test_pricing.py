"""Cost calculation."""

import httpx
import pytest

from app.pricing import ModelPrice, _find_price, compute_cost, read_header_cost, read_usage
from app.schemas import Usage

# Per million tokens: input 0.40 USD, cached input 0.10 USD, output 1.60 USD.
PRICE = ModelPrice(input_per_token=0.4e-6, output_per_token=1.6e-6, cached_input_per_token=0.1e-6, provider="openai")


def usage(prompt=410, cached=300, completion=110) -> Usage:
    return Usage(prompt_tokens=prompt, cached_tokens=cached, completion_tokens=completion, total_tokens=prompt + completion)


def test_cost_from_usage_with_cached_tokens():
    cost = compute_cost(usage(), PRICE, header_cost=None)

    # 300 of the 410 input tokens are cached:
    # 110 at the normal price  110 x 0.40 / 1,000,000 = 0.000044
    # 300 at the cached price  300 x 0.10 / 1,000,000 = 0.000030
    # 110 output               110 x 1.60 / 1,000,000 = 0.000176
    assert cost.usd == pytest.approx(0.000250)
    assert cost.source == "usage"
    assert cost.self_hosted is False


def test_cost_without_cache_discount_uses_input_price():
    price = ModelPrice(input_per_token=0.4e-6, output_per_token=1.6e-6, cached_input_per_token=None, provider="openai")
    cost = compute_cost(usage(), price, None)
    # No cache discount: all 410 input tokens at the normal price.
    assert cost.usd == pytest.approx(410 * 0.4e-6 + 110 * 1.6e-6)


def test_header_cost_is_reported_for_cross_check():
    cost = compute_cost(usage(), PRICE, header_cost=0.00025)
    # Our own figure stays the primary one; LiteLLM's is carried alongside.
    assert cost.source == "usage"
    assert cost.litellm_usd == 0.00025


def test_falls_back_to_header_when_price_unknown():
    cost = compute_cost(usage(), None, header_cost=0.0003)
    assert cost.usd == 0.0003
    assert cost.source == "litellm"


def test_no_price_and_no_header_gives_empty_cost():
    cost = compute_cost(usage(), None, None)
    assert cost.usd is None and cost.source is None


def test_self_hosted_model_shows_no_money():
    price = ModelPrice(input_per_token=None, output_per_token=None, cached_input_per_token=None, provider="hosted_vllm")
    # Even when LiteLLM reports an amount (usually 0), a self-hosted model shows no money.
    cost = compute_cost(usage(), price, header_cost=0.0)

    assert cost.self_hosted is True
    assert cost.usd is None


def test_read_usage_from_openai_style_response():
    payload = {
        "usage": {
            "prompt_tokens": 410,
            "completion_tokens": 110,
            "total_tokens": 520,
            "prompt_tokens_details": {"cached_tokens": 300},
        }
    }
    assert read_usage(payload) == Usage(prompt_tokens=410, cached_tokens=300, completion_tokens=110, total_tokens=520)


def test_read_usage_tolerates_missing_details():
    # Replies from self-hosted models often have no prompt_tokens_details.
    result = read_usage({"usage": {"prompt_tokens": 50, "completion_tokens": 5}})
    assert (result.cached_tokens, result.total_tokens) == (0, 55)
    assert read_usage({}) == Usage()


def test_read_header_cost_prefers_main_header():
    headers = httpx.Headers({"x-litellm-response-cost": "0.0002", "x-litellm-response-cost-original": "0.0009"})
    assert read_header_cost(headers) == 0.0002


def test_read_header_cost_falls_back_to_original():
    # Some LiteLLM versions omit the first header and send only the second.
    assert read_header_cost(httpx.Headers({"x-litellm-response-cost-original": "0.0009"})) == 0.0009


def test_read_header_cost_missing_or_not_a_number():
    assert read_header_cost(httpx.Headers({})) is None
    assert read_header_cost(httpx.Headers({"x-litellm-response-cost": "None"})) is None


def test_find_price_in_model_info():
    payload = {
        "data": [
            {"model_name": "other", "model_info": {"input_cost_per_token": 1, "output_cost_per_token": 1}},
            {
                "model_name": "gpt-4.1-mini",
                "model_info": {
                    "input_cost_per_token": 4e-07,
                    "output_cost_per_token": 1.6e-06,
                    "cache_read_input_token_cost": 1e-07,
                    "litellm_provider": "openai",
                },
            },
        ]
    }
    assert _find_price(payload, "gpt-4.1-mini") == PRICE
    assert _find_price(payload, "missing") is None
