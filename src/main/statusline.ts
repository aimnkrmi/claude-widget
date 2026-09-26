import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { StatuslineStatus } from "../shared/types";
import { claudeSettingsPath } from "./paths";
import type { Store } from "./store";

/**
 * Two responsibilities:
 *
 *  1. **Capture mode** - a `statusline` argv flag puts the process in a fire-and-forget mode where
 *     it reads the statusline JSON on stdin, writes a snapshot, and exits 0 immediately. Claude
 *     Code runs this synchronously inside its UI, so it must never block, never prompt, and never
 *     exit non-zero.
 *  2. **Registration** - read-modify-write of `~/.claude/settings.json` with explicit consent and an
 *     exact restore of whatever was there before.
 */

export const STATUSLINE_FLAG = "statusline";

/** Recognised shapes of the `statusLine` key. Only `command` is written by us. */
export type StatusLineEntry =
  | { type: "command"; command: string; padding?: number }
  | { type: "unknown"; raw: unknown };

export function isStatuslineInvocation(argv: readonly string[]): boolean {
  return argv.slice(1).some((arg) => arg === STATUSLINE_FLAG || arg === `--${STATUSLINE_FLAG}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the statusline payload from file descriptor 0.
 *
 * Electron on Windows is a GUI-subsystem binary: `process.stdin` is constructed but never receives
 * data, even when the parent process pipes a payload in. Verified against a real pipe - the stream
 * API reports `end` with zero bytes while `readFileSync(0)` returns the full payload. Reading the
 * descriptor directly is the only approach that works.
 *
 * Reading synchronously is also the safer shape here. A stream that never receives data would need
 * a timeout, and a timeout window is exactly what must not exist inside Claude Code's render loop.
 * The guards below make a blocking read impossible:
 *   - a TTY means nothing was piped, so return immediately;
 *   - a character device (console handle) is skipped too, because reading one would block.
 */
function readStdinPayload(): string {
  try {
    if (process.stdin.isTTY === true) return "";
    const stat = fstatSync(0);
    if (stat.isCharacterDevice()) return "";
    return readFileSync(0, "utf8");
  } catch {
    // No descriptor, or an unreadable one. "No payload" is a supported state.
    return "";
  }
}

/** Write the snapshot atomically; the widget may read it at any moment. */
export function writeStatuslineSnapshot(userData: string, payload: unknown): boolean {
  const target = join(userData, "usage-snapshot.json");
  const tmp = `${target}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      tmp,
      JSON.stringify({ capturedAt: Date.now(), source: "claude-code-statusline", payload }, null, 2),
      { encoding: "utf8" },
    );
    renameSync(tmp, target);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

export interface CaptureResult {
  emptyStdin: boolean;
  wroteSnapshot: boolean;
  payload: unknown | null;
}

/**
 * Turn raw stdin text into a snapshot.
 *
 * Split out from the descriptor read so the parsing and persistence rules are unit-testable
 * without spawning Electron. Every failure mode - empty text, invalid JSON, unwritable directory -
 * returns normally; the caller then exits 0 unconditionally.
 */
export function parseAndStoreStatusline(userData: string, text: string): CaptureResult {
  // A BOM would make JSON.parse throw on an otherwise valid payload.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (cleaned.trim() === "") {
    return { emptyStdin: true, wroteSnapshot: false, payload: null };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(cleaned);
  } catch {
    return { emptyStdin: false, wroteSnapshot: false, payload: null };
  }

  const wroteSnapshot = writeStatuslineSnapshot(userData, payload);
  return { emptyStdin: false, wroteSnapshot, payload };
}

/** Read the statusline payload from the descriptor and persist it. Never throws. */
export function captureStatusline(userData: string): CaptureResult {
  try {
    return parseAndStoreStatusline(userData, readStdinPayload());
  } catch {
    return { emptyStdin: true, wroteSnapshot: false, payload: null };
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Registration                                                                                  */
/* -------------------------------------------------------------------------------------------- */

function readSettings(path: string): { ok: boolean; data: Record<string, unknown> } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { ok: false, data: {} };
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, data: {} };
  }
}

export function readExistingStatusline(path: string): { present: boolean; command: string | null; raw: unknown } {
  const { ok, data } = readSettings(path);
  if (!ok) return { present: false, command: null, raw: undefined };
  if (!("statusLine" in data)) return { present: false, command: null, raw: undefined };
  const raw = data["statusLine"];
  if (isRecord(raw) && typeof raw["command"] === "string") {
    return { present: true, command: raw["command"], raw };
  }
  return { present: true, command: null, raw };
}

export type RegisterOutcome =
  | { ok: true; previous: unknown }
  | { ok: false; reason: "unreadable" | "write-failed"; message: string };

/**
 * Insert our `statusLine` while preserving every unrelated key.
 *
 * Callers must obtain consent first. `store` is handed the exact prior value (including
 * `undefined`, meaning "the key was not present") so unregister can restore the file exactly.
 */
export function registerStatusline(path: string, command: string, store: Store): RegisterOutcome {
  const existing = readSettings(path);
  if (!existing.ok && existsSync(path)) {
    return { ok: false, reason: "unreadable", message: `${path} is not valid JSON; refusing to overwrite it.` };
  }

  const priorRaw = readExistingStatusline(path).raw;
  const next: Record<string, unknown> = { ...existing.data, statusLine: { type: "command", command } };

  const tmp = `${path}.cuw.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Keep a timestamped backup so a bad hand-edit is recoverable.
    try {
      copyFileSync(path, `${path}.cuw.bak`);
    } catch {
      /* first run: no file to back up */
    }
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return { ok: false, reason: "write-failed", message: error instanceof Error ? error.message : String(error) };
  }

  store.setStatusline({ registered: true, priorValue: priorRaw === undefined ? null : priorRaw, installedCommand: command });
  return { ok: true, previous: priorRaw };
}

export type UnregisterOutcome = { ok: true; restored: boolean } | { ok: false; reason: "not-restorable" | "write-failed"; message: string };

/**
 * Restore the file to exactly what it was before registration.
 *
 * If we recorded that `statusLine` was absent, the key is deleted. If we recorded a previous
 * value, it is written back verbatim. If we never recorded anything, this is refused rather than
 * guessing.
 */
export function unregisterStatusline(path: string, store: Store): UnregisterOutcome {
  const config = store.get();
  const prior = config.statusline.priorValue;
  if (prior === undefined) {
    return { ok: false, reason: "not-restorable", message: "No previous statusLine value was recorded; leaving settings.json alone." };
  }

  const existing = readSettings(path);
  if (!existing.ok && existsSync(path)) {
    return { ok: false, reason: "write-failed", message: `${path} is not valid JSON; restore aborted.` };
  }

  const next: Record<string, unknown> = { ...existing.data };
  if (prior === null) {
    delete next["statusLine"];
  } else {
    next["statusLine"] = prior;
  }

  const tmp = `${path}.cuw.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return { ok: false, reason: "write-failed", message: error instanceof Error ? error.message : String(error) };
  }

  store.setStatusline({ registered: false, priorValue: undefined, installedCommand: null });
  return { ok: true, restored: true };
}

export function statuslineStatus(store: Store, userData: string): StatuslineStatus {
  const path = claudeSettingsPath();
  const existing = readExistingStatusline(path);
  const config = store.get();
  let lastSnapshotAt: number | null = null;
  try {
    const raw: unknown = JSON.parse(readFileSync(join(userData, "usage-snapshot.json"), "utf8"));
    if (isRecord(raw)) lastSnapshotAt = typeof raw["capturedAt"] === "number" ? (raw["capturedAt"] as number) : null;
  } catch {
    lastSnapshotAt = null;
  }

  const prior = config.statusline.priorValue;
  return {
    registered: config.statusline.registered,
    command: existing.command,
    restorable: prior !== undefined,
    priorCommand:
      prior !== undefined && prior !== null && isRecord(prior) && typeof prior["command"] === "string" ? (prior["command"] as string) : null,
    settingsPath: path,
    lastSnapshotAt,
  };
}

/**
 * Build the command string Claude Code will run.
 *
 * Claude Code executes statusline commands through Git Bash when it is available and PowerShell
 * otherwise, so the path is emitted with forward slashes and wrapped in double quotes; the
 * project path routinely contains spaces.
 */
export function buildStatuslineCommand(execPath: string): string {
  const normalized = execPath.replace(/\\/g, "/");
  const quoted = normalized.includes(" ") ? `"${normalized}"` : normalized;
  return `${quoted} ${STATUSLINE_FLAG}`;
}

/**
 * Best-effort discovery of the `claude` executable, used only to offer `claude auth status` as a
 * fallback diagnostic. Never throws.
 */
export function claudeAuthStatus(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const bin = process.platform === "win32" ? "claude.cmd" : "claude";
    execFile(bin, ["auth", "status"], { timeout: 6_000, windowsHide: true, shell: false }, (error, stdout, stderr) => {
      const output = `${String(stdout)}${String(stderr)}`.trim();
      // `claude auth status` exits non-zero when not signed in, but its JSON output is still the
      // useful signal, so success is judged on whether anything printable came back.
      resolve({ ok: !error || output !== "", output });
    });
  });
}
