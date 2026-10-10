# Deployment

## What you need

- A Linux server with Docker and the compose plugin. LanguageTool is given a 2 GB Java heap; plan for about 4 GB of memory in total.
- A CPU that supports x86-64-v2. The LiteLLM image refuses to start otherwise (`Fatal glibc error: CPU does not support x86-64-v2`). On a virtual machine, set the CPU type to pass through the host CPU.
- For AI rewriting: an API key of a model provider (OpenAI or compatible), or a self-hosted model.
- For the Word add-in: a host name with an HTTPS certificate that users' computers trust. Office requires HTTPS for add-ins.

## Two ways to run the stack

### A. Standalone

`docker-compose.yml` in the repository root. Caddy is the entry point.

```sh
cp .env.example .env     # set POSTGRES_PASSWORD, LITELLM_MASTER_KEY, LITELLM_SALT_KEY
docker compose up -d --build
```

With the defaults it serves plain HTTP: the backend at `http://<server>/api/` and the LiteLLM admin UI at `http://<server>:4000/ui`. That is enough for the browser extension on a trusted network.

For HTTPS, set real host names in `.env`:

```
LANGFAIX_SITE=langfaix.example.com
LITELLM_SITE=langfaix-litellm.example.com
LITELLM_PUBLIC_URL=https://langfaix-litellm.example.com
```

Caddy then obtains certificates by itself, which requires the server to be reachable from the internet on ports 80 and 443.

> This file has not been run on a clean machine yet. It has the same services as option B, which is the one in production use.

### B. Behind an existing Traefik

`deploy/examples/behind-traefik/`. Traefik owns ports 80 and 443, terminates HTTPS and obtains certificates; Caddy sits behind it on plain HTTP.

This is the setup for **a server on an internal network**: Traefik gets Let's Encrypt certificates with the DNS-01 challenge, which needs no port open to the internet. The host names are public DNS records that point at the server's internal address. Users reach the server from inside the network or through a VPN, and their computers trust the certificate without installing anything.

- `traefik.yml` is an example Traefik stack with a certificate resolver named `le` (Cloudflare DNS). If you already run Traefik, add the resolver to it instead.
- `docker-compose.yml` is the langfAIx stack. It is written so it can be pasted into Portainer's stack editor: no file mounts, the Caddyfile is inline.

The backend image must exist on the host as `langfaix-backend:dev`:

- from a checkout: `docker build -t langfaix-backend:dev .`
- without a checkout on the host: run `deploy/pack-backend.ps1` on your own computer, upload `deploy/build/langfaix-backend.tar` to the host and build it there (in Portainer: Images, Build a new image).

Notes from running this setup:

- Let's Encrypt limits failed validations (five per host name per hour). When a certificate fails, read Traefik's log before restarting it.
- If the firewall blocks outgoing DNS queries, Traefik cannot verify the challenge record itself. Enable the two `propagation` flags that are commented out in `traefik.yml`.
- With compose `configs` plus `content`, a container is not recreated when only the content changes. That is why the Caddyfile is passed as an environment variable.

### Other ways to get HTTPS on an internal network

- Your organisation's internal certificate authority, if users' computers already trust it: give Caddy the certificate and key with the `tls` directive.
- `tls internal` in the Caddyfile and Caddy's root certificate installed on every user's computer.

Publicly trusted certificates are only issued for host names, never for internal IP addresses.

## Set up LiteLLM

Open the LiteLLM admin UI (`/ui` on the LiteLLM host name) and sign in with `admin` and your `LITELLM_MASTER_KEY`.

1. **Add a model.** Set the Public Model Name to exactly `langfAIx-model-1`. For the API key enter `os.environ/OPENAI_API_KEY`, so the real key never passes through a browser and is not stored in the database. The Test Connect button rejects that notation on purpose; test in the Playground instead.
2. **Create a virtual key per user.** Key type: LLM API (a key that may only call models). Models: `langfAIx-model-1`. Give the key a name (alias) and, if you like, a monthly budget.
3. **Name the first glossary admins** in `GLOSSARY_ADMINS`: the aliases of their virtual keys, comma separated. Further roles are granted on the admin page under People.

To switch models later, add the new model under the same Public Model Name and delete the old entry. Keeping two entries with the same name makes LiteLLM alternate between them.

If AI calls fail with `The requested model 'langfAIx-model-1' is not available for this API key`, the key's model list does not contain exactly that name. The LiteLLM container log shows the names the key may use.

### Self-hosted models

Add the model in LiteLLM with the `hosted_vllm` (or `ollama`) provider and the address of its OpenAI-compatible endpoint, again under the Public Model Name `langfAIx-model-1`. No text then leaves your network. langfAIx shows tokens but no amount for self-hosted models.

## Check the deployment

```sh
curl https://<host>/api/healthz
```

returns `{"status":"ok","glossary_terms":0,"glossary_storage":"ok"}`. On Windows, three scripts exercise a running server:

- `deploy/test-litellm.ps1 -Server <litellm url>`: one model call, with usage and cost headers
- `deploy/test-improve.ps1 -Api https://<host>/api`: an AI rewrite, printed as cost cards (this spends a fraction of a cent)
- `deploy/test-glossary.ps1 -Api https://<host>/api -LiteLLM <litellm url>`: adds, checks, changes and deletes a test term

## Give the front ends to users

### Browser extension

```powershell
powershell -ExecutionPolicy Bypass -File deploy/pack-extension.ps1 -ApiUrl https://<host>/api
```

produces `deploy/build/langfaix-extension-<version>.zip` and an install guide with your address filled in. Users unzip it, open `chrome://extensions`, turn on Developer mode and choose Load unpacked. Run `npm run packed -- https://<host>/api` in `e2e` before handing it out.

- Bump `version` in `browser-extension/manifest.json` before each release.
- Users must unpack updates into the same folder. An unpacked extension's ID derives from its folder, and a new ID means the settings are gone.
- Users who restrict the extension to specific sites must add the server's host name to that list.

### Word add-in

```powershell
powershell -ExecutionPolicy Bypass -File deploy/pack-word-addin.ps1 -ApiUrl https://<host>/api
```

produces the manifest, a zip and an install guide. Users unzip and double-click `Install.cmd`, which registers the manifest for the current Windows user (no administrator rights). The add-in's pages themselves are served by the backend.

- Validate a changed manifest with `npx office-addin-manifest validate <file>`. With the slightest fault Word silently does not show the add-in.
- Changing the host name or the ribbon means every user installs the new zip. Changing only the pages does not.
- Managed computers may forbid running `.cmd` files or PowerShell scripts, or sideloading add-ins. Check with your IT department. For larger rollouts, a Microsoft 365 administrator can deploy the same manifest centrally.

## Adjust the AI prompt

The prompt is in `backend/app/prompt.py`. Two parts of it can be changed without touching code, by setting environment variables (in `.env`, or as stack variables in Portainer) and restarting the backend:

- `AI_PROMPT_DOMAIN`: what your documents are about. It replaces `technical product documentation` in the opening line. For example `legal contracts` or `customer support articles`.
- `AI_PROMPT_EXTRA`: style preferences of your team, appended after the rules, such as `Use British spelling. Prefer short sentences.` The model is told to follow them only where they do not conflict with the rules.

The rules themselves (make minimal edits, never change product names or versions, copy `original` exactly, the JSON shape of the reply) are **not configurable on purpose**. `backend/app/edits.py` parses the reply and locates every edit by string search; a prompt that changes the reply format makes every rewrite fail. If you edit `SYSTEM_PROMPT` in the source, rebuild the image and run `python -m pytest` in `backend`.

The glossary terms found in a sentence are added after the prompt automatically, so the prompt does not need to mention your terminology.

The prompt also follows the language the user chose. For English it is the text in `prompt.py`. For any other language the word English in "professional English" and "plain English" is replaced by that language's name (taken from LanguageTool's reply), and one paragraph is added that tells the model to keep the sentence in that language and not to translate it. Rewriting in languages other than English has not been tried with real model calls yet.

## Adapt the glossary to your languages

The glossary was built for a team that writes English from Chinese sources, and that is the default. A row has a standard English term (required), an optional term in a **source language**, wrong forms, a category, an "applies to" note and a free note. Three settings change what it is about, without any code change:

| Variable | Default | Meaning |
|---|---|---|
| `GLOSSARY_SOURCE_LANGUAGE` | `Chinese` | the name shown for the source column, in messages and in the AI prompt, and recognised as a column header on import |
| `GLOSSARY_SOURCE_SCRIPT` | `han` | how source text is recognised inside English text: `han`, `cyrillic`, `hangul`, `kana`, `arabic`, `hebrew`, `thai`, `devanagari`, `greek`, or `none` |
| `GLOSSARY_CATEGORIES` | Product, Feature, Abbreviation, Version, Command, Other | the default categories, comma separated. Categories already in use are listed too |

- **English only:** set `GLOSSARY_SOURCE_SCRIPT=none`. The source column and its import mapping disappear from the admin page, and nothing is reported for source text left in English text. Standard terms (not misspellings) and wrong forms still work, and so does the AI protection of terms.
- **Another source language:** for example `GLOSSARY_SOURCE_LANGUAGE=Russian` and `GLOSSARY_SOURCE_SCRIPT=cyrillic`. The "untranslated text left in English" check looks for terms of that script. It has been tried with Chinese only; scripts that put spaces between words (Cyrillic and others) may need tuning.
- A mistyped `GLOSSARY_SOURCE_SCRIPT` stops the backend at startup, with a message that lists the valid values.
- The database columns keep their internal names (`zh` and so on) whatever you set. Changing the settings later does not touch stored rows.
- The target language of the glossary is English. The language of the text is chosen per user, in the extension's options and in the Word add-in's settings.
- When a user writes in the glossary's source language (Chinese text with the default settings), source terms are not reported as untranslated and the model is not told to translate them. English terms are still protected and wrong forms are still reported.

## Back up the glossary

The glossary lives in the Postgres volume `langfaix-pgdata`. There is no automatic backup. The simplest backup is Export Excel on the admin page; the exported file can be imported again as it is. For a full backup use `pg_dump` on the `langfaix` database.

## Settings of the backend

| Variable | Default | Meaning |
|---|---|---|
| `LANGUAGETOOL_URL` | `http://languagetool:8010` | where LanguageTool is |
| `LITELLM_URL` | `http://litellm:4000` | where LiteLLM is |
| `LITELLM_ADMIN_KEY` | empty | the backend's own LiteLLM admin key: identifies callers, reads model prices |
| `AI_MODEL` | `langfAIx-model-1` | the model name sent to LiteLLM |
| `DATABASE_URL` | empty (in-memory SQLite) | SQLAlchemy URL of the glossary database |
| `GLOSSARY_ADMINS` | empty | the initial glossary admins |
| `ROOT_PATH` | empty | the public path prefix, `/api` behind the proxy |
| `MAX_TEXT_CHARS` | `20000` | longest text `/check` accepts |
| `GLOSSARY_SOURCE_LANGUAGE`, `GLOSSARY_SOURCE_SCRIPT`, `GLOSSARY_CATEGORIES` | Chinese, `han`, the usual six | what the glossary is about, see "Adapt the glossary to your languages" |
| `AI_PROMPT_DOMAIN` | empty (technical product documentation) | what your documents are about, used in the opening line of the AI prompt |
| `AI_PROMPT_EXTRA` | empty | extra style preferences appended to the prompt, e.g. `Use British spelling.` |
| `AI_MAX_TEXT_CHARS`, `AI_MAX_SENTENCES` | `5000`, `30` | limits of one AI rewrite. The extension has the same numbers in `lib/scope.js` |
| `AI_CONCURRENCY` | `4` | concurrent model calls per request |
