# Claude Usage Widget

[![CI](https://github.com/OWNER/claude-usage-widget/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/claude-usage-widget/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small always-on-top Windows widget that shows your Claude subscription quota at a glance: the
5-hour session window and the 7-day window, each with percent used and a live countdown to reset.

No more opening `claude.ai/settings/usage` to find out whether you have room for one more prompt.

<!-- Replace with a real capture of the bar and panel: docs/screenshot.png -->
```
┌────────────────────────────────────────────┐
│  ((•‿•))  5h  ████░░░░░░░░  23%   3h45m    │
│   ᴗᴥᴥᴥ    7d  ████████░░░░  51%   13h19m   │
│            PRO   just now                  │
└────────────────────────────────────────────┘
```

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by Anthropic.
> "Claude" is a trademark of Anthropic. The widget reads the usage endpoint Claude Code itself uses,
> which is undocumented and may change at any time.

## Features

- **Ambient bar** with both windows, colour-coded green / amber / red, and reset countdowns.
- **Detail panel** (click the bar): exact reset times, plan, data source, and the per-model weekly
  limit when your account has one.
- **Notifications** when a window crosses 85% and 95%, and when a nearly-spent session window resets.
- **Tray icon** that turns amber and red with usage, so you can hide the bar entirely.
- **Works offline gracefully**: backs off on rate limits, shows cached data as stale, and can fall
  back to numbers from the Claude Code statusline.
- **Private**: no telemetry, no account other than your own, and tokens never reach the UI process.

## Install

Requires Windows 10/11 and an active Claude subscription you have signed in to with
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) (run `claude` once and log in).

Download from the [latest release](https://github.com/OWNER/claude-usage-widget/releases/latest):

| File | Use it when |
|---|---|
| `claude-usage-widget-<version>-setup.exe` | You want a normal install with a Start menu entry and uninstaller (per-user, no admin). |
| `claude-usage-widget-<version>-portable.exe` | You want a single exe you can run from anywhere. |

The builds are not code-signed, so Windows SmartScreen may warn on first run. Choose **More info >
Run anyway**. If you would rather not, [build it yourself](#build-from-source) - it takes a minute.

After launch the widget appears in the top-left corner and in the system tray. Drag it anywhere.

## The critter

The small creature on the left is drawn procedurally on a canvas and animated with the quota. It is
an original design, not any existing character.

| Mood | When | How it looks |
|---|---|---|
| `ok` | under 60% | bouncing along, ears wagging, occasionally blinks |
| `warn` | 60-85% | slower trudge, a sweat drop now and then, body tints pink |
| `alert` | over 85% | panting, sweating, a pulsing `!` |
| `critical` | **95% and up** | wide eyes with pinprick pupils, raised brows, gaping mouth, flushed, heavy sweat, a fast-pulsing red `!!` |
| `spent` | account is rate limited | exhausted, barely moving, panting |
| `sleep` | no data yet | asleep with floating `z`s |

`critical` is the "almost out" band: high enough that the next request may be refused, low enough
that you are not actually throttled yet. The worse of the two windows always wins, so a comfortable
weekly window never masks a nearly-exhausted session one.

It is drawn rather than shipped as a GIF on purpose. A looping GIF cannot know the quota, so it
would contradict the numbers printed right next to it - a cheerful animation beside a 96% bar makes
the number harder to notice, not easier. Drawing it also means no binary assets, no encoder, and
clean scaling on any display. It renders at 24fps and `requestAnimationFrame` stops entirely while
the window is hidden.

To drop it, remove the `<canvas id="critter">` from `bar.html` and its styles; `bar.ts` already
treats the critter as optional.

## Interaction

- **Drag** the bar to move it. Position is persisted and clamped to a visible work area, including
  when a monitor is disconnected or its scaling changes.
- **Click** the bar to open the detail panel. **Esc** closes it.
- **Tray**: left-click shows or hides the bar; right-click for the menu (show widget, click-through,
  refresh now, launch at login, quit, and "Update available" when there is one).
- **Click-through** uses `setIgnoreMouseEvents(true, { forward: true })`, so clicks reach the app
  underneath. Toggle it back from the tray or the panel.

Colours are green below 60%, amber 60-85%, and red above 85% for either window. A
`status: rate_limited` response forces red regardless of the percentage. A window whose reset time
has passed shows as available immediately, and the widget polls right after each reset to confirm.

Settings in the panel: click-through, launch at login, show widget, notifications, and update checks.

## Build from source

Requires Node.js 20+ (CI uses 22).

```bash
npm install
npm start
```

| Command | What it does |
|---|---|
| `npm start` | Build and launch the widget |
| `npm run build` | Compile main/preload (CommonJS) and renderer (ES2022) into `dist/` |
| `npm run typecheck` | Typecheck every source file without emitting |
| `npm test` | Run the unit tests (`node:test`) |
| `npm run dist` | Build the installer and portable exe into `release/` |
| `npm run icons` | Regenerate the tray and app icons in `assets/` |

There are no runtime npm dependencies - only `electron`, `electron-builder`, `typescript` and
`@types/node` in devDependencies.

### Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then tag and push: `git tag v1.2.0 && git push --tags`.
3. The Release workflow builds both exes and attaches them to a **draft** GitHub Release. Review it
   and publish.

## How it works

```
src/main/
  main.ts         entry point; also the statusline capture mode
  store.ts        config.json in %APPDATA%/claude-usage-widget
  credentials.ts  locate, read, and atomically rewrite ~/.claude/.credentials.json
  oauth.ts        token refresh, /api/oauth/usage, /api/oauth/profile
  claudecli.ts    run the local `claude` CLI (version probe, auth status)
  normalize.ts    response shapes -> UsageSnapshot (the only place that knows field names)
  poller.ts       scheduler, reset-aligned polls, 429 backoff, source precedence
  statusline.ts   register/unregister statusLine; stdin capture mode
  notify.ts       threshold and reset notifications
  update.ts       daily GitHub release check (notify only)
  log.ts          size-capped diagnostic log with token masking
  window.ts       bar + panel windows, position persistence, click-through
  tray.ts         tray icon and menu
  ipc.ts          the entire renderer-facing API surface
src/preload/      contextBridge -> narrow, typed IPC
src/renderer/     bar + panel + the critter + shared formatting, plain HTML/CSS/compiled JS
```

The renderer runs with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. All
credential handling and all network I/O happens in the main process. **The OAuth access token and
refresh token never cross the IPC boundary** - the renderer only ever receives a normalized
`UsageSnapshot`.

### Data source

Primary is the OAuth endpoint `GET https://api.anthropic.com/api/oauth/usage`, using the login Claude
Code already stored for you. It needs a `User-Agent: claude-code/<version>` header; without it the
same token gets a 429 that is easy to misdiagnose as a quota problem. The widget probes the installed
Claude Code version (`claude.exe` or the npm `claude.cmd` shim) before its first request.

The response comes in two generations and `normalize.ts` handles both, because the flat keys are
`null` on some accounts while the data lives in a `limits[]` array:

- flat: `five_hour` / `seven_day` with `utilization` (0-100) and an ISO-8601 `resets_at`
- structured: `limits[]` with `kind: session | weekly_all | weekly_scoped`, `percent`, `severity`

`five_hour` / `kind: "session"` maps to the session window, `seven_day` / `kind: "weekly_all"` maps to
the weekly window, and the first `weekly_scoped` entry is shown in the panel as the per-model limit.

### Polling and failure behaviour

The configured interval (default and minimum 5 minutes) is pulled forward only to land just after an
upcoming window reset - at most one extra request per reset. The widget also refreshes after the PC
wakes or is unlocked. The plan badge is fetched at most hourly. Data is displayed by walking a
precedence ladder:

1. fresh OAuth data
2. cached OAuth data (last fetch failed)
3. the Claude Code statusline snapshot
4. nothing, shown as "no data"

| Situation | Behaviour |
|---|---|
| `429` | serves the last good snapshot with a *throttled* badge, backs off 15 -> 30 -> 30 -> 60 min |
| `403` | stops polling until relaunch and shows the sign-in-required state |
| `401` | shows the sign-in-required state, keeps the cached snapshot |
| network error | serves the cache and marks it stale |
| `resets_at` in the past | rendered as a rolled-over (available) window, never negative |

## The credential file, and why it is written

`credentials.ts` reads `claudeAiOauth` from the first readable of:

1. `$CLAUDE_SECURESTORAGE_CONFIG_DIR/.credentials.json`
2. `$CLAUDE_CONFIG_DIR/.credentials.json`
3. `~/.claude/.credentials.json`

The token needs the `user:profile` scope. A token created by `claude setup-token` does not have it and
will 403; the widget shows a clear "sign in with Claude Code" state instead. Windows Credential
Manager is deliberately **not** read - the service naming is unverified and a wrong guess risks a
destructive write.

**The widget writes to this one file, and only when the token rotates.** Claude Code's refresh tokens
are single-use, so when the access token is refreshed the new refresh token *must* be persisted or
your Claude Code login breaks. The write is therefore the highest-severity risk in the project, and it
is confined to one function with an explicit contract:

1. Parse the response; require non-empty `accessToken` **and** non-empty `refreshToken`.
2. Merge into the in-memory object that was read, preserving all unknown keys (including unrelated
   top-level keys such as `mcpOAuth`).
3. `JSON.stringify` and write `.credentials.json.tmp` in the **same directory** (rename is only
   atomic within a volume).
4. `fs.renameSync(tmp, target)` - atomic on NTFS.
5. On **any** error before step 4, unlink the tmp file and leave `.credentials.json` untouched.

The writer refuses to write an empty access token, an empty refresh token, or `expiresAt: 0` under any
circumstance. That exact failure mode has zeroed out real users' Claude Code logins, so it is
guarded in code and covered by tests, including five consecutive rotations.

If the file is missing, corrupt, or lacks the scope, the widget shows a sign-in state and never
writes anything.

## The statusline fallback (optional)

Claude Code can hand the widget its own quota numbers. This is the documented escape hatch if the
undocumented usage endpoint ever changes.

Open the widget's detail panel and press **Register**. With your explicit confirmation the widget adds
to `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "<path to widget> statusline" }
}
```

- If a `statusLine` already exists, the button becomes **Replace statusline** and asks for explicit
  confirmation first, showing you the current command.
- The exact previous value is stored in the widget's own config, so **Unregister** restores
  `settings.json` byte-for-byte - including deleting the key again if it was not there before. A
  widget that never registered refuses to unregister rather than guessing.
- Every unrelated key in `settings.json` is preserved, and a `.bak` copy is written before the first
  modification.
- The command points at the exe you registered from. If you move a portable exe, register again.

Restart Claude Code (or start a new session) for it to take effect.

In capture mode the process reads one JSON payload from stdin, writes
`%APPDATA%/claude-usage-widget/usage-snapshot.json` atomically, and **exits 0 immediately**. It never
prompts, never touches the network, and never fails loudly, because Claude Code runs statusline
commands inside its own render loop.

> **Note on Windows stdin.** Electron on Windows is a GUI-subsystem binary, so `process.stdin` is
> constructed but never receives data even when a payload is piped in. The capture path reads file
> descriptor 0 directly, which is verified to work. The descriptor is guarded so a blocking read is
> impossible: a TTY or character device returns "no payload" immediately.

Field names in the statusline dialect differ from the API and are normalized in the same place:
`used_percentage` is a 0-100 float and `resets_at` is **Unix epoch seconds**, not ISO-8601. Either
window may be independently absent, which is normal rather than an error.

## Privacy and network use

The widget talks to:

- `api.anthropic.com` - `/api/oauth/usage` and `/api/oauth/profile`, for your own account only;
- the Anthropic OAuth token endpoint, only when your access token needs rotating;
- `api.github.com` - once a day, to see whether a newer release of this widget exists. Turn this off
  in the panel. Nothing about you is sent beyond a normal HTTPS request.

There is no telemetry. Anthropic's guidance restricts third parties from collecting Claude.ai
credentials; this app never sends your credentials anywhere except Anthropic's own endpoints, and the
single write it performs is the atomic token rotation described above, to a file you already own.

## Troubleshooting

**"signed out" / "no scope".** Run `claude`, sign in, then press **Re-check sign-in** in the panel.
A token from `claude setup-token` will not work; sign in with Claude Code itself.

**"throttled".** The endpoint returned 429. The widget backs off automatically. A missing or wrong
`User-Agent` also causes 429s; check that `claude --version` works in a terminal.

**No data at all.** Press **Re-check sign-in**; the panel shows the exact error, which credential
file was used, and which token host last worked.

**Something else.** Panel > **Open log folder** and look at `main.log` (tokens are masked). Attach
the relevant lines when you [open an issue](https://github.com/OWNER/claude-usage-widget/issues).
When running from source, `CLUW_DEBUG=1` also forwards renderer console output to stdout:

```bash
CLUW_DEBUG=1 npx electron .
```

**Nothing appears.** The widget is in the tray. Left-click the tray icon to toggle it, and check
**Show widget** in the panel.

## Notes for developers

- The renderer is loaded with classic `<script src>` tags, not as ES modules: Chromium refuses
  module scripts over `file://` without `--allow-file-access-from-files`. A classic script cannot
  contain `import`/`export`, and `tsc` appends `export {}` to every external module, so the renderer
  files have no top-level import/export and wrap their bodies in an IIFE. Shared code is published on
  `window` (`format.ts` -> `window.cuwFormat`, `creature.ts` -> `window.cuwCreateCritter`) and loaded
  first; types come from the ambient `src/renderer/api.d.ts`. `test/format.test.ts` runs `format.ts`
  in a `vm` sandbox.
- `tsconfig.renderer.json` sets `isolatedModules: false` for the same reason. The main and preload
  builds keep it on.
- `src/shared/types.ts` is intentionally types-only, so it compiles cleanly into both the CommonJS
  main build and the ES2022 renderer build.
- IPC channel names are duplicated in `src/main/ipc.ts` and `src/preload/index.ts` on purpose: that is
  the trust boundary, and a change on one side should fail to compile rather than silently no-op.
- `tsconfig.json` is typecheck-only (`noEmit`); the two real builds are `tsconfig.main.json` and
  `tsconfig.renderer.json`.
- The userData folder is pinned to `%APPDATA%/claude-usage-widget` in `main.ts`; do not let it follow
  `productName`, or existing installs lose their config and statusline restore data.
- When running from source inside VS Code's terminal, unset `ELECTRON_RUN_AS_NODE` if Electron starts
  as plain Node.

## Scope

Windows only. Builds are not code-signed and there is no auto-installer for updates - the widget
tells you when a release is out and links to it. Out of scope for now: usage history and sparklines,
extra-usage credit balance, multi-account switching, macOS/Linux.

`/api/oauth/usage` is undocumented, so Anthropic could change or remove it. It is isolated entirely
in `oauth.ts` and `normalize.ts` so that a break is a contained fix, and the statusline source is the
documented fallback.

## License

[MIT](LICENSE). Security issues: see [SECURITY.md](SECURITY.md).
