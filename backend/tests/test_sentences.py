"""Sentence splitting from the ranges LanguageTool reports."""

from app.sentences import sentences_from_ranges
from app.textpos import utf16_slice

# This text and the ranges below are what LanguageTool's public API really returned.
# Note that the periods in "e.g." and in the version "10.2.4" do not end a sentence.
REAL_TEXT = (
    "First sentence here. Second one, e.g. with version 10.2.4 inside!  Is this the third?\n"
    "A new line without a period\n"
    "\n"
    "- bullet item one\n"
    "- bullet item two. Then more."
)
REAL_RANGES = [[0, 20], [21, 65], [67, 85], [86, 113], [115, 151], [152, 162]]


def test_real_languagetool_ranges():
    sentences = sentences_from_ranges(REAL_TEXT, REAL_RANGES)

    assert [s.text for s in sentences] == [
        "First sentence here.",
        "Second one, e.g. with version 10.2.4 inside!",
        "Is this the third?",
        "A new line without a period",
        # LanguageTool treats the two list items as one sentence; we split at the line break.
        "- bullet item one",
        "- bullet item two.",
        "Then more.",
    ]


def test_positions_point_back_to_the_original_text():
    # Slicing the original text at each reported position must give exactly that sentence.
    for s in sentences_from_ranges(REAL_TEXT, REAL_RANGES):
        assert utf16_slice(REAL_TEXT, s.offset, s.length) == s.text


def test_positions_after_an_emoji():
    text = "\U0001F600 One here. Two here."
    # The emoji is 2 code units, so the first sentence is 12 long and the second starts at 13.
    # Counting Python characters would put it at 12, one off.
    sentences = sentences_from_ranges(text, [[0, 12], [13, 22]])

    assert [(s.offset, s.text) for s in sentences] == [(0, "\U0001F600 One here."), (13, "Two here.")]
    for s in sentences:
        assert utf16_slice(text, s.offset, s.length) == s.text


def test_surrounding_whitespace_is_trimmed():
    text = "  Hello there.  \n   Second line.  "
    sentences = sentences_from_ranges(text, [[0, len(text)]])

    assert [(s.offset, s.length, s.text) for s in sentences] == [(2, 12, "Hello there."), (20, 12, "Second line.")]


def test_windows_line_endings():
    text = "Line one.\r\nLine two."
    sentences = sentences_from_ranges(text, [[0, len(text)]])

    assert [s.text for s in sentences] == ["Line one.", "Line two."]
    assert utf16_slice(text, sentences[1].offset, sentences[1].length) == "Line two."


def test_without_ranges_falls_back_to_lines():
    # An old LanguageTool gives no sentence ranges: fall back to splitting at line breaks.
    sentences = sentences_from_ranges("One. Two.\nThree.", None)
    assert [s.text for s in sentences] == ["One. Two.", "Three."]


def test_bad_ranges_are_ignored():
    text = "Good sentence."
    ranges = [[0, 14], [5, 2], [0, 999], ["x", "y"], [3]]
    assert [s.text for s in sentences_from_ranges(text, ranges)] == ["Good sentence."]


def test_blank_text_gives_no_sentences():
    assert sentences_from_ranges("   \n  ", None) == []
