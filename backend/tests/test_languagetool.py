"""Format conversion: pure functions, no network."""

from app.languagetool import convert_matches
from app.textpos import utf16_len, utf16_slice
from tests.conftest import SAMPLE_TEXT


def test_utf16_slice_handles_emoji():
    # The emoji is 2 UTF-16 code units, so "This" starts at 3, not 2.
    assert utf16_slice(SAMPLE_TEXT, 3, 4) == "This"
    # For contrast: a plain Python slice is off by one, which is why utf16_slice exists.
    assert SAMPLE_TEXT[3:7] != "This"


def test_utf16_slice_plain_text():
    assert utf16_slice("Hello world", 6, 5) == "world"


def test_utf16_len():
    assert utf16_len("abc") == 3
    assert utf16_len("😀") == 2  # one emoji is 2 code units
    assert utf16_len("") == 0


def test_convert_real_response(lt_sample):
    matches = convert_matches(lt_sample, SAMPLE_TEXT)

    assert len(matches) == 2

    grammar, spelling = matches
    assert grammar.text == "This are"
    assert (grammar.offset, grammar.length) == (3, 8)
    assert grammar.rule_id == "PLURAL_VERB_AFTER_THIS"
    assert grammar.category == "GRAMMAR"
    assert grammar.issue_type == "grammar"
    assert grammar.replacements[0] == "These are"
    assert grammar.message  # the message is not empty

    assert spelling.text == "sentense"
    assert spelling.rule_id == "MORFOLOGIK_RULE_EN_US"
    assert spelling.issue_type == "misspelling"
    assert spelling.replacements[0] == "sentence"


def test_convert_tolerates_missing_optional_fields():
    # Only the essential fields. Missing ones must become empty values, not errors.
    minimal = {"matches": [{"offset": 0, "length": 3, "message": "msg", "rule": {"id": "X"}}]}
    (match,) = convert_matches(minimal, "abc def")

    assert match.text == "abc"
    assert match.replacements == []
    assert match.short_message == ""
    assert match.category == ""
    assert match.issue_type == ""


def test_convert_no_matches():
    assert convert_matches({"matches": []}, "All good.") == []
    assert convert_matches({}, "All good.") == []
