"""Split text into sentences.

We use the sentenceRanges in LanguageTool's reply instead of our own rules. Sentence
splitting is full of exceptions: the periods in e.g., in a version such as 10.2.4 and in
config.yaml do not end a sentence. LanguageTool already handles these.
"""

from dataclasses import dataclass

from app.textpos import utf16_len, utf16_slice


@dataclass(frozen=True)
class Sentence:
    # Position in the whole text, in UTF-16 code units.
    offset: int
    length: int
    text: str


# Punctuation that ends a sentence. Semicolons and colons do not: what follows is the same sentence.
_ENDS = "。！？!?…"
# Closing marks that may follow the end punctuation and still belong to the sentence.
_CLOSERS = "”’」』）)】》"


def _ends_sentence(piece: str) -> bool:
    """Whether this piece ends a sentence."""
    tail = piece.rstrip().rstrip(_CLOSERS + "\"'")
    if not tail:
        return False
    if tail[-1] in _ENDS:
        return True
    # A Latin full stop ends a sentence only after a letter ("sentence."). After a digit it
    # is most likely a list number ("1.") or part of a version.
    return tail[-1] == "." and len(tail) > 1 and (tail[-2].isalpha())


def _merge_clauses(text: str, ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Join the small pieces LanguageTool makes of Chinese text back into sentences.

    LanguageTool 6.8 splits Chinese at commas and spaces: a sentence with one comma becomes
    two pieces, and every English word inside Chinese text becomes a piece of its own. Sent
    to the model like that, each piece lacks its context and is billed separately. So
    neighbouring pieces are joined until one ends with end punctuation. Closing quotes,
    closing brackets and a repeated full stop at the start of the next piece go to the
    sentence before.
    """
    merged: list[list[int]] = []
    open_start = None  # where the sentence being joined starts; None: the last one is finished
    last_end = 0
    for start, end in ranges:
        piece = utf16_slice(text, start, end - start)
        if open_start is None and merged and start == merged[-1][1]:
            # The previous sentence just ended: closing marks at the start of this piece are still its.
            lead = len(piece) - len(piece.lstrip(_CLOSERS + _ENDS))
            if lead:
                shift = utf16_len(piece[:lead])
                merged[-1][1] += shift
                start += shift
                piece = piece[lead:]
        if not piece.strip():
            if open_start is None and merged:
                merged[-1][1] = end  # whitespace only: give it to the previous sentence, it is trimmed later
            last_end = end
            continue
        if open_start is None:
            open_start = start
        last_end = end
        if _ends_sentence(piece):
            merged.append([open_start, end])
            open_start = None
    if open_start is not None:
        merged.append([open_start, last_end])
    return [(start, end) for start, end in merged if end > start]


def sentences_from_ranges(text: str, ranges: list | None, merge_clauses: bool = False) -> list[Sentence]:
    """Cut out the sentences LanguageTool reported, then:

    1. With merge_clauses (Chinese), first join pieces that were cut too small, see _merge_clauses.
    2. Split again at line breaks. LanguageTool treats consecutive list items as one
       sentence, but to the user each line is separate.
    3. Trim whitespace and drop empty pieces.
    """
    total = utf16_len(text)
    if not ranges:
        # Old LanguageTool versions have no sentenceRanges: treat the text as one sentence (still split at line breaks).
        ranges = [[0, total]]

    valid: list[tuple[int, int]] = []
    for item in ranges:
        try:
            start, end = int(item[0]), int(item[1])
        except (TypeError, ValueError, IndexError):
            continue  # malformed range
        if not 0 <= start < end <= total:
            continue
        valid.append((start, end))
    if merge_clauses:
        valid = _merge_clauses(text, valid)

    result = []
    for start, end in valid:
        position = start  # where the current line starts in the whole text
        for line in utf16_slice(text, start, end - start).split("\n"):
            stripped = line.strip()
            if stripped:
                # Leading whitespace was trimmed, so the position moves forward by that much.
                leading = utf16_len(line[: len(line) - len(line.lstrip())])
                result.append(Sentence(offset=position + leading, length=utf16_len(stripped), text=stripped))
            position += utf16_len(line) + 1  # +1 for the line break
    return result
