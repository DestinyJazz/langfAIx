"""Settings.

Everything is read from environment variables, so the same code runs unchanged in
development and in a deployment; only the values differ.
"""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    languagetool_url: str
    # Longest text /check accepts, so one huge paste cannot stall LanguageTool.
    max_text_chars: int
    lt_timeout_seconds: float
    # Public path prefix. The reverse proxy strips /api before forwarding, so the app sees
    # /check; FastAPI needs the prefix to build correct URLs on its docs page.
    root_path: str = ""

    # ---- AI rewriting (/ai/improve) ----

    litellm_url: str = "http://litellm:4000"
    # Model name sent to LiteLLM. A fixed alias: the real model behind it is changed in
    # LiteLLM, so switching models needs no change here.
    ai_model: str = "langfAIx-model-1"
    # Each sentence is one paid call, so both limits are hard caps.
    ai_max_text_chars: int = 5000
    ai_max_sentences: int = 30
    # Concurrent AI calls. Too many runs into the provider's rate limit.
    ai_concurrency: int = 4
    ai_timeout_seconds: float = 60
    # What your documents are about, used in the opening line of the prompt. Empty keeps the
    # built-in default (see app/prompt.py).
    ai_prompt_domain: str = ""
    # Extra style preferences appended to the prompt, e.g. "Use British spelling."
    ai_prompt_extra: str = ""

    # ---- Team glossary ----

    # SQLAlchemy URL, e.g. postgresql+psycopg://user:password@postgres:5432/langfaix.
    # Empty means an in-memory SQLite: for development and tests, lost on restart.
    database_url: str = ""
    # Initial glossary admins, comma separated: LiteLLM key aliases, or the first characters
    # of a key hash (shown on the admin page). These are not secrets.
    glossary_admins: str = ""
    # The backend's own LiteLLM admin key (a secret). Used to find out whose key a caller
    # holds (app/identity.py) and to read model prices. Keys that may only call models can
    # do neither. Empty: fall back to asking with the caller's own key, which only works for
    # default-type keys.
    litellm_admin_key: str = ""
    # What the glossary is about. The defaults are Chinese to English, with the usual categories;
    # see app/glossary_profile.py. Empty keeps the default.
    glossary_source_language: str = ""
    glossary_source_script: str = ""
    glossary_categories: str = ""


def load_settings() -> Settings:
    return Settings(
        languagetool_url=os.environ.get("LANGUAGETOOL_URL", "http://languagetool:8010").rstrip("/"),
        max_text_chars=int(os.environ.get("MAX_TEXT_CHARS", "20000")),
        lt_timeout_seconds=float(os.environ.get("LT_TIMEOUT_SECONDS", "20")),
        root_path=os.environ.get("ROOT_PATH", "").rstrip("/"),
        litellm_url=os.environ.get("LITELLM_URL", "http://litellm:4000").rstrip("/"),
        ai_model=os.environ.get("AI_MODEL", "langfAIx-model-1"),
        ai_max_text_chars=int(os.environ.get("AI_MAX_TEXT_CHARS", "5000")),
        ai_max_sentences=int(os.environ.get("AI_MAX_SENTENCES", "30")),
        ai_concurrency=int(os.environ.get("AI_CONCURRENCY", "4")),
        ai_timeout_seconds=float(os.environ.get("AI_TIMEOUT_SECONDS", "60")),
        ai_prompt_domain=os.environ.get("AI_PROMPT_DOMAIN", ""),
        ai_prompt_extra=os.environ.get("AI_PROMPT_EXTRA", ""),
        database_url=os.environ.get("DATABASE_URL", ""),
        glossary_admins=os.environ.get("GLOSSARY_ADMINS", ""),
        litellm_admin_key=os.environ.get("LITELLM_ADMIN_KEY", ""),
        glossary_source_language=os.environ.get("GLOSSARY_SOURCE_LANGUAGE", ""),
        glossary_source_script=os.environ.get("GLOSSARY_SOURCE_SCRIPT", ""),
        glossary_categories=os.environ.get("GLOSSARY_CATEGORIES", ""),
    )
