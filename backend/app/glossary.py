"""Matching engine for the team glossary.

The glossary is a Chinese-English table: Chinese is the source, English the standard
translation. A row is one Chinese term with one English term; the same Chinese may have
several rows (different contexts or product versions). A row can also list wrong forms.

This module only deals with using the rows, not with where they are stored (store.py):

  1. /check: a standard English term is not a misspelling (LanguageTool's report is dropped);
             a registered wrong form is reported, suggesting the standard form;
             an untranslated Chinese term inside English text is reported, suggesting the English.
  2. /ai/improve: tell the model which terms occur in the sentence and how to write them.
  3. /ai/improve: reject an edit in which the model changed a term anyway.
  4. Lookup: find the rows for a Chinese or English word.

Why not one big regular expression of all terms: with thousands of terms a single check
would take seconds. Instead the text is cut into words and each word is looked up in an
index of "terms starting with this word"; only those candidates are verified. The time
depends on the length of the text and hardly on the size of the glossary.
"""

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass

from app.glossary_profile import DEFAULT_PROFILE, Profile
from app.schemas import Match
from app.textpos import utf16_len

# Most terms sent to the model at once. A safety cap; one sentence rarely has this many.
MAX_PROMPT_TERMS = 40
# Stray Chinese is flagged only when the text has at least this many English words.
# With fewer, the user is probably writing Chinese and should be left alone.
MIN_ENGLISH_WORDS = 3
# Rule id, category and type of the issues we generate. Front ends title the card by issue_type.
RULE_ID = "GLOSSARY_TERM"
CATEGORY = "TERMINOLOGY"
ISSUE_TYPE = "terminology"

_ENGLISH_WORD = re.compile(r"[A-Za-z]{2,}")
_SPACES = re.compile(r"\s+")


# ---------- Text tidying helpers (the store uses them for duplicate checks too) ----------


def tidy(text: str | None) -> str:
    """Trim, and collapse inner whitespace to single spaces."""
    return " ".join(str(text or "").split())


def en_key(text: str | None) -> str:
    """Comparison form of English: full-width to half-width, case-folded, whitespace tidied. WebUI and webui are equal."""
    return tidy(unicodedata.normalize("NFKC", str(text or ""))).casefold()


def zh_key(text: str | None) -> str:
    """Comparison form of Chinese: full-width to half-width, all whitespace removed."""
    return "".join(unicodedata.normalize("NFKC", str(text or "")).split())


@dataclass(frozen=True)
class Entry:
    """One glossary row."""

    id: int
    en: str  # standard English form, required
    zh: str = ""  # the Chinese term, may be empty
    category: str = ""
    applies_to: str = ""  # product versions it applies to; for people, not used in matching
    variants: tuple[str, ...] = ()  # English forms that must not be used
    note: str = ""
    created_by: str = ""
    created_at: str = ""
    updated_by: str = ""
    updated_at: str = ""


# ---------- Two small structures used inside the engine ----------


@dataclass(frozen=True)
class _Form:
    """One English form (standard or wrong), split up for matching."""

    text: str
    tokens: tuple[str, ...]  # the words, as written
    folded: tuple[str, ...]  # the words, case-folded
    seps: tuple[str, ...]  # what stands between the words (whitespace collapsed to one space)
    prefix: str  # symbols before the first word, e.g. the dot in .NET
    suffix: str  # symbols after the last word, e.g. the pluses in C++
    plural: bool  # whether a trailing s is accepted after the last word
    wrong: bool  # whether this is a wrong form
    standard: str  # the standard form it belongs to (itself for a standard form)


@dataclass(frozen=True)
class _Hit:
    """One place found in the text. Positions are in Python characters."""

    start: int
    end: int
    kind: str  # standard, wrong (a wrong form) or zh (stray Chinese)
    found: str  # what the text actually says
    standard: str = ""  # standard and wrong: the standard form
    exact: bool = True  # standard: whether the case matches the glossary exactly
    plural: bool = False  # whether an s was appended
    entries: tuple[Entry, ...] = ()  # zh: the rows for this Chinese term


def _squash(text: str) -> str:
    return _SPACES.sub(" ", text)


def _make_form(text: str, wrong: bool, standard: str, word: re.Pattern) -> _Form | None:
    words = list(word.finditer(text))
    if not words:
        return None  # no letters or digits at all: cannot be matched by words
    tokens = tuple(word.group() for word in words)
    last = tokens[-1]
    return _Form(
        text=text,
        tokens=tokens,
        folded=tuple(token.casefold() for token in tokens),
        seps=tuple(_squash(text[a.end() : b.start()]) for a, b in zip(words, words[1:])),
        prefix=text[: words[0].start()],
        suffix=text[words[-1].end() :],
        # Plural: one extra s is accepted (two WebUIs), but not when the word already ends in s,
        # or a real typo like "Nexuss" would pass, and not after a digit (version numbers).
        plural=last.isalpha() and not last.casefold().endswith("s"),
        wrong=wrong,
        standard=standard,
    )


def _match_form(text: str, words: list[re.Match], index: int, form: _Form) -> tuple[int, int, bool, bool] | None:
    """Whether the text has this form starting at word number index. Returns (start, end, exact case, plural)."""
    count = len(form.tokens)
    if index + count > len(words):
        return None
    exact = True
    plural = False
    for offset in range(count):
        token = words[index + offset].group()
        wanted = form.tokens[offset]
        if token == wanted:
            continue
        folded = token.casefold()
        if folded == form.folded[offset]:
            exact = False  # same letters, different case
            continue
        if offset == count - 1 and form.plural and folded == form.folded[offset] + "s":
            plural = True
            if token != wanted + "s":
                exact = False
            continue
        return None
    # The separators between words must match too. This is what verifies the dots and the
    # hyphen in a version range like 10.2.4-10.2.180.
    for offset in range(count - 1):
        between = text[words[index + offset].end() : words[index + offset + 1].start()]
        if _squash(between) != form.seps[offset]:
            return None
    first, last = words[index], words[index + count - 1]
    start = first.start() - len(form.prefix)
    end = last.end() + len(form.suffix)
    if start < 0 or text[start : first.start()] != form.prefix or text[last.end() : end] != form.suffix:
        return None
    return start, end, exact, plural


def _overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start < b_end and b_start < a_end


class Glossary:
    """A prepared glossary. Immutable: the store builds a new one whenever the rows change."""

    def __init__(self, entries: list[Entry] | None = None, profile: Profile | None = None):
        self.entries: tuple[Entry, ...] = tuple(entries or ())
        self.profile = profile or DEFAULT_PROFILE
        chars = self.profile.chars
        # Source-language characters. Without a source script nothing ever matches, so no
        # source text is looked for.
        self._source_char = re.compile(f"[{chars}]") if chars else None
        # A word: consecutive letters, digits and underscores, but no source-script characters
        # (Chinese has no spaces between words and is handled separately).
        self._word = re.compile(rf"[^\W{chars}]+")

        # English: indexed by first word. A standard form shared by several rows is registered once.
        self._index: dict[str, list[_Form]] = {}
        seen: set[tuple[str, bool]] = set()
        for entry in self.entries:
            for text, wrong in [(entry.en, False)] + [(variant, True) for variant in entry.variants]:
                if not text or (text, wrong) in seen:
                    continue
                seen.add((text, wrong))
                form = _make_form(text, wrong, entry.en, self._word)
                if form:
                    self._index.setdefault(form.folded[0], []).append(form)

        # Source language (Chinese by default): indexed by the first source-script character of
        # the term, with its position in the term, so terms that contain English
        # ("REST API 网关") are found as well.
        self._zh_entries: dict[str, list[Entry]] = {}
        for entry in self.entries:
            if self._source_char and entry.zh and self._source_char.search(entry.zh):
                self._zh_entries.setdefault(entry.zh, []).append(entry)
        self._zh_index: dict[str, list[tuple[int, str]]] = {}
        for term in self._zh_entries:
            first = self._source_char.search(term)
            self._zh_index.setdefault(first.group(), []).append((first.start(), term))
        for candidates in self._zh_index.values():
            candidates.sort(key=lambda item: len(item[1]), reverse=True)  # longest first

    def __len__(self) -> int:
        return len(self.entries)

    # ---------- Finding terms in text ----------

    def _scan_english(self, text: str) -> list[_Hit]:
        """All English terms and wrong forms in the text. Left to right, longest match at each position."""
        if not self._index:
            return []
        words = list(self._word.finditer(text))
        hits = []
        index = 0
        while index < len(words):
            best = None  # ((word count, priority), hit)
            folded = words[index].group().casefold()
            candidates = list(self._index.get(folded, ()))
            if folded.endswith("s"):
                # The word may be the plural of a one-word term.
                candidates += [form for form in self._index.get(folded[:-1], ()) if len(form.tokens) == 1]
            for form in candidates:
                found = _match_form(text, words, index, form)
                if not found:
                    continue
                start, end, exact, plural = found
                # At equal length: an exact standard form wins, then a wrong form, then a standard form
                # in the wrong case. Example: standard WebUI, wrong form webui. WebUI in the text is right,
                # webui is wrong.
                priority = 2 if form.wrong else (3 if exact else 1)
                rank = (len(form.tokens), priority)
                if best is None or rank > best[0]:
                    hit = _Hit(start, end, "wrong" if form.wrong else "standard", text[start:end], form.standard, exact, plural)
                    best = (rank, hit)
            if best:
                hits.append(best[1])
                index += best[0][0]
            else:
                index += 1
        return hits

    def _scan_chinese(self, text: str) -> list[_Hit]:
        """Chinese terms left inside English text."""
        if not self._zh_index:
            return []
        if len(_ENGLISH_WORD.findall(text)) < MIN_ENGLISH_WORDS:
            return []
        hits = []
        covered = 0  # text before this position already belongs to the previous hit
        for char in self._source_char.finditer(text):
            if char.start() < covered:
                continue
            for offset, term in self._zh_index.get(char.group(), ()):
                start = char.start() - offset
                end = start + len(term)
                if start < covered or text[start:end] != term or not self._stands_alone(text, start, end):
                    continue
                hits.append(_Hit(start, end, "zh", term, entries=tuple(self._zh_entries[term])))
                covered = end
                break
        return hits

    def _stands_alone(self, text: str, start: int, end: int) -> bool:
        """Whether this source text stands on its own: not part of a sentence in that language, not embedded in another word."""
        for inside, outside in ((text[start], text[start - 1 : start] if start > 0 else ""), (text[end - 1], text[end : end + 1])):
            if not outside:
                continue
            if self._source_char.match(outside):
                return False  # another source-script character next to it: part of a sentence in that language
            if self._word.match(outside) and self._word.match(inside):
                return False  # a letter at the edge of the term and a letter next to it: embedded in a word
        return True

    def _scan(self, text: str, chinese_terms: bool = True) -> list[_Hit]:
        # chinese_terms False: the text is written in the source language, so its terms are
        # not something left untranslated and are not looked for.
        chinese = self._scan_chinese(text) if chinese_terms else []
        # A Chinese term may contain English ("REST API 网关"); the Chinese term wins for that span.
        english = [hit for hit in self._scan_english(text) if not any(_overlaps(hit.start, hit.end, zh.start, zh.end) for zh in chinese)]
        return sorted(english + chinese, key=lambda hit: hit.start)

    # ---------- For /check ----------

    def filter_matches(self, text: str, matches: list[Match], chinese_terms: bool = True) -> list[Match]:
        """Apply the glossary to LanguageTool's result: drop "misspellings" that are terms, add the issues we found.

        chinese_terms False: do not report source-language terms left in the text (the text is
        written in that language).
        """
        if not self.entries:
            return matches
        hits = self._scan(text, chinese_terms)
        if not hits:
            return matches

        # Without emoji-like characters Python positions equal UTF-16 positions: no conversion.
        plain = len(text) == utf16_len(text)
        to_utf16 = (lambda position: position) if plain else (lambda position: utf16_len(text[:position]))
        spans = [(to_utf16(hit.start), to_utf16(hit.end), hit) for hit in hits]

        generated = [self._issue(start, end, hit) for start, end, hit in spans if hit.kind != "standard"]

        result = []
        for match in matches:
            begin, finish = match.offset, match.offset + match.length
            spelling = _is_spelling(match)
            drop = False
            for start, end, hit in spans:
                if not _overlaps(begin, finish, start, end):
                    continue
                inside = start <= begin and finish <= end
                if hit.kind == "standard":
                    if spelling and inside and hit.exact:
                        drop = True  # a term, not a misspelling
                    elif spelling and (begin, finish) == (start, end):
                        # Same letters, only the case differs from the glossary (webui vs WebUI): keep the
                        # issue but suggest the standard form. LanguageTool's own guesses mean nothing here.
                        match = match.model_copy(
                            update={
                                "replacements": [hit.standard + "s" if hit.plural else hit.standard],
                                "message": f'This term is written "{hit.standard}" in the team glossary.',
                            }
                        )
                elif inside or spelling:
                    drop = True  # already explained by our own issue; avoid two underlines on one word
                if drop:
                    break
            if not drop:
                result.append(match)

        return sorted(result + generated, key=lambda match: match.offset)

    @staticmethod
    def _issue(offset: int, end: int, hit: _Hit) -> Match:
        """Build an issue for a wrong form or stray Chinese, in the same format as LanguageTool's."""
        if hit.kind == "wrong":
            suggestions = [hit.standard + "s" if hit.plural else hit.standard]
            message = f'Use "{hit.standard}" instead of "{hit.found}" (team glossary).'
        else:
            suggestions = list(dict.fromkeys(entry.en for entry in hit.entries))  # de-duplicated, order kept
            if len(suggestions) == 1:
                note = f" Applies to: {hit.entries[0].applies_to}." if hit.entries[0].applies_to else ""
                message = f'"{hit.found}" is "{suggestions[0]}" in English (team glossary).{note}'
            else:
                # One Chinese term with several English terms: list them all with their versions and let the writer choose.
                options = ", ".join(entry.en + (f" ({entry.applies_to})" if entry.applies_to else "") for entry in hit.entries)
                message = f'"{hit.found}" has more than one English term in the team glossary: {options}. Pick the one that fits.'
        return Match(
            offset=offset,
            length=end - offset,
            text=hit.found,
            message=message,
            short_message="Terminology",
            replacements=suggestions,
            rule_id=RULE_ID,
            rule_description="Team glossary",
            category=CATEGORY,
            issue_type=ISSUE_TYPE,
        )

    # ---------- For /ai/improve ----------

    def prompt_lines(self, sentence: str, chinese_terms: bool = True) -> list[str]:
        """The terms that occur in this sentence, one line each, phrased for the model. Empty if none.

        Only these, not the whole glossary: the prompt is paid for on every sentence (see prompt.py).
        chinese_terms False: leave out source-language terms, as in filter_matches.
        """
        chinese: dict[str, str] = {}  # Chinese term -> its line; a dict de-duplicates and keeps order
        english: dict[str, list[str]] = {}  # standard form -> wrong forms used in the sentence
        order: list[tuple[str, str]] = []  # which kind each line is, in order of appearance
        for hit in self._scan(sentence, chinese_terms):
            if hit.kind == "zh":
                if hit.found not in chinese:
                    options = list(dict.fromkeys(entry.en for entry in hit.entries))
                    wording = options[0] if len(options) == 1 else "one of: " + ", ".join(options)
                    chinese[hit.found] = f'- "{hit.found}" is untranslated {self.profile.source_name}. In English it is written: {wording}'
                    order.append(("zh", hit.found))
                continue
            if hit.standard not in english:
                english[hit.standard] = []
                order.append(("en", hit.standard))
            if hit.kind == "wrong" and hit.found not in english[hit.standard]:
                english[hit.standard].append(hit.found)

        lines = []
        for kind, name in order[:MAX_PROMPT_TERMS]:
            if kind == "zh":
                lines.append(chinese[name])
            elif english[name]:
                wrong = ", ".join(f'"{found}"' for found in english[name])
                lines.append(f"- {name} (the sentence writes it as {wrong})")
            else:
                lines.append(f"- {name}")
        return lines

    def allows_edit(self, sentence: str, position: int, original: str, replacement: str) -> bool:
        """Whether an edit suggested by the model leaves the terms alone. False means: do not use it.

        The prompt already tells the model not to change terms; this is the second safeguard.
          position  where original starts in the sentence (Python characters)
        """
        if not self._index:
            return True
        end = position + len(original)
        for hit in self._scan_english(sentence):
            if hit.kind != "standard" or not hit.exact or not _overlaps(position, end, hit.start, hit.end):
                continue  # not a correctly written term, or unrelated to this edit
            if hit.start < position or hit.end > end:
                return False  # the edit cuts through the middle of a term
        # The edit contains whole terms (it rewrites the words around them): every one of them
        # must still be there afterwards.
        before = self._count_standards(original)
        after = self._count_standards(replacement)
        return all(after[term] >= count for term, count in before.items())

    def _count_standards(self, text: str) -> Counter:
        return Counter(hit.standard for hit in self._scan_english(text) if hit.kind == "standard" and hit.exact)

    # ---------- Lookup ----------

    def lookup(self, query: str, limit: int = 20) -> list[Entry]:
        """Look a word up in Chinese or English. Exact matches first, then prefix matches, then substring matches."""
        # Both directions: Chinese finds English and English finds Chinese. The input language is
        # not guessed; the word is searched in both columns. The Chinese column may contain Latin
        # letters ("REST API 网关"), so it is compared case-insensitively as well.
        english = en_key(query)
        chinese = zh_key(query).casefold()
        if not english:
            return []
        scored = []
        for entry in self.entries:
            en, zh = en_key(entry.en), zh_key(entry.zh).casefold()
            wrong = [en_key(variant) for variant in entry.variants]
            if en == english or (zh and zh == chinese):
                score = 0
            elif en.startswith(english) or (zh and zh.startswith(chinese)):
                score = 1
            elif english in en or (zh and chinese in zh):
                score = 2
            elif any(english in variant for variant in wrong):
                score = 3  # wrong forms are searchable too, so "web ui" shows that WebUI is the term
            else:
                continue
            scored.append((score, len(entry.en), entry.id, entry))
        scored.sort(key=lambda item: item[:3])
        return [item[3] for item in scored[:limit]]


def _is_spelling(match: Match) -> bool:
    """Whether this match is a spelling issue."""
    return match.issue_type == "misspelling" or match.rule_id.startswith("MORFOLOGIK_")
