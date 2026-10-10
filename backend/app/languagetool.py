"""Talk to LanguageTool: send the request and convert its reply to our own format."""

import httpx

from app.schemas import Match
from app.textpos import utf16_slice


class LanguageToolUnavailable(Exception):
    """LanguageTool is unreachable or returned a server error."""


class LanguageToolRejected(Exception):
    """LanguageTool rejected the request, for example an unknown language code."""


def convert_matches(lt_json: dict, text: str) -> list[Match]:
    """Convert the matches in a LanguageTool reply to our Match list.

    Fields are read with .get() and defaults because not every rule has every field.
    """
    result = []
    for m in lt_json.get("matches", []):
        rule = m.get("rule") or {}
        category = rule.get("category") or {}
        offset = int(m["offset"])
        length = int(m["length"])
        result.append(
            Match(
                offset=offset,
                length=length,
                text=utf16_slice(text, offset, length),
                message=m.get("message", ""),
                short_message=m.get("shortMessage", ""),
                replacements=[r["value"] for r in m.get("replacements", []) if "value" in r],
                rule_id=rule.get("id", ""),
                rule_description=rule.get("description", ""),
                category=category.get("id", ""),
                issue_type=rule.get("issueType", ""),
            )
        )
    return result


async def check_text(client: httpx.AsyncClient, base_url: str, text: str, language: str) -> dict:
    """Call LanguageTool's /v2/check and return its raw JSON."""
    try:
        # LanguageTool expects form data, not JSON.
        response = await client.post(f"{base_url}/v2/check", data={"text": text, "language": language})
    except httpx.HTTPError as exc:
        raise LanguageToolUnavailable(f"cannot reach LanguageTool: {exc.__class__.__name__}") from exc

    if 400 <= response.status_code < 500:
        # 4xx means the request itself is wrong. LanguageTool explains in plain text; pass it on.
        raise LanguageToolRejected(response.text.strip()[:300])
    if response.status_code >= 500:
        raise LanguageToolUnavailable(f"LanguageTool returned HTTP {response.status_code}")
    return response.json()


def language_code(lt_json: dict, asked: str) -> str:
    """The language code LanguageTool actually used; the one asked for if it does not say."""
    return str((lt_json.get("language") or {}).get("code") or asked)


def is_chinese(code: str) -> bool:
    return code.lower().startswith("zh")


def language_name(lt_json: dict) -> str:
    """English name of the text's language, for the AI prompt: English, German, Chinese.

    Taken from LanguageTool's reply without the region in brackets ("English (US)" becomes
    "English"), so every language LanguageTool supports has a name and the backend keeps no
    table of its own. A missing or odd name (too long, unexpected characters) counts as
    English: the name goes into the prompt, so it must not be able to carry a sentence.
    """
    name = str((lt_json.get("language") or {}).get("name") or "").split("(")[0].strip()
    if not name or len(name) > 40 or not all(char.isalpha() or char in " -" for char in name):
        return "English"
    return name
