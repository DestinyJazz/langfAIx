"""The glossary matching engine, without HTTP and without a database.

All terms in the examples are made up (Zyphor is a vendor that does not exist).
"""

import time

from app.glossary import CATEGORY, ISSUE_TYPE, RULE_ID, Entry, Glossary, en_key, tidy, zh_key
from app.glossary_profile import DEFAULT_CATEGORIES, make_profile
from app.schemas import Match
from app.textpos import utf16_len, utf16_slice


def glossary(*rows) -> Glossary:
    """Build a glossary from rows. A row is an English string, or a dict with the other fields."""
    entries = []
    for number, row in enumerate(rows, start=1):
        values = {"en": row} if isinstance(row, str) else dict(row)
        values["variants"] = tuple(values.get("variants", ()))
        entries.append(Entry(id=number, **values))
    return Glossary(entries)


def spelling(text: str, word: str, occurrence: int = 0, **extra) -> Match:
    """A result saying LanguageTool considers word misspelled. occurrence: which occurrence (0-based)."""
    position = -1
    for _ in range(occurrence + 1):
        position = text.index(word, position + 1)
    values = {
        "offset": utf16_len(text[:position]),
        "length": utf16_len(word),
        "text": word,
        "message": "Possible spelling mistake found.",
        "replacements": ["guess one", "guess two"],
        "rule_id": "MORFOLOGIK_RULE_EN_US",
        "category": "TYPOS",
        "issue_type": "misspelling",
    }
    values.update(extra)
    return Match(**values)


def texts(matches: list[Match]) -> list[str]:
    return [match.text for match in matches]


def ours(matches: list[Match]) -> list[Match]:
    """Only the issues the glossary generated itself."""
    return [match for match in matches if match.rule_id == RULE_ID]


# ---------- Tidying text ----------


def test_keys_ignore_case_width_and_extra_spaces():
    assert tidy("  Zyphor   Gateway ") == "Zyphor Gateway"
    assert en_key("  WebUI ") == en_key("webui") == en_key("ＷｅｂＵＩ")  # full-width letters
    assert zh_key(" 归档 中心 ") == zh_key("归档中心")


# ---------- A term is not a misspelling ----------


def test_a_glossary_term_is_not_a_spelling_mistake():
    text = "Open the WebUI and fix the trafic rule."
    kept = glossary("WebUI").filter_matches(text, [spelling(text, "WebUI"), spelling(text, "trafic")])
    assert texts(kept) == ["trafic"]  # the real typo is still there


def test_only_spelling_issues_are_filtered():
    # A grammar issue on the same word is not the glossary's business: kept as is.
    text = "The WebUI are slow."
    grammar = spelling(text, "WebUI", rule_id="SOME_AGREEMENT_RULE", category="GRAMMAR", issue_type="grammar")
    assert glossary("WebUI").filter_matches(text, [grammar]) == [grammar]


def test_wrong_capitalization_is_still_flagged_with_the_right_form_suggested():
    text = "Open the webui now. The WEBUI is slow."
    kept = glossary("WebUI").filter_matches(text, [spelling(text, "webui"), spelling(text, "WEBUI")])

    assert texts(kept) == ["webui", "WEBUI"]
    for match in kept:
        # LanguageTool's guesses are replaced by the standard form from the glossary.
        assert match.replacements == ["WebUI"]
        assert "WebUI" in match.message and "glossary" in match.message


def test_wrong_capitalization_is_not_flagged_unless_languagetool_flagged_it():
    # Access is a term, access an ordinary word. LanguageTool did not report it and neither
    # do we, or a glossary containing common words would raise false alarms everywhere.
    text = "You can access the Access module."
    assert glossary("Access").filter_matches(text, []) == []


def test_a_longer_word_that_contains_a_term_is_still_checked():
    text = "The MyWebUI and WebUIx pages are open."
    kept = glossary("WebUI").filter_matches(text, [spelling(text, "MyWebUI"), spelling(text, "WebUIx")])
    assert texts(kept) == ["MyWebUI", "WebUIx"]
    # They are not another casing of a term, so LanguageTool's suggestions stay.
    assert all(match.replacements == ["guess one", "guess two"] for match in kept)


def test_the_plural_of_a_term_is_accepted():
    # Docs say "two WebUIs". A term followed by s is still the term; no need to enter both.
    text = "Two WebUIs and two Zyphor Gateways are open."
    book = glossary("WebUI", "Zyphor Gateway")
    kept = book.filter_matches(text, [spelling(text, "WebUIs"), spelling(text, "Zyphor"), spelling(text, "Gateways")])
    assert kept == []
    assert book.prompt_lines(text) == ["- WebUI", "- Zyphor Gateway"]


def test_a_wrongly_capitalized_plural_gets_a_plural_suggestion():
    text = "Two webuis are open."
    (match,) = glossary("WebUI").filter_matches(text, [spelling(text, "webuis")])
    assert match.replacements == ["WebUIs"]


def test_a_term_that_ends_in_s_gets_no_extra_plural():
    # Nexus already ends in s. Accepting one more s would let the real typo "Nexuss" pass.
    text = "The Nexus is fine but the Nexuss is not."
    kept = glossary("Nexus").filter_matches(text, [spelling(text, "Nexus"), spelling(text, "Nexuss")])
    assert texts(kept) == ["Nexuss"]


def test_a_term_followed_by_punctuation_or_possessive_is_recognized():
    # LanguageTool reports the word WebUI itself, without the 's and the period.
    text = "Check the WebUI's log, then close the WebUI."
    kept = glossary("WebUI").filter_matches(text, [spelling(text, "WebUI", 0), spelling(text, "WebUI", 1)])
    assert kept == []


def test_a_multi_word_term_protects_its_words_only_inside_the_term():
    # The glossary only has the two-word "Zyphor Gateway". A lone Zyphor is not a term and is still reported.
    text = "The Zyphor Gateway is new. Zyphor made it."
    kept = glossary("Zyphor Gateway").filter_matches(text, [spelling(text, "Zyphor", 0), spelling(text, "Zyphor", 1)])

    assert len(kept) == 1
    assert kept[0].offset == text.index("Zyphor made")


def test_a_multi_word_term_is_found_across_extra_spaces_and_line_breaks():
    text = "Open the Zyphor  Gateway and the Zyphor\nGateway."
    kept = glossary("Zyphor Gateway").filter_matches(text, [spelling(text, "Zyphor", 0), spelling(text, "Zyphor", 1)])
    assert kept == []


def test_positions_are_right_after_an_emoji():
    # The emoji is 2 UTF-16 code units; term positions must be converted or the match is not removed.
    text = "\U0001F600 Open the WebUI and the Zyphor box."
    kept = glossary("WebUI").filter_matches(text, [spelling(text, "WebUI"), spelling(text, "Zyphor")])
    assert texts(kept) == ["Zyphor"]


def test_an_empty_glossary_changes_nothing():
    text = "Open the WebUI."
    matches = [spelling(text, "WebUI")]
    assert Glossary([]).filter_matches(text, matches) == matches
    assert len(Glossary()) == 0


def test_the_same_english_term_in_several_rows_is_one_term():
    # One English term with two Chinese terms is two rows, but a single term for matching.
    book = glossary({"en": "policy", "zh": "策略"}, {"en": "policy", "zh": "政策"})
    assert len(book) == 2
    assert book.prompt_lines("Edit the policy now.") == ["- policy"]


# ---------- Terms with symbols, such as version strings ----------


def test_version_strings_match_as_a_whole():
    book = glossary({"en": "ZX3.1.60", "category": "Version"}, {"en": "10.2.4-10.2.180", "category": "Version"})
    text = "Upgrade from 10.2.4-10.2.180 to ZX3.1.60 today."
    assert book.prompt_lines(text) == ["- 10.2.4-10.2.180", "- ZX3.1.60"]
    # Different separators mean a different term: here spaces and other digits.
    assert book.prompt_lines("Versions 10.2.4 10.2.180 and ZX3.1.601 and ZX3-1-60.") == []


def test_a_version_term_gets_no_plural():
    # No plural s after a term that ends in a digit.
    assert glossary("ZX3.1.60").prompt_lines("the ZX3.1.60s release") == []


def test_terms_with_symbols_at_the_edges():
    book = glossary(".NET", "C++")
    assert book.prompt_lines("Written in C++ and .NET today.") == ["- C++", "- .NET"]
    assert book.prompt_lines("Written in C and NET today.") == []


# ---------- Wrong forms: reported proactively ----------


def test_a_registered_wrong_form_is_flagged_without_languagetool():
    text = "Open the Web UI and the web-ui page."
    book = glossary({"en": "WebUI", "variants": ["Web UI", "web-ui"]})

    found = book.filter_matches(text, [])

    assert texts(found) == ["Web UI", "web-ui"]
    for match in found:
        assert match.replacements == ["WebUI"]
        assert (match.rule_id, match.category, match.issue_type) == (RULE_ID, CATEGORY, ISSUE_TYPE)
        assert utf16_slice(text, match.offset, match.length) == match.text
    assert found[0].message == 'Use "WebUI" instead of "Web UI" (team glossary).'


def test_wrong_forms_match_without_regard_to_case_but_never_the_standard_form():
    # Standard form WebUI, registered wrong form webui. Webui and WEBUI are reported, WebUI is not.
    text = "WebUI, Webui, WEBUI and webui."
    found = glossary({"en": "WebUI", "variants": ["webui"]}).filter_matches(text, [])
    assert texts(found) == ["Webui", "WEBUI", "webui"]


def test_a_wrong_form_replaces_what_languagetool_said_about_the_same_words():
    # LanguageTool reports web-ui as a misspelling too. Two underlines in one place are pointless: the glossary's wins.
    text = "Open the web-ui page and fix the trafic rule."
    book = glossary({"en": "WebUI", "variants": ["web-ui"]})
    found = book.filter_matches(text, [spelling(text, "web-ui"), spelling(text, "trafic")])

    assert texts(found) == ["web-ui", "trafic"]
    assert found[0].rule_id == RULE_ID
    assert found[1].rule_id == "MORFOLOGIK_RULE_EN_US"


def test_a_bigger_grammar_issue_around_a_wrong_form_is_kept():
    text = "The Web UI are slow."
    book = glossary({"en": "WebUI", "variants": ["Web UI"]})
    grammar = spelling(text, "The Web UI are", rule_id="AGREEMENT", category="GRAMMAR", issue_type="grammar")
    found = book.filter_matches(text, [grammar])
    assert [match.rule_id for match in found] == ["AGREEMENT", RULE_ID]


def test_a_plural_wrong_form_gets_a_plural_suggestion():
    text = "Two Web UIs are open."
    (match,) = glossary({"en": "WebUI", "variants": ["Web UI"]}).filter_matches(text, [])
    assert match.text == "Web UIs"
    assert match.replacements == ["WebUIs"]


def test_wrong_forms_inside_other_words_are_not_flagged():
    text = "The webuilder tool and the subwebui page."
    assert glossary({"en": "WebUI", "variants": ["webui"]}).filter_matches(text, []) == []


# ---------- Chinese left inside English text ----------


def test_untranslated_chinese_in_english_text_is_flagged_with_the_english_term():
    text = "Go to 策略 and click 新增 to continue."
    book = glossary({"en": "Policies", "zh": "策略"}, {"en": "Add", "zh": "新增"})

    found = book.filter_matches(text, [])

    assert texts(found) == ["策略", "新增"]
    assert found[0].replacements == ["Policies"]
    assert found[0].message == '"策略" is "Policies" in English (team glossary).'
    assert found[0].issue_type == ISSUE_TYPE
    for match in found:
        assert utf16_slice(text, match.offset, match.length) == match.text


def test_one_chinese_term_with_several_english_terms_offers_all_of_them():
    text = "Open the 归档中心 page of the device."
    book = glossary(
        {"en": "Archiving Center", "zh": "归档中心", "applies_to": "before 3.1.60"},
        {"en": "Archive Center", "zh": "归档中心", "applies_to": "3.1.60 and later"},
    )
    (match,) = book.filter_matches(text, [])

    assert match.replacements == ["Archiving Center", "Archive Center"]
    assert "Archiving Center (before 3.1.60)" in match.message
    assert "Archive Center (3.1.60 and later)" in match.message


def test_the_applies_to_note_is_shown_for_a_single_english_term():
    text = "Open the 归档中心 page of the device."
    (match,) = glossary({"en": "Archive Center", "zh": "归档中心", "applies_to": "3.1.60 and later"}).filter_matches(text, [])
    assert match.message == '"归档中心" is "Archive Center" in English (team glossary). Applies to: 3.1.60 and later.'


def test_chinese_is_not_flagged_when_the_text_is_not_english():
    # The user is writing Chinese: leave them alone.
    book = glossary({"en": "Policies", "zh": "策略"})
    assert book.filter_matches("策略", []) == []
    assert book.filter_matches("ok 策略", []) == []


def test_chinese_inside_a_chinese_sentence_is_not_flagged():
    # A term inside an untranslated Chinese sentence: the whole sentence is untranslated, so flagging single words is pointless.
    text = "Please note this line: 请先配置策略再继续 before you go on."
    assert glossary({"en": "Policies", "zh": "策略"}).filter_matches(text, []) == []


def test_the_longest_chinese_term_wins():
    text = "Open the 归档中心策略 page of the device."
    book = glossary({"en": "Policies", "zh": "策略"}, {"en": "Archiving Center Policy", "zh": "归档中心策略"})
    (match,) = book.filter_matches(text, [])
    assert match.text == "归档中心策略"
    assert match.replacements == ["Archiving Center Policy"]


def test_a_chinese_term_that_contains_english_is_found_as_a_whole():
    text = "Configure the REST API 网关 on the device first."
    book = glossary({"en": "REST API gateway", "zh": "REST API 网关"}, "REST API")
    (match,) = ours(book.filter_matches(text, []))
    assert match.text == "REST API 网关"
    assert match.replacements == ["REST API gateway"]


def test_chinese_positions_are_right_after_an_emoji():
    text = "\U0001F600 Go to 策略 and click the button."
    (match,) = glossary({"en": "Policies", "zh": "策略"}).filter_matches(text, [])
    assert utf16_slice(text, match.offset, match.length) == "策略"


# ---------- /ai/improve: telling the model which words to leave alone ----------


def test_prompt_lines_are_the_terms_that_appear_in_the_sentence():
    book = glossary("FlowGuard", "WebUI", "Zyphor Gateway")
    # In order of appearance, and only those that appear.
    assert book.prompt_lines("Use the Zyphor Gateway from the WebUI.") == ["- Zyphor Gateway", "- WebUI"]
    assert book.prompt_lines("Nothing special in this sentence.") == []


def test_prompt_lines_include_wrongly_capitalized_terms():
    # Lower-case spellings count as appearing, so the model learns the standard form.
    assert glossary("WebUI", "Zyphor Gateway").prompt_lines("open the webui of the zyphor  gateway") == ["- WebUI", "- Zyphor Gateway"]


def test_prompt_lines_do_not_match_inside_other_words():
    assert glossary("HA").prompt_lines("What happens when the link is shared?") == []


def test_prompt_lines_explain_wrong_forms_and_untranslated_chinese():
    book = glossary({"en": "WebUI", "variants": ["Web UI"]}, {"en": "Policies", "zh": "策略"})
    lines = book.prompt_lines("Open the Web UI and go to 策略 to continue.")
    assert lines == [
        '- WebUI (the sentence writes it as "Web UI")',
        '- "策略" is untranslated Chinese. In English it is written: Policies',
    ]


def test_prompt_lines_list_every_wrong_form_used_in_the_sentence():
    # Found with real check results: a sentence with two wrong forms used to tell the model about only one.
    book = glossary({"en": "WebUI", "variants": ["Web UI", "web-ui"]})
    lines = book.prompt_lines("Log in to the Web UI and open the web-ui again, then the Web UI.")
    assert lines == ['- WebUI (the sentence writes it as "Web UI", "web-ui")']


def test_an_edit_that_leaves_the_term_alone_is_allowed():
    sentence = "The WebUI dont load."
    book = glossary("WebUI")
    assert book.allows_edit(sentence, sentence.index("dont"), "dont", "does not")
    # The term is rewritten together with its neighbours but is still there unchanged.
    assert book.allows_edit(sentence, 0, "The WebUI dont", "The WebUI does not")


def test_an_edit_that_changes_the_term_is_not_allowed():
    sentence = "The WebUI dont load."
    book = glossary("WebUI")
    position = sentence.index("WebUI")
    assert not book.allows_edit(sentence, position, "WebUI", "Web UI")
    assert not book.allows_edit(sentence, position, "WebUI", "web interface")
    assert not book.allows_edit(sentence, 0, "The WebUI dont", "The web UI does not")


def test_an_edit_that_cuts_through_the_term_is_not_allowed():
    sentence = "Open the Zyphor Gateway page."
    assert not glossary("Zyphor Gateway").allows_edit(sentence, sentence.index("Gateway"), "Gateway page", "gateway page")


def test_fixing_a_wrong_form_or_the_capitalization_is_allowed():
    # The sentence does not use the standard form, so changing it to the standard form is fine.
    book = glossary({"en": "WebUI", "variants": ["Web UI"]})
    assert book.allows_edit("Open the webui now.", 9, "webui", "WebUI")
    assert book.allows_edit("Open the Web UI now.", 9, "Web UI", "WebUI")


def test_without_terms_every_edit_is_allowed():
    assert Glossary([]).allows_edit("Open the WebUI.", 9, "WebUI", "Web UI")


# ---------- Lookup ----------


def test_lookup_finds_terms_by_chinese_or_english():
    book = glossary(
        {"en": "Archiving Center", "zh": "归档中心", "applies_to": "before 3.1.60"},
        {"en": "Archive Center", "zh": "归档中心", "applies_to": "3.1.60 and later"},
        {"en": "Policies", "zh": "策略"},
        {"en": "WebUI", "zh": "网页管理界面", "variants": ["Web UI"]},
    )
    # One Chinese term with several English terms: all are found.
    assert [entry.en for entry in book.lookup("归档中心")] == ["Archive Center", "Archiving Center"]
    assert [entry.en for entry in book.lookup("center")] == ["Archive Center", "Archiving Center"]
    # Part of the Chinese term.
    assert [entry.en for entry in book.lookup("管理")] == ["WebUI"]
    # A wrong form also shows what to write instead.
    assert [entry.en for entry in book.lookup("web ui")] == ["WebUI"]
    assert book.lookup("nothing like this") == []
    assert book.lookup("   ") == []


def test_lookup_works_in_both_directions_whatever_is_typed():
    # Lookup must work both ways: Chinese or English input, every matching row is shown.
    book = glossary(
        {"en": "REST API gateway", "zh": "REST API 网关"},
        {"en": "backup policy", "zh": "备份策略"},
        {"en": "Zyphor Cloud", "zh": ""},  # a row with English only
    )
    english = lambda query: [entry.en for entry in book.lookup(query)]  # noqa: E731

    # Chinese in, English out.
    assert english("备份") == ["backup policy"]
    assert english("策略") == ["backup policy"]
    # English in, the same row (with its Chinese) out.
    assert english("backup") == ["backup policy"]
    assert english("POLICY") == ["backup policy"]  # case-insensitive
    assert book.lookup("backup")[0].zh == "备份策略"
    # A Chinese term containing Latin letters: found by its Chinese part, its English part, and the English part in lower case.
    assert english("网关") == ["REST API gateway"]
    assert english("rest api") == ["REST API gateway"]
    assert english("REST API 网关") == ["REST API gateway"]
    # Rows with English only are found too.
    assert english("zyphor") == ["Zyphor Cloud"]


def test_lookup_puts_exact_matches_first_and_respects_the_limit():
    book = glossary("Policy Group", "Policy", "Policy Route", "Security Policy")
    assert [entry.en for entry in book.lookup("policy")] == ["Policy", "Policy Group", "Policy Route", "Security Policy"]
    assert [entry.en for entry in book.lookup("policy", limit=2)] == ["Policy", "Policy Group"]


# ---------- A large glossary ----------


def time_a_check(rows: list[dict], text: str) -> tuple[float, list]:
    """Seconds one check of the text takes, and what it found. The best of three runs, so
    that a machine busy with something else does not decide the result."""
    book = glossary(*rows)
    best, found = float("inf"), []
    for _ in range(3):
        started = time.perf_counter()
        found = book.filter_matches(text, [])
        best = min(best, time.perf_counter() - started)
    return best, found


def test_the_time_of_a_check_does_not_grow_with_the_glossary():
    # Terms that begin with different words, as in a real glossary. The index by first word
    # leads straight to the few candidates, so 5,000 rows cost about the same as 50 (a few
    # milliseconds for 20,000 characters on a laptop).
    rows = [{"en": f"Unit{number} Zyphor", "zh": f"单元{number}号", "variants": [f"Unit{number} Zyfor"]} for number in range(5000)]
    text = ("Open the Unit42 Zyphor page, not the Unit7 Zyfor page, and check the trafic rule. " * 250)[:20000]

    small, _ = time_a_check(rows[:50], text)
    large, found = time_a_check(rows, text)

    assert len(found) == text.count("Unit7 Zyfor")
    # The two are compared with each other, not with a clock: a fixed time limit fails on a
    # slow machine. A check that looked at every term would be about a hundred times slower here.
    assert large < small * 20 + 0.05, f"50 rows took {small:.3f} seconds, 5,000 rows took {large:.3f}"


def test_many_terms_that_begin_with_the_same_word_are_slower_but_bounded():
    # The worst case for the index: all 5,000 terms begin with the same word, so every
    # occurrence of that word in the text is compared with all of them. Time then grows with
    # the number of such terms: about 0.8 seconds here on a laptop. The limit is generous on
    # purpose. It is there to catch a change that makes this take minutes, not to measure the machine.
    rows = [{"en": f"Zyphor Unit{number}", "zh": f"单元{number}号", "variants": [f"Zyfor Unit{number}"]} for number in range(5000)]
    text = ("Open the Zyphor Unit42 page, not the Zyfor Unit7 page, and check the trafic rule. " * 250)[:20000]

    elapsed, found = time_a_check(rows, text)

    assert len(found) == text.count("Zyfor Unit7")
    assert elapsed < 15.0, f"checking took {elapsed:.2f} seconds"

# ---------- A glossary for another language, or for none ----------


def russian_glossary() -> Glossary:
    entries = [Entry(id=1, en="Policies", zh="Политики"), Entry(id=2, en="WebUI", variants=("Web UI",))]
    return Glossary(entries, make_profile("Russian", "cyrillic"))


def test_the_default_profile_is_chinese_and_the_old_behaviour():
    profile = make_profile()
    assert (profile.source_name, profile.script, profile.categories) == ("Chinese", "han", DEFAULT_CATEGORIES)


def test_stray_source_text_is_found_in_the_configured_script():
    book = russian_glossary()
    text = "Go to Политики and open the page to continue."
    (match,) = ours(book.filter_matches(text, []))
    assert (match.text, match.replacements) == ("Политики", ["Policies"])
    # The same sentence in Chinese is just text to this glossary.
    assert ours(book.filter_matches("Go to 策略 and open the page to continue.", [])) == []


def test_the_model_is_told_the_name_of_the_source_language():
    lines = russian_glossary().prompt_lines("Go to Политики and open the Web UI.")
    assert lines[0] == '- "Политики" is untranslated Russian. In English it is written: Policies'
    assert lines[1] == '- WebUI (the sentence writes it as "Web UI")'


def test_without_a_source_script_only_english_terms_and_wrong_forms_are_checked():
    book = Glossary(
        [Entry(id=1, en="Policies", zh="Политики"), Entry(id=2, en="WebUI", variants=("Web UI",))],
        make_profile(script="none"),
    )
    text = "Go to Политики and open the Web UI to continue."
    # No stray-text issue, but the wrong form is still reported.
    assert [match.text for match in ours(book.filter_matches(text, []))] == ["Web UI"]
    assert book.prompt_lines(text) == ['- WebUI (the sentence writes it as "Web UI")']


def test_categories_come_from_the_settings_without_duplicates():
    assert make_profile(categories="Hardware, Software,\nHardware , ").categories == ("Hardware", "Software")


def test_an_unknown_script_stops_the_start_instead_of_switching_detection_off():
    import pytest

    with pytest.raises(ValueError, match="GLOSSARY_SOURCE_SCRIPT"):
        make_profile(script="klingon")