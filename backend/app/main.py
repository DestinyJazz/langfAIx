"""Entry point of the langfAIx backend.

Endpoints:
  GET  /healthz       liveness check, for Docker and for us
  POST /check         rule check: forwards to LanguageTool and tidies the result
  POST /ai/improve    AI rewrite: one model call per sentence, returns edits and the cost of each sentence
  /glossary/...       glossary lookup, editing, import and export (app/glossary_api.py)
  GET  /admin/        glossary admin page (static files in app/static/admin/)
  GET  /addin/...     Word add-in pages (word-addin/ in the repo, plus the rules it shares with the browser extension)
  GET  /docs          FastAPI's generated API docs, usable from a browser

The team glossary applies to /check and /ai/improve: terms are not misspellings, wrong
forms and stray Chinese are flagged, and the model may not change terms.
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials

from app.config import Settings, load_settings
from app.edits import locate_edits, parse_edits
from app.glossary import Glossary
from app.glossary_api import build_router
from app.glossary_profile import DEFAULT_PROFILE, Profile, make_profile
from app.identity import IdentityService, bearer
from app.languagetool import (
    LanguageToolRejected,
    LanguageToolUnavailable,
    check_text,
    convert_matches,
    is_chinese,
    language_code,
    language_name,
)
from app.llm import LLMFailed, LLMRejected, LLMReply, ask_model
from app.pricing import ModelPrice, PriceCache, compute_cost
from app.schemas import (
    CheckRequest,
    CheckResponse,
    ImproveRequest,
    ImproveResponse,
    SentenceRange,
    SentenceResult,
)
from app.sentences import Sentence, sentences_from_ranges
from app.store import GlossaryStore

logger = logging.getLogger("langfaix")

ADMIN_PAGE = Path(__file__).parent / "static" / "admin"
# Seconds between attempts while the database is unreachable.
RETRY_SECONDS = 15

# ---- Word add-in pages ----
#
# The add-in's pages are served by this service under /addin/. They share an origin with
# the API, so no CORS is needed and the user never enters a server address.
#
# URLs mirror the repo layout: /addin/word-addin/... and /addin/browser-extension/lib/...
# That makes `import "../browser-extension/lib/xxx.js"` resolve both in the repo (tests)
# and on the server, so the rules shared with the browser extension are not copied.
#
# In the image the files have already been selected into app/static/addin/.
# In development that folder does not exist and the repo folders are used directly.
ADDIN_PACKED = Path(__file__).parent / "static" / "addin"
REPO_ROOT = Path(__file__).parent.parent.parent
# Only these file types are served, each with an explicit media type. Do not let the OS
# guess: Windows may report .js as plain text, and browsers then refuse to run it.
ADDIN_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".png": "image/png",
}


def find_addin_files(packed: Path = ADDIN_PACKED, repo: Path = REPO_ROOT) -> dict[str, Path]:
    """List the add-in's page files: the path after /addin/ -> the file on disk.

    Listed once at startup. Only listed files are served and anything else is a 404, so
    there is no way to reach other files with ../ tricks.
    """
    if packed.is_dir():
        sources = [(packed, "")]  # already selected at build time: serve whatever is there
    else:
        sources = [(repo / "word-addin", "word-addin/"), (repo / "browser-extension" / "lib", "browser-extension/lib/")]
    found: dict[str, Path] = {}
    for folder, prefix in sources:
        if not folder.is_dir():
            continue
        for path in folder.rglob("*"):
            relative = path.relative_to(folder)
            # Tests and node_modules are not part of the pages.
            if not path.is_file() or path.suffix.lower() not in ADDIN_TYPES or {"tests", "node_modules"} & set(relative.parts):
                continue
            found[prefix + relative.as_posix()] = path
    return found

_NO_TERMS = Glossary()


class GlossaryState:
    """Current state of the glossary: whether the database is connected, and the glossary used for matching.

    An unreachable database must not keep the service from starting: rule checks and AI
    rewriting keep working, only without a glossary. It recovers by itself once connected.
    """

    def __init__(self, url: str, profile: Profile = DEFAULT_PROFILE):
        self.url = url
        self.profile = profile
        self.store: GlossaryStore | None = None

    def connect(self) -> bool:
        """Connect, create tables, load the terms into memory. True on success."""
        try:
            self.store = GlossaryStore(self.url, self.profile)
        except Exception as exc:  # not started, wrong password, no network: all mean "unavailable for now"
            # Log the exception type and its first line only, never the database URL: it holds the password.
            logger.warning("glossary database is not available: %s: %s", exc.__class__.__name__, str(exc).splitlines()[0][:300])
            return False
        logger.warning("glossary database connected, %d rows loaded", len(self.store.glossary))
        return True

    @property
    def glossary(self) -> Glossary:
        return self.store.glossary if self.store else _NO_TERMS


def create_app(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    """Build the app.

    Both parameters are for tests: settings replaces the configuration, transport replaces
    LanguageTool and LiteLLM with fakes. In production neither is passed.
    """
    settings = settings or load_settings()
    # A mistyped GLOSSARY_SOURCE_SCRIPT raises here, so the backend does not start with the
    # detection of source-language text silently off.
    profile = make_profile(settings.glossary_source_language, settings.glossary_source_script, settings.glossary_categories)
    state = GlossaryState(settings.database_url, profile)
    identities = IdentityService(settings.litellm_url, settings.glossary_admins, settings.litellm_admin_key)

    async def keep_trying() -> None:
        """The database was unreachable at startup: keep retrying in the background until it connects."""
        while True:
            await asyncio.sleep(RETRY_SECONDS)
            if await run_in_threadpool(state.connect):
                return

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # One shared HTTP client, so connections are reused.
        app.state.http = httpx.AsyncClient(timeout=settings.lt_timeout_seconds, transport=transport)
        app.state.prices = PriceCache()
        app.state.glossary = state
        retry = None
        if not await run_in_threadpool(state.connect):
            retry = asyncio.create_task(keep_trying())
        yield
        if retry:
            retry.cancel()
        await app.state.http.aclose()
        if state.store:
            state.store.close()

    app = FastAPI(title="langfAIx backend", lifespan=lifespan, root_path=settings.root_path)
    app.include_router(build_router(state, identities))

    # ---- Glossary admin page: a few static files shipped in the image ----
    #
    # Why not FastAPI's StaticFiles mount: the service sits under /api (root_path is set) and
    # the reverse proxy strips /api before forwarding. A mount then computes the wrong path
    # and every file is a 404. test_the_admin_page_is_served guards this. So files are looked
    # up by name here.
    admin_files = {path.name: path for path in ADMIN_PAGE.iterdir() if path.is_file()}

    @app.get("/admin", include_in_schema=False)
    async def admin_without_slash() -> RedirectResponse:
        # A relative redirect: /api/admin goes to /api/admin/, and a direct /admin goes to /admin/.
        return RedirectResponse("admin/")

    @app.get("/admin/{name}", include_in_schema=False)
    @app.get("/admin/", include_in_schema=False)
    async def admin_page(name: str = "index.html") -> FileResponse:
        # Only files that exist in the folder; any other name is a 404, so ../ cannot reach elsewhere.
        path = admin_files.get(name)
        if path is None:
            raise HTTPException(status_code=404, detail="not found")
        # no-cache: revalidate every time, otherwise browsers keep an old page after an upgrade.
        return FileResponse(path, headers={"Cache-Control": "no-cache"})

    # ---- Word add-in pages (see the top of this file) ----
    addin_files = find_addin_files()

    @app.get("/addin/{name:path}", include_in_schema=False)
    async def addin_page(name: str) -> FileResponse:
        path = addin_files.get(name)
        if path is None:
            raise HTTPException(status_code=404, detail="not found")
        # The browser inside Word keeps old files too.
        return FileResponse(path, media_type=ADDIN_TYPES[path.suffix.lower()], headers={"Cache-Control": "no-cache"})

    async def run_languagetool(client: httpx.AsyncClient, text: str, language: str) -> dict:
        """Call LanguageTool and map its two failures to HTTP errors. Used by /check and /ai/improve."""
        try:
            return await check_text(client, settings.languagetool_url, text, language)
        except LanguageToolRejected as exc:
            # The request is wrong (e.g. a bad language code): the caller's fault, 400.
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except LanguageToolUnavailable as exc:
            # LanguageTool is in trouble: an upstream fault, 502.
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.get("/healthz")
    async def healthz() -> dict:
        # Also report the number of glossary rows and whether the database is connected. Counts only, no content.
        return {
            "status": "ok",
            "glossary_terms": len(state.glossary),
            "glossary_storage": "ok" if state.store else "unavailable",
        }

    @app.post("/check", response_model=CheckResponse)
    async def check(body: CheckRequest, request: Request) -> CheckResponse:
        if len(body.text) > settings.max_text_chars:
            raise HTTPException(status_code=413, detail=f"text is longer than {settings.max_text_chars} characters")

        # Nothing to check in blank text; do not bother LanguageTool.
        if not body.text.strip():
            return CheckResponse(language=body.language, matches=[])

        lt_json = await run_languagetool(request.app.state.http, body.text, body.language)
        used_language = language_code(lt_json, body.language)
        # The same function /ai/improve uses, so both agree on what a sentence is. For Chinese
        # the pieces LanguageTool cuts too small are joined first.
        sentences = sentences_from_ranges(body.text, lt_json.get("sentenceRanges"), merge_clauses=is_chinese(used_language))
        # With body.glossary false an empty glossary is used, which changes nothing.
        book = state.glossary if body.glossary else _NO_TERMS
        # Text written in the glossary's source language: its terms are not "left untranslated".
        in_source = book.profile.is_source_language(used_language, language_name(lt_json))
        return CheckResponse(
            language=used_language,
            # Apply the glossary: terms are not misspellings; wrong forms and stray Chinese become
            # issues. Doing it here gives the extension and the Word add-in identical results.
            matches=book.filter_matches(body.text, convert_matches(lt_json, body.text), chinese_terms=not in_source),
            sentences=[SentenceRange(offset=s.offset, length=s.length) for s in sentences],
        )

    @app.post("/ai/improve", response_model=ImproveResponse)
    async def improve(
        body: ImproveRequest,
        request: Request,
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> ImproveResponse:
        # ---- Step 0: validate the request ----
        if credentials is None or not credentials.credentials.strip():
            raise HTTPException(
                status_code=401,
                detail="missing API key: send your LiteLLM virtual key in the Authorization header as Bearer sk-...",
            )
        # The caller's virtual key is passed to LiteLLM as is. It is never stored and never logged.
        authorization = f"Bearer {credentials.credentials.strip()}"

        if len(body.text) > settings.ai_max_text_chars:
            raise HTTPException(
                status_code=413, detail=f"text is longer than {settings.ai_max_text_chars} characters"
            )

        empty = ImproveResponse(model=settings.ai_model, sentences=[])
        if not body.text.strip():
            return empty

        client: httpx.AsyncClient = request.app.state.http
        # The glossary for this request (empty if the user turned it off). Taken once and reused:
        # a rewrite takes seconds, and the glossary may be edited meanwhile.
        book = state.glossary if body.glossary else _NO_TERMS

        # ---- Step 1: split into sentences, reusing LanguageTool's result (free) ----
        lt_json = await run_languagetool(client, body.text, body.language)
        code = language_code(lt_json, body.language)
        sentences = sentences_from_ranges(body.text, lt_json.get("sentenceRanges"), merge_clauses=is_chinese(code))
        # English name of the text's language. The prompt names it and says not to translate.
        language = language_name(lt_json)
        in_source = book.profile.is_source_language(code, language)
        if not sentences:
            return empty
        if len(sentences) > settings.ai_max_sentences:
            raise HTTPException(
                status_code=413,
                detail=f"text has {len(sentences)} sentences, the limit is {settings.ai_max_sentences}",
            )

        # ---- Step 2: the first sentence goes alone ----
        # 1. A bad key or an exhausted budget is rejected here, and the whole request stops
        #    instead of every sentence failing in turn.
        # 2. The provider's prompt cache is created by the first call; later sentences can only
        #    get the cache discount once it has finished.
        try:
            first = await ask_one(client, authorization, sentences[0], book, language, in_source, stop_on_reject=True)
        except LLMRejected as exc:
            # Pass LiteLLM's status and message through: 401 is a bad key, 400 or 429 usually budget or rate limit.
            raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

        # ---- Step 3: look up the model price, after the first call so a bad key costs no lookup ----
        # The lookup uses the backend's admin key: keys that may only call models get 403 on model
        # info. The caller's key is tried only when no admin key is configured. A missing price is
        # fine: the amount falls back to the one in LiteLLM's response header.
        lookup = f"Bearer {settings.litellm_admin_key}" if settings.litellm_admin_key else authorization
        price = await request.app.state.prices.get(client, settings.litellm_url, settings.ai_model, lookup)

        # ---- Step 4: the remaining sentences run concurrently, with a limit ----
        limit = asyncio.Semaphore(settings.ai_concurrency)

        async def limited(sentence: Sentence):
            async with limit:
                return await ask_one(client, authorization, sentence, book, language, in_source, stop_on_reject=False)

        # gather returns results in the order given, so sentence order is kept.
        rest = await asyncio.gather(*(limited(sentence) for sentence in sentences[1:]))

        # ---- Step 5: turn each reply into a result ----
        results = [build_result(sentence, reply, price, book) for sentence, reply in zip(sentences, [first, *rest])]
        return ImproveResponse(model=settings.ai_model, sentences=results)

    async def ask_one(
        client: httpx.AsyncClient,
        authorization: str,
        sentence: Sentence,
        book: Glossary,
        language: str,
        in_source: bool,
        stop_on_reject: bool,
    ) -> LLMReply | Exception:
        """Ask the model about one sentence. A failure is returned as the result, and build_result
        marks that sentence as an error.

        language: English name of the language the text is written in.
        in_source: the text is written in the glossary's source language, so source terms in
        it are not treated as untranslated.
        stop_on_reject: a rejection by LiteLLM is raised instead, stopping the whole request.
        """
        try:
            # Only the terms that occur in this sentence, not the whole glossary.
            lines = book.prompt_lines(sentence.text, chinese_terms=not in_source)
            source = book.profile.source_name if book.profile.has_source and not in_source else ""
            return await ask_model(client, settings, authorization, sentence.text, lines, language, source)
        except LLMRejected as exc:
            if stop_on_reject:
                raise
            return exc
        except LLMFailed as exc:
            return exc

    def build_result(sentence: Sentence, reply: LLMReply | Exception, price: ModelPrice | None, book: Glossary) -> SentenceResult:
        """Turn the model's reply for one sentence into the response format."""
        base = {"offset": sentence.offset, "length": sentence.length, "text": sentence.text}

        if isinstance(reply, Exception):
            # The call failed: no usage, so no cost.
            return SentenceResult(**base, status="error", error=str(reply))

        # Once the model has answered, the money is spent. Compute usage and cost first and attach
        # them whether or not parsing succeeds.
        cost = compute_cost(reply.usage, price, reply.header_cost)

        try:
            raw_edits = parse_edits(reply.content)
        except ValueError as exc:
            return SentenceResult(**base, status="error", error=str(exc), usage=reply.usage, cost=cost)

        # Edits that touch glossary terms are dropped here and counted in dropped_edits.
        edits, dropped = locate_edits(sentence, raw_edits, allowed=book.allows_edit)
        return SentenceResult(
            **base,
            status="changed" if edits else "unchanged",
            edits=edits,
            dropped_edits=dropped,
            usage=reply.usage,
            cost=cost,
        )

    return app


# uvicorn looks for this name: uvicorn app.main:app
app = create_app()
