import { existsSync, readFileSync } from "node:fs";

import type { AuthState, PlanInfo, UsageSnapshot, UsageSource, UsageWindow, WindowKind } from "../shared/types";
import { type ClaudeCredentials, hasRequiredScope, needsRefresh, readCredentials } from "./credentials";
import { type NormalizedUsage, normalizeStatuslinePayload, normalizeUsageResponse, toEpochMs } from "./normalize";
import { credentialCandidates, snapshotPath } from "./paths";
import { OAuthError, fetchProfile, fetchUsage, persistRotatedCredentials, refreshAccessToken } from "./oauth";
import { MIN_REFRESH_MINUTES, type Store } from "./store";

/**
 * Owns the current `UsageSnapshot`, schedules refreshes, and merges the two data sources.
 *
 * The poller keeps each source's last result separately and derives the displayed snapshot from
 * the precedence ladder: fresh OAuth > cached OAuth > statusline > unknown. Nothing here throws
 * at the UI; failures degrade `stale` / `throttled` / `lastError` instead.
 */

/** Data older than this renders as stale. */
const STALE_AFTER_MS = 30 * 60_000;

/** 429 backoff ladder in minutes; the last entry repeats. */
const BACKOFF_MINUTES = [15, 30, 30, 60];

interface SourceReading {
  usage: NormalizedUsage;
  /** Epoch ms the reading was produced. */
  at: number;
}

export interface PollerEvents {
  onState: (snapshot: UsageSnapshot) => void;
  onAuth: (auth: AuthState) => void;
  onPlan: (planChanged: boolean) => void;
}

function emptySnapshot(): UsageSnapshot {
  return {
    session: null,
    weekly: null,
    rateLimited: false,
    source: "unknown",
    fetchedAt: null,
    updatedAt: null,
    throttled: false,
    stale: true,
    lastError: null,
  };
}

function toWindow(raw: NormalizedUsage["session"], kind: WindowKind): UsageWindow | null {
  if (!raw) return null;
  return {
    kind,
    percentUsed: raw.percentUsed,
    resetsAt: raw.resetsAt,
    severity: raw.severity,
    active: raw.active,
    scoped: raw.scoped,
    rawKind: raw.rawKind,
  };
}

/** Read the snapshot the statusline capture mode wrote. Tolerates a missing or corrupt file. */
export function readStatuslineSnapshot(userData: string): SourceReading | null {
  const path = snapshotPath(userData);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const at = toEpochMs(record["capturedAt"]);
    if (at === null) return null;
    return { usage: normalizeStatuslinePayload(record["payload"] ?? record), at };
  } catch {
    return null;
  }
}

export class Poller {
  private snapshot: UsageSnapshot = emptySnapshot();
  private auth: AuthState = {
    status: "signed-out",
    detail: null,
    credentialsPath: null,
    tokenHost: null,
    refreshed: false,
  };

  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  /** A 403 means the token will not start working again this session; stop burning requests. */
  private halted = false;

  private throttled = false;
  private backoffIndex = 0;
  private lastError: string | null = null;

  private oauthReading: SourceReading | null = null;
  private statuslineReading: SourceReading | null = null;

  constructor(
    private readonly store: Store,
    private readonly userData: string,
    private readonly events: PollerEvents,
  ) {}

  getSnapshot(): UsageSnapshot {
    return this.snapshot;
  }

  getAuth(): AuthState {
    return this.auth;
  }

  start(): void {
    this.stopped = false;
    this.halted = false;
    this.reloadStatusline();
    void this.refresh("scheduled");
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Force a poll immediately, bypassing the schedule but never running two at once.
   * Used by the tray "Refresh now" and the panel button.
   */
  async refreshNow(): Promise<UsageSnapshot> {
    await this.refresh("manual");
    this.schedule();
    return this.snapshot;
  }

  /**
   * Called when the capture mode writes a new file, or when a statusline-driven refresh is
   * requested. Never touches the network and never displaces good OAuth data.
   */
  ingestStatusline(): void {
    this.reloadStatusline();
    this.compose();
  }

  /** Clear cached OAuth data and the backoff ladder; used by "re-check sign-in". */
  reset(): void {
    this.backoffIndex = 0;
    this.throttled = false;
    this.halted = false;
    this.oauthReading = null;
    this.lastError = null;
    void this.refresh("manual");
  }

  private reloadStatusline(): void {
    this.statuslineReading = readStatuslineSnapshot(this.userData);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.halted) {
      this.timer = null;
      return;
    }
    const minutes = this.throttled
      ? (BACKOFF_MINUTES[Math.min(this.backoffIndex, BACKOFF_MINUTES.length - 1)] ?? 30)
      : Math.max(MIN_REFRESH_MINUTES, this.store.get().refreshIntervalMinutes);
    this.timer = setTimeout(() => {
      void this.refresh("scheduled");
    }, minutes * 60_000);
    this.timer.unref?.();
  }

  private refresh(_reason: "scheduled" | "manual"): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.poll().finally(() => {
      this.inFlight = null;
      this.schedule();
    });
    return this.inFlight;
  }

  private async poll(): Promise<void> {
    const read = readCredentials(credentialCandidates());

    if (!read.ok || read.data === null) {
      const detail =
        read.failure === "missing"
          ? "No .credentials.json found. Run `claude`, sign in, then press Re-check sign-in."
          : `Could not read ${read.path} (${read.failure ?? "unknown error"}). ${read.detail ?? ""}`.trim();
      this.oauthReading = null;
      this.setAuth({ status: read.failure === "malformed" ? "error" : "signed-out", detail, credentialsPath: read.path, tokenHost: null });
      this.fail(detail);
      return;
    }

    const oauth = read.data.claudeAiOauth;

    if (!hasRequiredScope(oauth)) {
      this.oauthReading = null;
      this.setAuth({
        status: "insufficient-scope",
        detail:
          'This token lacks the "user:profile" scope the usage endpoint requires. Sign in with Claude Code itself (not `claude setup-token`) and retry.',
        credentialsPath: read.path,
        tokenHost: null,
      });
      this.fail("Stored token is missing the user:profile scope");
      return;
    }

    let active: ClaudeCredentials = read.data;

    if (needsRefresh(oauth)) {
      const rotated = await this.rotate(read.path, read.data);
      if (rotated === null) return;
      active = rotated;
    }

    const accessToken = active.claudeAiOauth.accessToken;
    this.setAuth({ status: "ok", detail: null, credentialsPath: read.path, tokenHost: this.auth.tokenHost });

    try {
      const usage = normalizeUsageResponse(await fetchUsage(accessToken));
      const now = Date.now();
      this.oauthReading = { usage, at: now };
      this.throttled = false;
      this.backoffIndex = 0;
      this.lastError = null;
      this.compose();
      void this.refreshProfile(accessToken, read.data);
    } catch (error) {
      this.handleRequestFailure(error, read.path);
    }
  }

  /**
   * Rotate the access token and persist it. Refresh tokens are single-use, so a failure here is
   * reported and the previous snapshot is served rather than retried in a loop.
   */
  private async rotate(path: string, existing: ClaudeCredentials): Promise<ClaudeCredentials | null> {
    try {
      const { host, response } = await refreshAccessToken(existing.claudeAiOauth, this.store.get().tokenHost);
      const merged = persistRotatedCredentials(path, existing, response);
      this.store.update({ tokenHost: host });
      this.setAuth({ status: "ok", detail: null, credentialsPath: path, tokenHost: host, refreshed: true });
      return merged;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof OAuthError ? error.kind : "refresh-failed";
      if (kind === "unauthorized") {
        this.oauthReading = null;
        this.setAuth({ status: "signed-out", detail: `Token refresh rejected. ${message}`, credentialsPath: path, tokenHost: this.auth.tokenHost });
      } else if (kind === "forbidden") {
        this.oauthReading = null;
        this.halted = true;
        this.setAuth({
          status: "insufficient-scope",
          detail: `Token refresh was refused: this login cannot read usage. Sign in with Claude Code itself.`,
          credentialsPath: path,
          tokenHost: this.auth.tokenHost,
        });
      } else {
        this.setAuth({ status: "error", detail: `Token refresh failed: ${message}`, credentialsPath: path, tokenHost: this.auth.tokenHost });
      }
      this.fail(message);
      return null;
    }
  }

  private handleRequestFailure(error: unknown, credentialsPath: string): void {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof OAuthError ? error.kind : "network";

    if (kind === "throttled") {
      this.throttled = true;
      this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_MINUTES.length - 1);
    } else if (kind === "forbidden") {
      // Stop polling entirely until relaunch; retrying cannot change the answer.
      this.halted = true;
      this.oauthReading = null;
      this.setAuth({
        status: "insufficient-scope",
        detail: "This login is not allowed to read usage. Sign in with Claude Code itself, then restart the widget.",
        credentialsPath,
        tokenHost: this.auth.tokenHost,
      });
    } else if (kind === "unauthorized") {
      this.oauthReading = null;
      this.setAuth({
        status: "signed-out",
        detail: "The stored login is no longer valid. Sign in again with Claude Code, then press Re-check sign-in.",
        credentialsPath,
        tokenHost: this.auth.tokenHost,
      });
    }

    this.fail(message);
  }

  /** Record an error and recompose, so the UI can show the last good data plus the reason. */
  private fail(message: string): void {
    this.lastError = message;
    this.compose();
  }

  /**
   * Walk the precedence ladder and publish. This is the only place a `UsageSnapshot` is built.
   */
  private compose(): void {
    const now = Date.now();
    let source: UsageSource = "unknown";
    let reading: SourceReading | null = null;

    if (this.oauthReading !== null) {
      source = this.lastError === null ? "oauth" : "oauth-cached";
      reading = this.oauthReading;
    } else if (this.statuslineReading !== null) {
      source = "statusline";
      reading = this.statuslineReading;
    }

    const next: UsageSnapshot = {
      session: reading ? toWindow(reading.usage.session, "session") : null,
      weekly: reading ? toWindow(reading.usage.weekly, "weekly") : null,
      rateLimited: reading?.usage.rateLimited ?? false,
      source,
      fetchedAt: this.oauthReading?.at ?? null,
      updatedAt: reading?.at ?? null,
      throttled: this.throttled,
      stale: reading === null ? true : now - reading.at > STALE_AFTER_MS,
      lastError: this.lastError,
    };

    const changed =
      next.source !== this.snapshot.source ||
      next.stale !== this.snapshot.stale ||
      next.throttled !== this.snapshot.throttled ||
      next.lastError !== this.snapshot.lastError ||
      windowSignature(next) !== windowSignature(this.snapshot);
    if (!changed) return;

    this.snapshot = next;
    this.events.onState(next);
  }

  /**
   * Fetch the plan details, filling gaps from the credential file.
   *
   * `/api/oauth/profile` does not report a subscription type on every account, but the credential
   * file always has one, so it is the better source for the badge. The credential `rateLimitTier`
   * is a last-resort fallback only: it goes stale after a plan upgrade, whereas the profile
   * endpoint is authoritative whenever it answers at all.
   */
  private async refreshProfile(accessToken: string, credentials: ClaudeCredentials): Promise<void> {
    const oauth = credentials.claudeAiOauth;
    const fetched = await fetchProfile(accessToken);

    const plan: PlanInfo = {
      ...fetched,
      subscription: fetched.subscription ?? (typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null),
      tier: fetched.tier ?? (typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : null),
    };

    if (JSON.stringify(this.store.get().lastProfile) === JSON.stringify(plan)) return;
    this.store.update({ lastProfile: plan });
    this.events.onPlan(true);
  }

  private setAuth(patch: Partial<AuthState>): void {
    const next: AuthState = { ...this.auth, ...patch };
    if (
      next.status === this.auth.status &&
      next.detail === this.auth.detail &&
      next.credentialsPath === this.auth.credentialsPath &&
      next.tokenHost === this.auth.tokenHost &&
      next.refreshed === this.auth.refreshed
    ) {
      return;
    }
    this.auth = next;
    this.events.onAuth(next);
  }
}

function windowSignature(snapshot: UsageSnapshot): string {
  const describe = (win: UsageWindow | null): string =>
    win === null ? "-" : `${win.percentUsed}|${win.resetsAt}|${win.severity}|${win.active}|${win.scoped}|${win.rawKind}`;
  return `${describe(snapshot.session)}#${describe(snapshot.weekly)}#${snapshot.rateLimited}`;
}
