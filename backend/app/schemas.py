"""Request and response schemas.

The front ends (Word add-in, browser extension) only know these formats, never
LanguageTool's raw format. LanguageTool could be replaced without touching them.
"""

from typing import Literal

from pydantic import BaseModel, Field


class CheckRequest(BaseModel):
    text: str
    # Language code, e.g. en-US or en-GB.
    language: str = "en-US"
    # Use the team glossary (default). When false, this check behaves as if there were no
    # glossary: terms are reported as misspellings again, and wrong forms and stray Chinese
    # are not flagged.
    glossary: bool = True


class Match(BaseModel):
    """One issue."""

    # Start and length in UTF-16 code units, the same as JavaScript string indexes, so a
    # front end can write text.slice(offset, offset + length).
    offset: int
    length: int
    # The flagged text, so a front end can verify the position.
    text: str
    # Message for the user, and a short version that may be empty.
    message: str
    short_message: str = ""
    # Suggested replacements, most likely first. May be empty.
    replacements: list[str] = Field(default_factory=list)
    # Rule id, e.g. MORFOLOGIK_RULE_EN_US.
    rule_id: str
    rule_description: str = ""
    # Category, e.g. GRAMMAR, TYPOS, PUNCTUATION.
    category: str = ""
    # Issue type, e.g. misspelling, grammar, style, terminology.
    issue_type: str = ""


class SentenceRange(BaseModel):
    """Where one sentence sits in the text. UTF-16 code units, like Match."""

    offset: int
    length: int


class CheckResponse(BaseModel):
    # The language code LanguageTool actually used.
    language: str
    matches: list[Match]
    # The sentences the text was split into, in order. A front end uses them to find the
    # sentence an issue belongs to, so an AI rewrite can send just that sentence. LanguageTool
    # does the splitting as a by-product, at no cost.
    sentences: list[SentenceRange] = Field(default_factory=list)


# ---------- AI rewriting (/ai/improve) ----------


class ImproveRequest(BaseModel):
    # The text the user chose: one sentence or several.
    text: str
    # Only used to split sentences.
    language: str = "en-US"
    # Use the team glossary (default). When false, the model is not told about terms and its
    # edits to terms are not blocked.
    glossary: bool = True


class Edit(BaseModel):
    """One edit suggested by the model."""

    # Relative to the whole request text, in UTF-16 code units.
    offset: int
    length: int
    # An empty replacement means delete.
    original: str
    replacement: str
    reason: str = ""


class Usage(BaseModel):
    """Tokens used by one AI call."""

    # All input tokens, cached ones included.
    prompt_tokens: int = 0
    # The cached part, billed at a discount.
    cached_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class Cost(BaseModel):
    """What one AI call cost."""

    # USD. None when it cannot be computed (a self-hosted model has no unit price).
    usd: float | None = None
    # Where usd came from:
    #   usage    token counts times unit price (preferred)
    #   litellm  no unit price, so the amount from LiteLLM's response header
    source: Literal["usage", "litellm"] | None = None
    # The amount in LiteLLM's response header, kept for cross-checking. May be None.
    litellm_usd: float | None = None
    # Self-hosted model (e.g. vLLM): front ends show tokens only, no amount.
    self_hosted: bool = False


class SentenceResult(BaseModel):
    """Result for one sentence. One sentence is one AI call and one card in the front end."""

    # Position within the request text.
    offset: int
    length: int
    text: str
    # changed    the model suggested edits
    # unchanged  the model checked it and nothing needs changing (still paid for, so usage and cost are set)
    # error      the call for this sentence failed; see error
    status: Literal["changed", "unchanged", "error"]
    edits: list[Edit] = Field(default_factory=list)
    # Edits the model gave that we dropped: fragment not found, or nothing actually changed.
    dropped_edits: int = 0
    usage: Usage | None = None
    cost: Cost | None = None
    error: str | None = None


class ImproveResponse(BaseModel):
    model: str
    # In text order.
    sentences: list[SentenceResult]
