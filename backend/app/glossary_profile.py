"""What the glossary is about: the source language, its script and the default categories.

The glossary is a table of a standard English term, optionally with the term of a source
language it was translated from (Chinese by default), wrong forms, a category and an
"applies to" note. This module holds the parts of that which differ between teams, so
they can be set with environment variables instead of by editing the code:

  GLOSSARY_SOURCE_LANGUAGE  display name of the source language, default Chinese
  GLOSSARY_SOURCE_SCRIPT    han (default), cyrillic, hangul, kana, arabic, hebrew, thai,
                            devanagari, greek, or none
  GLOSSARY_CATEGORIES       default categories, comma separated

none means a monolingual glossary: standard terms and wrong forms only. The source
language column then stays empty, and nothing is reported for source text left inside
English text.

The database columns keep their names (zh and so on) whatever is configured: renaming
them would need a migration and would be invisible to users. Only labels and behaviour
follow this profile. The script is how source text is recognised inside English text; it
has been tried with Han only.
"""

from dataclasses import dataclass

DEFAULT_CATEGORIES = ("Product", "Feature", "Abbreviation", "Version", "Command", "Other")

# Character ranges as regular expression character-class bodies.
SCRIPTS = {
    "han": "㐀-䶿一-鿿豈-﫿",
    "cyrillic": "Ѐ-ӿ",
    "hangul": "ᄀ-ᇿ가-힯",
    "kana": "぀-ヿ",
    "arabic": "؀-ۿ",
    "hebrew": "֐-׿",
    "thai": "฀-๿",
    "devanagari": "ऀ-ॿ",
    "greek": "Ͱ-Ͽ",
}


@dataclass(frozen=True)
class Profile:
    source_name: str = "Chinese"
    # A key of SCRIPTS, or "none" for a monolingual glossary.
    script: str = "han"
    categories: tuple[str, ...] = DEFAULT_CATEGORIES

    @property
    def chars(self) -> str:
        """The character-class body of the source script, or "" without one."""
        return SCRIPTS.get(self.script, "")

    @property
    def has_source(self) -> bool:
        return bool(self.chars)

    def is_source_language(self, code: str, name: str) -> bool:
        """Whether a text in this language is written in the glossary's source language.

        code and name are what LanguageTool reports for the text ("zh-CN", "Chinese"). Someone
        writing Chinese did not forget to translate a Chinese term, so for such a text the
        source terms are not reported and the model is not told to translate them.
        """
        if not self.has_source:
            return False
        if self.script == "han" and code.lower().startswith("zh"):
            return True
        return name.strip().lower() == self.source_name.lower()


DEFAULT_PROFILE = Profile()


def make_profile(source_name: str = "", script: str = "", categories: str = "") -> Profile:
    """Build a profile from the raw settings. Empty values keep the defaults.

    An unknown script raises ValueError, so a typo stops the backend at startup instead of
    silently switching the source-text detection off.
    """
    name = " ".join((source_name or "").split()) or DEFAULT_PROFILE.source_name
    key = (script or "").strip().lower() or DEFAULT_PROFILE.script
    if key != "none" and key not in SCRIPTS:
        raise ValueError(f"GLOSSARY_SOURCE_SCRIPT {script!r} is not one of: {', '.join(SCRIPTS)}, none")
    listed = []
    for piece in (categories or "").replace("\n", ",").split(","):
        piece = " ".join(piece.split())
        if piece and piece not in listed:
            listed.append(piece)
    return Profile(source_name=name, script=key, categories=tuple(listed) or DEFAULT_PROFILE.categories)
