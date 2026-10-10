"""Handling the model's answer: parsing the JSON and locating each edit in the sentence."""

import json

import pytest

from app.edits import FENCE, locate_edits, parse_edits
from app.sentences import Sentence
from app.textpos import utf16_len, utf16_slice


def sentence(text: str, offset: int = 0) -> Sentence:
    return Sentence(offset=offset, length=utf16_len(text), text=text)


def edit(original: str, replacement: str, reason: str = "r") -> dict:
    return {"original": original, "replacement": replacement, "reason": reason}


# ---------- Parsing ----------


def test_parse_normal_json():
    content = json.dumps({"edits": [edit("teh", "the", "Spelling.")]})
    assert parse_edits(content) == [{"original": "teh", "replacement": "the", "reason": "Spelling."}]


def test_parse_empty_list_means_no_change():
    assert parse_edits('{"edits": []}') == []


def test_parse_strips_code_fence():
    # Some models wrap the JSON in a code fence.
    content = FENCE + "json\n" + json.dumps({"edits": [edit("a", "b")]}) + "\n" + FENCE
    assert parse_edits(content)[0]["original"] == "a"


def test_parse_missing_reason_becomes_empty():
    assert parse_edits('{"edits": [{"original": "a", "replacement": "b"}]}')[0]["reason"] == ""


@pytest.mark.parametrize(
    "content",
    [
        "",
        "Sure! Here is the corrected sentence.",
        "[1, 2, 3]",
        '{"changes": []}',
        '{"edits": "none"}',
        '{"edits": ["not an object"]}',
        '{"edits": [{"original": "a"}]}',
        '{"edits": [{"original": 1, "replacement": "b"}]}',
    ],
)
def test_parse_rejects_bad_output(content):
    with pytest.raises(ValueError):
        parse_edits(content)


# ---------- Locating ----------


def test_locate_simple():
    s = sentence("It supports user authentication in conjunction with LDAP.")
    edits, dropped = locate_edits(s, [edit("in conjunction with", "together with")])

    assert dropped == 0
    (e,) = edits
    assert (e.offset, e.length) == (32, 19)
    assert utf16_slice(s.text, e.offset, e.length) == "in conjunction with"
    assert e.replacement == "together with"


def test_locate_adds_sentence_offset():
    # The sentence starts at 100 in the whole text; positions must include that.
    s = sentence("This are fine.", offset=100)
    (e,), _ = locate_edits(s, [edit("are", "is")])
    assert e.offset == 105


def test_locate_counts_utf16_after_emoji():
    s = sentence("\U0001F600 This are fine.", offset=10)
    (e,), _ = locate_edits(s, [edit("are", "is")])

    # Emoji 2 code units + space + "This " 5 = 8, plus the sentence start 10.
    assert e.offset == 18
    assert utf16_slice(s.text, e.offset - 10, e.length) == "are"


def test_locate_repeated_word_follows_order():
    # "the" occurs twice. Two edits listed in order must hit the first and the second.
    s = sentence("Open the page and click the button.")
    edits, dropped = locate_edits(s, [edit("the", "this"), edit("the", "that")])

    assert dropped == 0
    assert [e.offset for e in edits] == [5, 24]
    assert [e.replacement for e in edits] == ["this", "that"]


def test_locate_out_of_order_edits_are_sorted():
    # Edits listed out of order are still found, and returned sorted by position.
    s = sentence("Alpha beta gamma.")
    edits, dropped = locate_edits(s, [edit("gamma", "GAMMA"), edit("Alpha", "ALPHA")])

    assert dropped == 0
    assert [e.original for e in edits] == ["Alpha", "gamma"]


def test_locate_drops_text_not_in_sentence():
    # The model miscopied the original (a case difference counts): dropped, not guessed.
    s = sentence("The server blocks traffic.")
    edits, dropped = locate_edits(s, [edit("Server", "gateway"), edit("blocks", "block")])

    assert [e.original for e in edits] == ["blocks"]
    assert dropped == 1


def test_locate_drops_no_op_and_empty():
    s = sentence("Nothing to change here.")
    edits, dropped = locate_edits(s, [edit("change", "change"), edit("", "extra")])

    assert edits == []
    assert dropped == 2


def test_locate_drops_overlapping_edit():
    s = sentence("in conjunction with the server")
    edits, dropped = locate_edits(s, [edit("in conjunction with", "with"), edit("conjunction", "combination")])

    assert [e.original for e in edits] == ["in conjunction with"]
    assert dropped == 1


def test_locate_deletion():
    s = sentence("This is is a test.")
    (e,), _ = locate_edits(s, [edit("is is", "is")])
    # "is is" also matches from position 2 (the end of This plus the next is), but that cuts
    # This in half; the whole-word match at position 5 is the right one.
    assert (e.offset, e.length, e.replacement) == (5, 5, "is")


def test_locate_prefers_whole_word_over_part_of_another_word():
    s = sentence("This is wrong.")
    (e,), _ = locate_edits(s, [edit("is", "was")])
    # The first "is" hides inside This; the standalone one must be chosen.
    assert e.offset == 5


def test_locate_accepts_part_of_a_word_when_nothing_else_matches():
    # The model changes part of a word, e.g. drops a suffix. It must be found even though no match stands alone.
    s = sentence("The settings are configurated here.")
    (e,), dropped = locate_edits(s, [edit("urated", "ured")])
    assert dropped == 0
    assert utf16_slice(s.text, e.offset, e.length) == "urated"


def test_locate_keeps_punctuation_edits():
    # A fragment that starts or ends with punctuation cannot cut a word.
    s = sentence("Click Save , then close the window.")
    (e,), _ = locate_edits(s, [edit("Save ,", "Save,")])
    assert e.offset == 6
