"""Text position conversion.

Every position this project reports (offset, length) is in UTF-16 code units, because
that is how LanguageTool and JavaScript count. Python counts characters, which differs
by one for each emoji-like character, so all positions go through here.
"""


def utf16_len(text: str) -> int:
    """Number of UTF-16 code units in the text."""
    return len(text.encode("utf-16-le")) // 2  # 2 bytes per code unit


def utf16_slice(text: str, offset: int, length: int) -> str:
    """Slice text by UTF-16 code units.

    text[offset:offset + length] would be wrong: an emoji is 2 code units in UTF-16 but 1
    character in Python, so every position after one would be off.
    """
    data = text.encode("utf-16-le")
    return data[offset * 2 : (offset + length) * 2].decode("utf-16-le", errors="replace")
