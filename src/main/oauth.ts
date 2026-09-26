import { execFile } from "node:child_process";

import type { PlanInfo } from "../shared/types";
import {
  type ClaudeAiOauth,
  type ClaudeCredentials,
  CredentialWriteError,
  mergeTokenResponse,
  writeCredentialsAtomically,
} from "./credentials";

/**
 * Every call to Anthropic lives here. This is the blast radius for the undocumented endpoints:
 * if `/api/oauth/usage` changes or disappears, only this file and `normalize.ts` need to change.
 *
 * Nothing in this module ever hands a token to the renderer. Callers get a `UsageSnapshot` or a
 * `PlanInfo` back.
 */

/** Public OAuth client id used by Claude Code itself. */
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/**
 * Token hosts in preference order. Which one is canonical is account/environment dependent, so
 * the working host is remembered in config and tried first next time.
 */
export const TOKEN_HOSTS = ["https://platform.claude.com", "https://console.anthropic.com"] as const;

const API_BASE = "https://api.anthropic.com";
export const USAGE_URL = `${API_BASE}/api/oauth/usage`;
export const PROFILE_URL = `${API_BASE}/api/oauth/profile`;

const REQUEST_TIMEOUT_MS = 15_000;
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const FALLBACK_CLAUDE_CODE_VERSION = "2.0.0";

export type OAuthErrorKind =
  | "network"
  | "unauthorized"
  | "forbidden"
  | "throttled"
  | "server"
  | "malformed"
  | "refresh-failed";

export class OAuthError extends Error {
  constructor(
    readonly kind: OAuthErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

let cachedUserAgent: string | null = null;

/**
 * `User-Agent: claude-code/<version>` is mandatory for the usage endpoint. Without it the very
 * same token gets a 429, which is easy to misdiagnose as a quota problem.
 */
export function userAgent(): string {
  if (cachedUserAgent !== null) return cachedUserAgent;
  cachedUserAgent = `claude-code/${FALLBACK_CLAUDE_CODE_VERSION}`;
  return cachedUserAgent;
}

/** Probe the installed Claude Code version. Never throws; falls back to a plausible version. */
export function detectClaudeCodeVersion(): Promise<string> {
  if (cachedUserAgent !== null) return Promise.resolve(cachedUserAgent);
  return new Promise((resolve) => {
    const candidates =
      process.platform === "win32" ? ["claude.cmd", "claude"] : ["claude"];
    let index = 0;

    const tryNext = (): void => {
      const bin = candidates[index];
      index += 1;
      if (bin === undefined) {
        resolve(`claude-code/${FALLBACK_CLAUDE_CODE_VERSION}`);
        return;
      }
      execFile(
        bin,
        ["--version"],
        { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true, shell: false },
        (error, stdout) => {
          if (!error) {
            const match = /\d+\.\d+\.\d+[^\s]*/.exec(String(stdout));
            if (match) {
              cachedUserAgent = `claude-code/${match[0]}`;
              resolve(cachedUserAgent);
              return;
            }
          }
          tryNext();
        },
      );
    };

    tryNext();
  });
}

/** Test seam: reset the memoized version. */
export function resetUserAgentCache(): void {
  cachedUserAgent = null;
}

function baseHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": OAUTH_BETA_HEADER,
    "User-Agent": userAgent(),
    Accept: "application/json",
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OAuthError(
      "malformed",
      `response was not JSON (${error instanceof Error ? error.message : String(error)})`,
      response.status,
    );
  }
}

function classifyStatus(status: number): OAuthErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "throttled";
  return "server";
}

function describe(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    const message = record["error_description"] ?? record["error"] ?? record["message"];
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return fallback;
}

/**
 * Exchange a refresh token for a new access token.
 *
 * Refresh tokens are single-use, so the rotated refresh token MUST be persisted by the caller via
 * `persistRotatedCredentials`. Host order is `preferredHost` first, then the remaining candidates.
 */
export async function refreshAccessToken(
  oauth: ClaudeAiOauth,
  preferredHost: string | null = null,
): Promise<{ host: string; response: { accessToken: string; refreshToken: string; expiresIn?: number; scopes?: string[] } }> {
  const refreshToken = oauth.refreshToken;
  if (typeof refreshToken !== "string" || refreshToken.trim() === "") {
    throw new OAuthError("refresh-failed", "no refresh token available");
  }

  const hosts = [preferredHost, ...TOKEN_HOSTS].filter(
    (host, index, all): host is string => typeof host === "string" && all.indexOf(host) === index,
  );

  let lastError: OAuthError | null = null;

  for (const host of hosts) {
    const url = `${host.replace(/\/+$/, "")}/v1/oauth/token`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": userAgent(),
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A transport failure on one host may still succeed on the other; keep trying.
      lastError = new OAuthError(
        "network",
        `token request to ${host} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const payload = await readJson(response).catch(() => null);

    if (!response.ok) {
      const kind = classifyStatus(response.status);
      lastError = new OAuthError(kind, describe(payload, `token request failed with ${response.status}`), response.status);
      // 4xx other than 429 will not improve on another host; only 429/network/server are retried.
      if (kind === "forbidden" || kind === "unauthorized") throw lastError;
      continue;
    }

    if (typeof payload !== "object" || payload === null) {
      lastError = new OAuthError("malformed", "token response was empty", response.status);
      continue;
    }

    const record = payload as Record<string, unknown>;
    const accessToken = record["access_token"];
    const rotatedRefresh = record["refresh_token"];
    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      lastError = new OAuthError("malformed", "token response had no access_token", response.status);
      continue;
    }
    if (typeof rotatedRefresh !== "string" || rotatedRefresh.trim() === "") {
      // Do not risk it: without a rotated refresh token the next refresh would fail, and writing a
      // blank here is exactly the failure mode that breaks a user's login.
      lastError = new OAuthError("malformed", "token response had no refresh_token; refusing to persist", response.status);
      continue;
    }

    const expiresIn = typeof record["expires_in"] === "number" ? (record["expires_in"] as number) : undefined;
    const scopes = Array.isArray(record["scope"])
      ? (record["scope"] as unknown[]).filter((s): s is string => typeof s === "string")
      : typeof record["scope"] === "string"
        ? (record["scope"] as string).split(" ").filter((s) => s !== "")
        : undefined;

    return {
      host,
      response: {
        accessToken,
        refreshToken: rotatedRefresh,
        ...(expiresIn !== undefined ? { expiresIn } : {}),
        ...(scopes !== undefined && scopes.length > 0 ? { scopes } : {}),
      },
    };
  }

  throw lastError ?? new OAuthError("refresh-failed", "token refresh failed on every known host");
}

/**
 * Persist a rotated token set.
 *
 * Throws `CredentialWriteError` and leaves the file untouched if the merge or the atomic write
 * fails; the caller must treat that as a hard failure rather than continuing with a token that
 * cannot be refreshed again.
 */
export function persistRotatedCredentials(
  path: string,
  existing: ClaudeCredentials,
  response: { accessToken: string; refreshToken: string; expiresIn?: number; scopes?: string[] },
): ClaudeCredentials {
  const merged = mergeTokenResponse(existing, response);
  writeCredentialsAtomically(path, merged);
  return merged;
}

export { CredentialWriteError };

/** `GET /api/oauth/usage`. Throws `OAuthError` with a classified `kind`. */
export async function fetchUsage(accessToken: string, url: string = USAGE_URL): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: baseHeaders(accessToken),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OAuthError("network", error instanceof Error ? error.message : String(error));
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const hint = retryAfter !== null && /^\d+$/.test(retryAfter) ? ` (retry after ${retryAfter}s)` : "";
    throw new OAuthError("throttled", `usage endpoint rate limited${hint}`, 429);
  }

  const payload = await readJson(response).catch((error: unknown) => {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("malformed", "usage response was not JSON", response.status);
  });

  if (!response.ok) {
    throw new OAuthError(classifyStatus(response.status), describe(payload, `usage request failed with ${response.status}`), response.status);
  }

  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `GET /api/oauth/profile` for the plan badge.
 *
 * Never throws: a missing or changed profile body just yields an empty `PlanInfo`, because the
 * widget is still useful without the badge and the cached credential tier is a fine fallback.
 */
export async function fetchProfile(accessToken: string, url: string = PROFILE_URL): Promise<PlanInfo> {
  const empty: PlanInfo = {
    tier: null,
    subscription: null,
    hasClaudeMax: null,
    email: null,
    organizationName: null,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: baseHeaders(accessToken),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return empty;
  }

  if (!response.ok) return empty;

  let payload: unknown;
  try {
    payload = await readJson(response);
  } catch {
    return empty;
  }
  if (!isRecord(payload)) return empty;

  const account = isRecord(payload["account"]) ? (payload["account"] as Record<string, unknown>) : {};
  const organization = isRecord(payload["organization"]) ? (payload["organization"] as Record<string, unknown>) : {};

  const tier = organization["rate_limit_tier"] ?? account["rate_limit_tier"];
  const subscription = account["subscription_type"] ?? organization["subscription_type"];
  const hasMax = account["has_claude_max"] ?? account["has_claude_pro"];

  return {
    tier: typeof tier === "string" && tier !== "" ? tier : null,
    subscription: typeof subscription === "string" && subscription !== "" ? subscription : null,
    hasClaudeMax: typeof hasMax === "boolean" ? hasMax : null,
    email: typeof account["email_address"] === "string" ? (account["email_address"] as string) : null,
    organizationName:
      typeof organization["name"] === "string"
        ? (organization["name"] as string)
        : typeof account["organization_name"] === "string"
          ? (account["organization_name"] as string)
          : null,
  };
}
