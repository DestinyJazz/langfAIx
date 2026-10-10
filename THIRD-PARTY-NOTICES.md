# Third-party components

langfAIx itself is licensed under the AGPL-3.0 (see [LICENSE](LICENSE)). It uses the components below. None of their source code is included in this repository; they are pulled as container images or installed as packages.

## Services (separate containers, used over HTTP or SQL)

| Component | Version in the examples | License |
|---|---|---|
| [LanguageTool](https://github.com/languagetool-org/languagetool), through the `erikvl87/languagetool` image | 6.8 | LGPL-2.1-or-later |
| [LiteLLM](https://github.com/BerriAI/litellm) proxy | v1.103.3 | MIT (the parts outside its `enterprise/` directory) |
| [PostgreSQL](https://www.postgresql.org/) | 16 | PostgreSQL License |
| [Caddy](https://github.com/caddyserver/caddy) | 2.11.6 | Apache-2.0 |
| [Traefik](https://github.com/traefik/traefik) (optional) | v3.6 | MIT |

LiteLLM's repository has an `enterprise/` directory under a separate commercial license (the BerriAI Enterprise License). langfAIx does not use it: it needs only the standard proxy endpoints (`/v1/chat/completions`, `/v1/model/info`, `/key/info`) and virtual keys with budgets. If you enable LiteLLM's enterprise features in your own deployment, that license applies to you.

## Backend packages (`backend/requirements.txt`)

| Package | License |
|---|---|
| FastAPI | MIT |
| Uvicorn | BSD-3-Clause |
| HTTPX | BSD-3-Clause |
| SQLAlchemy | MIT |
| psycopg | LGPL-3.0 |
| openpyxl | MIT |

Their own dependencies (Starlette, Pydantic and others) come with permissive licenses; `pip` installs each with its license file.

## Loaded at run time, not distributed

- `office.js` is loaded by the Word add-in from Microsoft's servers, as Microsoft requires.

## Development only

| Package | License |
|---|---|
| pytest | MIT |
| playwright-core | Apache-2.0 |
