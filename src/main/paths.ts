import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every filesystem location the app touches, resolved in one place.
 *
 * Claude Code honours three different config roots. `CLAUDE_SECURESTORAGE_CONFIG_DIR` is the
 * newest, `CLAUDE_CONFIG_DIR` the documented one, and `~/.claude` the default that is used when
 * neither is set. Credentials are probed across all three; settings.json is written to whichever
 * root Claude Code would actually read.
 */
export function claudeConfigDir(): string {
  for (const key of ["CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return join(homedir(), ".claude");
}

export function claudeSettingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

/** Credential candidates in probe order; the first readable file wins. */
export function credentialCandidates(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of ["CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const) {
    const dir = process.env[key];
    if (typeof dir !== "string" || dir.trim() === "") continue;
    const path = join(dir.trim(), ".credentials.json");
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  const fallback = join(homedir(), ".claude", ".credentials.json");
  if (!seen.has(fallback)) out.push(fallback);
  return out;
}

export function userDataDir(): string {
  return app.getPath("userData");
}

export function snapshotPath(userData: string): string {
  return join(userData, "usage-snapshot.json");
}

export function configPath(userData: string): string {
  return join(userData, "config.json");
}

/**
 * Arguments needed to relaunch this app from `process.execPath`.
 *
 * A packaged build's exe *is* the app. Unpackaged (`electron .`) the exe is the generic Electron
 * binary, which would open Electron's default window unless it is also given the app directory.
 */
export function selfLaunchArgs(): string[] {
  return app.isPackaged ? [] : [app.getAppPath()];
}

/** Register or remove the Windows login item, pointing at this app in both run modes. */
export function applyLoginItem(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: selfLaunchArgs() });
}

/** Path to a file shipped inside `dist/`, e.g. `dist/renderer/bar.html`. */
export function assetPath(...parts: string[]): string {
  return join(__dirname, ...parts);
}
