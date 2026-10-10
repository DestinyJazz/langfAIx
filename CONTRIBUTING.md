# Contributing

Thank you for looking at langfAIx. Bug reports and reproductions are the most useful contributions right now: tell us which site or editor, what you typed and what happened.

## Before you send code

langfAIx is licensed under the AGPL-3.0 and is also offered under a commercial license. To keep that possible, the maintainer must hold the rights to all code in the repository. By opening a pull request you agree that your contribution is licensed under the AGPL-3.0 **and** that the maintainer may also distribute it under other license terms. Please say so in the pull request. For anything larger than a small fix, open an issue first.

Please do not copy code from projects without a license, or with a license that is incompatible with the AGPL-3.0.

## Working on the code

- No build step anywhere. The extension and the add-in are plain JavaScript modules; the backend is Python with FastAPI.
- Run the tests that cover what you changed (see the table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). The unit tests need no network and no keys.
- A site where the extension "does nothing" gets a reproduction in `e2e/sites.mjs` first, then the fix.
- Files in `browser-extension/lib/` are shared with the Word add-in and must not use `chrome.*`. Pass what you need as a parameter.
- Comments are in English and explain why, not what.
- No real terminology, host names or keys in code, tests or examples. Tests use made-up terms.
- Pin the versions of images and packages.

## Reporting security problems

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.
