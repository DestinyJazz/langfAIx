"""Handle the model's suggested edits: parse its reply, then locate each edit in the sentence."""

import json

from app.schemas import Edit
from app.sentences import Sentence
from app.textpos import utf16_len

FENCE = chr(96) * 3  # three backticks, the code-fence marker


def parse_edits(content: str) -> list[dict]:
    """Parse the model's reply into [{original, replacement, reason}, ...].

    Raises ValueError on a malformed reply; the caller marks that sentence as failed.
    """
    text = (content or "").strip()
    # Some models (self-hosted ones especially) wrap the JSON in a code fence anyway.
    if text.startswith(FENCE):
        text = text.strip(chr(96)).strip()
        if text[:4].lower() == "json":
            text = text[4:].strip()

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("model did not return valid JSON") from exc

    if not isinstance(data, dict) or not isinstance(data.get("edits"), list):
        raise ValueError("model JSON has no edits list")

    result = []
    for item in data["edits"]:
        if not isinstance(item, dict):
            raise ValueError("an edit is not an object")
        original, replacement = item.get("original"), item.get("replacement")
        if not isinstance(original, str) or not isinstance(replacement, str):
            raise ValueError("an edit is missing original or replacement")
        reason = item.get("reason")
        result.append(
            {"original": original, "replacement": replacement, "reason": reason if isinstance(reason, str) else ""}
        )
    return result


def locate_edits(sentence: Sentence, raw_edits: list[dict], allowed=None) -> tuple[list[Edit], int]:
    """Find where each edit sits in the sentence. Returns (located edits, number dropped).

    The model's `original` fragment is searched for as a string. An edit is dropped when it
    cannot be applied safely:
      - the fragment is empty (nowhere to insert)
      - original and replacement are identical
      - the fragment is not in the sentence (the model miscopied it)
      - its position overlaps an earlier edit
      - `allowed` rejects it (for example it changes a glossary term)

    allowed: optional function (sentence, position, original, replacement) -> bool.
    """
    taken: list[tuple[int, int]] = []  # ranges already used, in Python characters
    located: list[tuple[int, Edit]] = []
    dropped = 0
    cursor = 0  # edits should come in order, so search after the previous one first

    for raw in raw_edits:
        original, replacement = raw["original"], raw["replacement"]
        if not original or original == replacement:
            dropped += 1
            continue

        position = _find(sentence.text, original, cursor, taken)
        if position == -1:
            # Not found after the previous edit: the model may have listed them out of order.
            position = _find(sentence.text, original, 0, taken)
        if position == -1:
            dropped += 1
            continue
        if allowed is not None and not allowed(sentence.text, position, original, replacement):
            dropped += 1
            continue

        taken.append((position, position + len(original)))
        cursor = position + len(original)
        edit = Edit(
            # Sentence offset plus the fragment's position inside the sentence.
            offset=sentence.offset + utf16_len(sentence.text[:position]),
            length=utf16_len(original),
            original=original,
            replacement=replacement,
            reason=raw.get("reason", ""),
        )
        located.append((position, edit))

    located.sort(key=lambda pair: pair[0])
    return [edit for _, edit in located], dropped


def _overlaps(start: int, end: int, taken: list[tuple[int, int]]) -> bool:
    return any(start < taken_end and taken_start < end for taken_start, taken_end in taken)


def _find(text: str, needle: str, start: int, taken: list[tuple[int, int]]) -> int:
    """Position of needle at or after start, skipping used ranges; -1 if absent.

    Prefers a match that stands alone as a word. Searching "This is wrong." for "is" first
    hits the inside of "This", which is not what the model meant. A match inside another
    word is returned only when there is no standalone one.
    """
    inside_a_word = -1
    position = text.find(needle, start)
    while position != -1:
        end = position + len(needle)
        if not _overlaps(position, end, taken):
            if _stands_alone(text, position, end):
                return position
            if inside_a_word == -1:
                inside_a_word = position
        position = text.find(needle, position + 1)
    return inside_a_word


def _is_word_char(char: str) -> bool:
    return char.isalnum() or char == "_"


def _stands_alone(text: str, start: int, end: int) -> bool:
    """True if both ends fall on word boundaries, i.e. no word is cut in half."""
    cut_at_start = start > 0 and _is_word_char(text[start - 1]) and _is_word_char(text[start])
    cut_at_end = end < len(text) and _is_word_char(text[end - 1]) and _is_word_char(text[end])
    return not cut_at_start and not cut_at_end
