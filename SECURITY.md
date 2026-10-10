# Security

## Reporting a vulnerability

Please report vulnerabilities privately, through **Report a vulnerability** on the repository's Security tab (GitHub private vulnerability reporting). Do not open a public issue.

Include what you found, how to reproduce it and which version or commit you tested. You will get an answer as soon as the maintainer can manage; this is a one-person project.

## What is in scope

- The backend (`backend/`), including the glossary admin page and its sign-in.
- The browser extension and the Word add-in.
- The example deployment files in this repository.

Vulnerabilities in LanguageTool, LiteLLM, Caddy, Traefik or Postgres should go to those projects.

## Things worth knowing when you deploy

- `/check` does not require a key. Do not expose the server to the internet without putting something in front of it.
- The backend holds a LiteLLM admin key (`LITELLM_ADMIN_KEY`) to identify callers and read model prices. In the example stacks this is the master key. A key of a `proxy_admin_viewer` user is enough and is the safer choice.
- Anyone with a virtual key who can reach the LiteLLM host name can call the model directly, bypassing the backend. Restrict that host name to administrators if this matters to you.
- Text that users check is sent to your server and not stored by langfAIx. That is a property of the code, not a technical guarantee against a modified server.
