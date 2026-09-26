# Claude Usage Widget

A frameless, always-on-top Windows widget that shows your Claude subscription quota at a glance: the
5-hour session window and the 7-day window, each with percent used and a live countdown to reset.

No more opening `claude.ai/settings/usage` to find out whether you have room for one more prompt.

```
┌────────────────────────────────────────────┐
│  ((•‿•))  5h  ████░░░░░░░░  23%   3h45m    │
│   ᴗᴥᴥᴥ    7d  ████████░░░░  51%   13h19m   │
│            PRO   just now                  │
└────────────────────────────────────────────┘
```

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

## Requirements

- Windows
- Node.js 20+ (developed on Node 24)
- An active Claude subscription, signed in through Claude Code

## Getting started

```bash
npm install
npm start
```

`npm start` builds both TypeScript targets and launches Electron. There are no runtime npm
dependencies - only `electron`, `typescript` and `@types/node` in devDependencies.

Other scripts:

| Command | What it does |
|---|---|
| `npm start` | Build and launch the widget |
| `npm run build` | Compile main/preload (CommonJS) and renderer (ES2022) into `dist/` |
| `npm run typecheck` | Typecheck every source file without emitting |
| `npm test` | Run the unit tests (`node:test`) |
| `node scripts/make-icons.mjs` | Regenerate the tray icons in `assets/` |

## How it works

```
src/main/
  main.ts         entry point; also the statusline capture mode
  store.ts        config.json in app.getPath('userData')
  credentials.ts  locate, read, and atomically rewrite ~/.claude/.credentials.json
  oauth.ts        token refresh, /api/oauth/usage, /api/oauth/profile
  normalize.ts    response shapes -> UsageSnapshot (the only place that knows field names)
  poller.ts       5-minute scheduler, 429 backoff, source precedence
  statusline.ts   register/unregister statusLine; stdin capture mode
  window.ts       bar + panel windows, position persistence, click-through
  tray.ts         tray icon and menu
  ipc.ts          the entire renderer-facing API surface
src/preload/      contextBridge -> narrow, typed IPC
src/renderer/     bar + panel + the critter, plain HTML/CSS/compiled JS
```

The renderer runs with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. All
credential handling and all network I/O happens in the main process. **The OAuth access token and
refresh token never cross the IPC boundary** - the renderer only ever receives a normalized
`UsageSnapshot`.
### Data source

Primary is the OAuth endpoint `GET https://api.anthropic.com/api/oauth/usage`, using the login Claude
Code already stored for you. It needs a `User-Agent: claude-code/<version>` header; without it the
same token gets a 429 that is easy to misdiagnose as a quota problem.

The response comes in two generations and `normalize.ts` handles both, because the flat keys are
`null` on some accounts while the data lives in a `limits[]` array:

- flat: `five_hour` / `seven_day` with `utilization` (0-100) and an ISO-8601 `resets_at`
- structured: `limits[]` with `kind: session | weekly_all | weekly_scoped`, `percent`, `severity`

`five_hour` / `kind: "session"` maps to the session window, `seven_day` / `kind: "weekly_all"` maps to
the weekly window. `weekly_scoped` is parsed but not displayed in v1.

### Polling and failure behaviour

The interval floor is 5 minutes; the widget never tight-loops. Data is displayed by walking a
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
circumference. That exact failure mode has zeroed out real users' Claude Code logins, so it is
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

## Interaction

- **Drag** the bar to move it. Position is persisted and clamped to the nearest display's work area on
  startup, so it is never off-screen after a monitor change.
- **Click** the bar to open the detail panel: exact reset timestamps, account email, tier, data
  source, last successful fetch, and a **Refresh now** / **Re-check sign-in** action.
- **Tray menu**: show/hide the widget, toggle click-through, refresh now, launch at login, quit.
- **Click-through** uses `setIgnoreMouseEvents(true, { forward: true })`, so mousemove still works for
  hover while clicks reach the app underneath. Toggle it back from the tray or the panel.

Colours are green below 60%, amber 60-85%, and red above 85% for either window. A
`status: rate_limited` response forces red regardless of the percentage.

## Terms of service

Anthropic's legal and compliance guidance restricts third parties from collecting Claude.ai
credentials. This app is local-only and read-mostly: it reads a login you already created, makes no
telemetry, and talks to exactly two Anthropic endpoints (`/api/oauth/usage`, `/api/oauth/profile`)
plus the token endpoint, and only for your own account. The single write it performs is the atomic
token rotation described above, to a file you already own.

## Troubleshooting

**"signed out" / "no scope".** Run `claude`, sign in, then press **Re-check sign-in** in the panel.
A token from `claude setup-token` will not work; sign in with Claude Code itself.

**"throttled".** The endpoint returned 429. The widget backs off automatically. A missing or wrong
`User-Agent` also causes 429s; the widget detects the installed Claude Code version at startup.

**No data at all.** Press **Re-check sign-in**; the panel shows the exact error. The panel also shows
which credential file was used and which token host last worked.

**Renderer problems.** A frameless app has no DevTools in front of you, so set `CLUW_DEBUG=1` to get
renderer console output on stdout:

```bash
CLUW_DEBUG=1 npx electron .
```

**Nothing appears.** The widget is in the tray. Left-click the tray icon to toggle it, and check
**Show widget** in the panel.

## Notes for developers

- The renderer is loaded with a classic `<script src>` tag, not as an ES module: Chromium refuses
  module scripts over `file://` without `--allow-file-access-from-files`. A classic script cannot
  contain `import`/`export`, and `tsc` appends `export {}` to every external module, so `bar.ts` and
  `panel.ts` have no top-level import/export and wrap their bodies in an IIFE. Their types come from
  the ambient `src/renderer/api.d.ts`.
- `tsconfig.renderer.json` sets `isolatedModules: false` for the same reason. The main and preload
  builds keep it on.
- `src/shared/types.ts` is intentionally types-only, so it compiles cleanly into both the CommonJS
  main build and the ES2022 renderer build.
- IPC channel names are duplicated in `src/main/ipc.ts` and `src/preload/index.ts` on purpose: that is
  the trust boundary, and a change on one side should fail to compile rather than silently no-op.
- `tsconfig.json` is typecheck-only (`noEmit`); the two real builds are `tsconfig.main.json` and
  `tsconfig.renderer.json`.

## Scope

Windows-only for v1. No code signing, no auto-updater. Out of scope: usage history and sparklines,
per-model weekly sub-limits, extra-usage credit balance, packaged `.exe`, multi-account switching.

`/api/oauth/usage` is undocumented, so Anthropic could change or remove it. It is isolated entirely
in `oauth.ts` and `normalize.ts` so that a break is a contained fix, and the statusline source is the
documented fallback.

## License

Private project. Provided as-is, with no warranty.
