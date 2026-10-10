# Architecture

## Overview

```
browser extension ─┐
                   ├─ HTTPS ─→ reverse proxy (Caddy, optionally behind Traefik)
Word add-in ───────┘              ├─ /api/*            langfAIx backend (FastAPI)
                                  │                      ├─ LanguageTool: rule checks
                                  │                      ├─ LiteLLM: virtual keys, budgets, cost
                                  │                      │     ├─→ OpenAI or another provider
                                  │                      │     └─→ a self-hosted model (optional)
                                  │                      └─ Postgres: the glossary
                                  └─ LiteLLM admin UI (its own host name, for admins)
```

Only the reverse proxy is exposed. LanguageTool, LiteLLM and Postgres publish no ports.

All logic lives in the backend. The front ends only display results and replace text. That keeps prompts and glossary in one place, hides the prompt and the provider key from users, and keeps the front ends small.

## Backend (`backend/app`)

| Endpoint | What it does |
|---|---|
| `POST /check` | forwards text to LanguageTool, applies the glossary, returns issues and sentence boundaries |
| `POST /ai/improve` | splits the text into sentences and calls the model once per sentence; returns edits and the cost of each sentence |
| `/glossary/...` | lookup, add, change, delete, import, export, people and roles, change log, sign-in |
| `GET /admin/` | the glossary admin page (static files) |
| `GET /addin/...` | the Word add-in's pages |
| `GET /healthz` | liveness, plus the number of glossary rows and whether the database is connected |
| `GET /docs` | the generated API documentation |

The service is published under `/api`. The proxy strips `/api` before forwarding, so the paths in the code are `/check` and so on, and the app is started with `ROOT_PATH=/api`.

Offsets and lengths in responses are UTF-16 code units, the same as JavaScript string indexes, so front ends can use them directly (`app/textpos.py`).

### Languages

`language` in a request is a LanguageTool language code and is passed on unchanged (default `en-US`). The backend has no list of its own; the list users choose from is `browser-extension/lib/languages.js`, shared by the extension and the Word add-in. Three things follow the language:

- **The AI prompt** (`prompt.py`): the language's English name, taken from LanguageTool's reply without the region, replaces "English" in the prompt, and a paragraph tells the model not to translate. For English the prompt is the default one.
- **Chinese sentence splitting** (`sentences.py`, `_merge_clauses`): LanguageTool cuts Chinese at commas and spaces, so every English word inside Chinese text becomes a piece of its own. The pieces are joined until one ends with end punctuation. `/check` and `/ai/improve` use the same function, so both agree on what a sentence is.
- **The glossary**: text written in the glossary's source language (Chinese by default) does not get "untranslated term" issues, and the model is not told to translate such terms.

### `/ai/improve`

- The caller's virtual key arrives as `Authorization: Bearer sk-...` and is passed to LiteLLM unchanged. It is never stored or logged.
- Sentence splitting reuses the `sentenceRanges` in LanguageTool's reply, then splits again at line breaks.
- The first sentence is sent alone. A bad key or an exhausted budget is rejected there and the whole request stops. The remaining sentences then run concurrently, with a limit.
- Model prices are read from LiteLLM's `/v1/model/info` with the backend's own admin key and cached for ten minutes. Without a price, the amount in LiteLLM's response header is used. Self-hosted models show tokens only.
- The model returns `{original, replacement, reason}` items, never positions. The code locates each edit by string search, preferring whole-word matches. Edits that cannot be located, change nothing, overlap, or touch a glossary term are dropped and counted in `dropped_edits`.
- A malformed model reply marks that sentence as an error but still reports usage and cost, because the money is spent.
- Limits: 5,000 characters and 30 sentences per request (`AI_MAX_TEXT_CHARS`, `AI_MAX_SENTENCES`).

### AI design decisions

- **Only on a click.** The reason is privacy, not cost: the extension works on every site, so an automatic AI would send everything a user types anywhere to the model provider.
- **One call per sentence**, so the cost shown for each sentence is real, not estimated.
- **Minimal edits.** The prompt asks for the smallest set of changes and forbids touching product names, versions, commands and technical terms.
- **Only the edits are returned**, not a rewritten sentence, because output tokens cost more than input tokens.
- **No streaming**, because LiteLLM does not return the cost header on streamed responses.
- **The glossary is not sent whole.** Only the terms that occur in the sentence are added to the prompt, so the cost per sentence does not grow with the glossary.

### Team glossary

A row is one Chinese term with one English term. The same Chinese term may have several rows (different contexts or product versions). A row can list wrong forms.

- **Storage** (`store.py`): Postgres, in a database of its own, through SQLAlchemy Core. The same code runs on SQLite in the tests.
- **Matching** (`glossary.py`): the text is cut into words and each word is looked up in an index of "terms that start with this word". The cost depends on the length of the text and hardly on the size of the glossary (5,000 rows against 20,000 characters takes well under a second in the tests). Do not replace this with one large regular expression.
- A prepared copy of the glossary is kept in memory and rebuilt after every write, so `/check` never touches the database. This assumes a single backend process.
- **What `/check` does with it**: a standard term is not a misspelling; a wrong form is reported with the standard form as the suggestion; a Chinese term left in English text is reported when the text has at least three English words and the Chinese stands alone.
- **Identity** (`identity.py`): the root of a user's identity is their LiteLLM virtual key. The backend hashes it and asks LiteLLM's `/key/info` with its own admin key. Keys handed to users are of the "LLM API" type and cannot look themselves up, which is intended.
- **Name and password** (`accounts.py`): a convenience on top of the key. Passwords are stored as scrypt hashes, session tokens as SHA-256. Every request still re-checks the key with LiteLLM (cached for five minutes), so disabling a key ends the password sign-in as well.

## Browser extension (`browser-extension`)

Plain JavaScript, no build step. Chrome loads the folder as it is.

- Only the background service worker talks to the server. Pages, popup and options send it messages. Because it has host permissions, the server needs no CORS configuration for the extension.
- `content/loader.js` is injected everywhere and is tiny. It loads the real code only when the caret enters a field.
- Three kinds of field, each behind an adapter with the same methods:
  - `textarea` and `input` (`control.js`, `overlay.js`): a transparent mirror on top of the field carries the squiggles.
  - `contenteditable` (`editable.js`): the CSS Custom Highlight API marks ranges without changing the page's content.
- Text is replaced with `execCommand("insertText")`, so undo works and the page's own code sees normal input events.
- Cards and the corner badge are drawn on the outermost page, so they are not clipped by editor iframes.
- Logic that does not need a browser is in `lib/` and tested with `npm test`.
- Fields that are never checked: password, email, name, address, card and search inputs (`lib/sensitive.js`), code editors and monospace fields with spellcheck turned off (`lib/codelike.js`), quoted mail.

## Word add-in (`word-addin`)

Plain HTML and JavaScript, served by the backend under `/api/addin/`. Same origin as the API, so no CORS and no server address to enter.

- Squiggles use Word's annotation API (WordApi 1.7 and 1.8, Microsoft 365 only). Word draws them and shows a small popup. Everything else is in the task pane.
- Word has no scroll event, so the task pane polls the pages on screen (WordApiDesktop 1.2) about every 700 ms, checks paragraphs it has not seen, and re-checks paragraphs whose text changed. Older Word versions fall back to following the cursor.
- A page of paragraphs is joined into one `/check` request and the results are mapped back (`lib/pages.js`).
- Word's API cannot address text by position, only by search. Replacements therefore compute which occurrence to replace and verify it first (`lib/apply.js`).
- The add-in imports the browser extension's `lib/` files directly. Those files must not use `chrome.*`.
- `office.js` must be loaded from Microsoft's servers, so users need internet access.

`e2e/fake-office.js` is a small fake Word for the automated tests. It proves the pages have no script errors and that position conversion is right. It cannot prove that real Word draws in the right place; that has to be tried in Word, and `spike.html` (the Diagnostics link in the task pane) exists for that.

## Tests

| Command | Needs | What it covers |
|---|---|---|
| `cd backend && python -m pytest` | nothing | the backend, with fake LanguageTool and LiteLLM |
| `cd browser-extension && npm test` | nothing | the extension's `lib/` |
| `cd word-addin && npm test` | nothing | the add-in's `lib/` |
| `cd e2e && npm run admin` | Chrome | the glossary admin page against a local backend |
| `cd e2e && npm run popup` | Chrome | the extension's popup and options page |
| `cd e2e && npm run addin` | Chrome, `deploy/pack-backend.ps1` run first | the add-in's pages with the fake Word |
| `cd e2e && npm run overlay -- <api url>` | Chrome, a running server | squiggle alignment screenshots, with a fake AI |
| `cd e2e && npm run extension -- <api url>` | Edge, a running server | the real extension loaded into a browser |
| `cd e2e && npm run sites -- <api url>` | Edge, a running server, internet | TinyMCE, srcdoc iframes, Google Translate |
| `cd e2e && npm run packed -- <api url>` | Edge, a running server, `deploy/pack-extension.ps1` run first | the zip handed to users |

The `e2e` scripts use the browsers installed on the machine, headless, with temporary profiles. The pack scripts are PowerShell and Windows only for now.
