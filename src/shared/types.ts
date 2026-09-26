/**
 * Types shared across main / preload / renderer.
 *
 * This module intentionally contains *types only* (no runtime values) so that it can be
 * compiled into both the CommonJS main build and the ESM renderer build without the two
 * emitting conflicting JavaScript for the same path. Anything that is a runtime value and
 * needed by more than one process lives next to the boundary that owns it
 * (`src/main/ipc.ts` for the channel list, `src/preload/index.ts` for the renderer API).
 */

export type WindowKind = "session" | "weekly";

export type UsageSource = "oauth" | "oauth-cached" | "statusline" | "unknown";

export type Severity = "normal" | "warning" | "rate_limited" | "rejected";

export interface UsageWindow {
  kind: WindowKind;
  /** 0-100, percent of the window consumed. `null` when the account did not report it. */
  percentUsed: number | null;
  /** Epoch milliseconds of the next reset, or `null` when unknown. */
  resetsAt: number | null;
  severity: Severity | null;
  /** Mirrors `is_active` from the API; an inactive window is rendered muted. */
  active: boolean;
  /** True when this came from a `weekly_scoped` style limit rather than the overall weekly limit. */
  scoped: boolean;
  /** Raw window label reported by the source, e.g. `seven_day`, `session`, `weekly_all`. */
  rawKind: string | null;
}

export interface UsageSnapshot {
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  /** A per-model weekly sub-limit (`weekly_scoped`), when the account reports one. Panel only. */
  weeklyScoped: UsageWindow | null;
  /** The account is currently throttled (`status: rate_limited` / `severity: rate_limited`). */
  rateLimited: boolean;
  source: UsageSource;
  /** Epoch ms of the last successful *network* fetch. */
  fetchedAt: number | null;
  /** Epoch ms the currently displayed data was produced, whichever source it came from. */
  updatedAt: number | null;
  /** The endpoint answered 429; `snapshot` is the last good data. */
  throttled: boolean;
  /** Data is older than the freshness threshold. */
  stale: boolean;
  lastError: string | null;
}

export type AuthStatus =
  | "ok"
  | "signed-out"
  | "insufficient-scope"
  | "error";

export interface AuthState {
  status: AuthStatus;
  /** Human readable, safe to show in the panel. Never contains a token. */
  detail: string | null;
  /** Which credential file was used, for debugging. */
  credentialsPath: string | null;
  /** Which OAuth token host last worked. */
  tokenHost: string | null;
  /** True when the token had to be refreshed at least once this session. */
  refreshed: boolean;
}

export interface PlanInfo {
  tier: string | null;
  subscription: string | null;
  hasClaudeMax: boolean | null;
  email: string | null;
  organizationName: string | null;
}

export interface PublicSettings {
  refreshIntervalMinutes: number;
  autoLaunch: boolean;
  clickThrough: boolean;
  widgetVisible: boolean;
  statuslineRegistered: boolean;
  /** The `statusLine` command currently configured in `~/.claude/settings.json`, if any. */
  statuslineExistingCommand: string | null;
  /** The widget knows a prior `statusLine` value and can restore it exactly. */
  statuslineRestorable: boolean;
  /** Desktop notifications at 85% / 95% and when a nearly-spent session window resets. */
  notifications: boolean;
  /** Check GitHub Releases once a day for a newer version. */
  checkForUpdates: boolean;
}

/** A newer release than the running version, as found on GitHub. */
export interface UpdateInfo {
  version: string;
  /** Always an `https://github.com/` release page. */
  url: string;
}

export interface WidgetState {
  snapshot: UsageSnapshot;
  /** Set when a newer release exists and update checks are on. */
  update: UpdateInfo | null;
  plan: PlanInfo;
  /** Short display label for the plan badge, resolved in main so both renderers agree. */
  planLabel: string;
  auth: AuthState;
  settings: PublicSettings;
  appVersion: string;
}

export interface StatuslineWriteResult {
  ok: boolean;
  /** True when there was no stdin payload at all (known Windows behaviour). */
  emptyStdin: boolean;
  wroteSnapshot: boolean;
}

export interface StatuslineStatus {
  registered: boolean;
  command: string | null;
  restorable: boolean;
  priorCommand: string | null;
  settingsPath: string;
  /** A snapshot the capture mode already wrote, if any. */
  lastSnapshotAt: number | null;
}
