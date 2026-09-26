# Security policy

This widget reads your Claude Code login and, when the access token expires, rotates it and writes
the new token back to `.credentials.json`. Bugs in that path can sign you out of Claude Code, so
security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private
[security advisory form](../../security/advisories/new) for this repository instead. Include:

- the widget version (panel footer or tray tooltip),
- what you did and what happened,
- relevant lines from `%APPDATA%\claude-usage-widget\logs\main.log`.

**Never include tokens or the contents of `.credentials.json`.** The log masks anything shaped like
an Anthropic token, but check before you paste.

You should get a first response within a week.

## What the widget does with your credentials

- Tokens stay in the main process. The renderer (the UI) runs sandboxed and only ever receives
  normalized usage numbers, never a token.
- Network requests go only to `api.anthropic.com` (usage and profile), the Anthropic OAuth token
  endpoint, and, if update checks are on, `api.github.com` for this repository's latest release.
  There is no telemetry.
- The credential file is written only on token rotation, atomically (temp file in the same
  directory, then rename), preserving every unrelated key, and never with an empty token. See
  "The credential file, and why it is written" in the README for the full contract.

## Supported versions

Only the latest release receives fixes.
