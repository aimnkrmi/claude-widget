import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Reading and (carefully) rewriting Claude Code's OAuth credentials.
 *
 * The write path here is the single highest-severity risk in this app: a botched write has
 * permanently logged real users out of Claude Code. The contract is enforced in one function,
 * `writeCredentialsAtomically`, and it never leaves the file in a partial state.
 *
 * Windows Credential Manager is deliberately NOT read. The service naming is unverified and a
 * wrong guess risks a destructive write; the `user:profile` OAuth file is the supported path.
 */

/** The only scope the usage endpoint needs. A `claude setup-token` token will 403 without it. */
export const REQUIRED_SCOPE = "user:profile";

export interface ClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  /** Unknown keys are preserved verbatim across a write-back. */
  [key: string]: unknown;
}

export interface ClaudeCredentials {
  claudeAiOauth: ClaudeAiOauth;
  [key: string]: unknown;
}

export type CredentialReadFailure =
  | "missing"
  | "unreadable"
  | "malformed"
  | "no-oauth"
  | "no-access-token"
  | "no-refresh-token";

export interface CredentialReadResult {
  ok: boolean;
  path: string;
  failure: CredentialReadFailure | null;
  detail: string | null;
  data: ClaudeCredentials | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Read one candidate path. Never throws; a failure is reported as a typed result. */
export function readCredentialsFile(path: string): CredentialReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, path, failure: "missing", detail: null, data: null };
    }
    return {
      ok: false,
      path,
      failure: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
      data: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      path,
      failure: "malformed",
      detail: error instanceof Error ? error.message : String(error),
      data: null,
    };
  }

  if (!isRecord(parsed)) {
    return { ok: false, path, failure: "malformed", detail: "top level is not an object", data: null };
  }
  if (!isRecord(parsed["claudeAiOauth"])) {
    return { ok: false, path, failure: "no-oauth", detail: "no claudeAiOauth object", data: null };
  }
  if (!isNonEmptyString(parsed["claudeAiOauth"]["accessToken"])) {
    return { ok: false, path, failure: "no-access-token", detail: "accessToken is missing or empty", data: null };
  }
  if (!isNonEmptyString(parsed["claudeAiOauth"]["refreshToken"])) {
    return { ok: false, path, failure: "no-refresh-token", detail: "refreshToken is missing or empty", data: null };
  }

  return { ok: true, path, failure: null, detail: null, data: parsed as unknown as ClaudeCredentials };
}

/** Probe the candidate list in order and return the first usable file. */
export function readCredentials(candidates: readonly string[]): CredentialReadResult {
  let last: CredentialReadResult | null = null;
  for (const path of candidates) {
    const result = readCredentialsFile(path);
    if (result.ok) return result;
    if (result.failure !== "missing" && result.failure !== "unreadable") last = result;
  }
  if (last !== null) return last;
  return {
    ok: false,
    path: candidates[0] ?? "",
    failure: "missing",
    detail: candidates.length === 0 ? "no credential locations configured" : null,
    data: null,
  };
}

/** True when the token carries the scope the usage endpoint requires. */
export function hasRequiredScope(oauth: ClaudeAiOauth | null | undefined): boolean {
  const scopes = oauth?.scopes;
  if (!Array.isArray(scopes)) return false;
  return scopes.some((scope) => typeof scope === "string" && scope.trim() === REQUIRED_SCOPE);
}

export class CredentialWriteError extends Error {
  constructor(
    message: string,
    readonly code:
      | "validation"
      | "serialize"
      | "write"
      | "chmod"
      | "rename",
  ) {
    super(message);
    this.name = "CredentialWriteError";
  }
}

export interface WriteOutcome {
  path: string;
  bytes: number;
}

/**
 * Atomically rewrite `.credentials.json` with rotated tokens.
 *
 * The contract, in order:
 *   1. Validate the merged result: non-empty `accessToken` AND non-empty `refreshToken`.
 *   2. Serialize; any failure here leaves the target untouched.
 *   3. Write a `.tmp` sibling in the SAME directory (rename is only atomic within a volume).
 *   4. `renameSync` over the target.
 *   5. Any error before step 4 unlinks the tmp file and leaves the original in place.
 *
 * Callers must have already merged into the object that was read; this function never invents
 * fields. It refuses to write an empty token or `expiresAt: 0` under any circumstance, because
 * that exact failure mode has zeroed out real users' Claude Code logins.
 */
export function writeCredentialsAtomically(path: string, data: ClaudeCredentials): WriteOutcome {
  const oauth = data?.claudeAiOauth;

  if (!isRecord(oauth)) {
    throw new CredentialWriteError("refusing to write: no claudeAiOauth object", "validation");
  }
  if (!isNonEmptyString(oauth["accessToken"])) {
    throw new CredentialWriteError("refusing to write: accessToken is empty", "validation");
  }
  if (!isNonEmptyString(oauth["refreshToken"])) {
    throw new CredentialWriteError("refusing to write: refreshToken is empty", "validation");
  }
  if (typeof oauth["expiresAt"] !== "number" || !Number.isFinite(oauth["expiresAt"]) || oauth["expiresAt"] <= 0) {
    throw new CredentialWriteError("refusing to write: expiresAt is not a positive timestamp", "validation");
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(data, null, 2);
  } catch (error) {
    throw new CredentialWriteError(
      `refusing to write: serialization failed (${error instanceof Error ? error.message : String(error)})`,
      "serialize",
    );
  }
  if (serialized.length === 0) {
    throw new CredentialWriteError("refusing to write: serialized output is empty", "serialize");
  }

  const tmp = join(dirname(path), ".credentials.json.tmp");

  try {
    writeFileSync(tmp, serialized, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    safeUnlink(tmp);
    throw new CredentialWriteError(
      `credential write failed: ${error instanceof Error ? error.message : String(error)}`,
      "write",
    );
  }

  // Best effort; Windows ACLs already restrict the file, and a chmod failure must not abort a
  // write that has already been prepared correctly.
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }

  try {
    renameSync(tmp, path);
  } catch (error) {
    safeUnlink(tmp);
    throw new CredentialWriteError(
      `credential rename failed: ${error instanceof Error ? error.message : String(error)}`,
      "rename",
    );
  }

  return { path, bytes: serialized.length };
}

function safeUnlink(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A leftover tmp file is harmless: it is never read by Claude Code or by this app.
  }
}

/**
 * Merge a fresh token response into the credential object that was read, preserving every
 * unknown key (Claude Code adds its own over time) and every unrelated top-level key such as
 * `mcpOAuth`.
 */
export function mergeTokenResponse(
  existing: ClaudeCredentials,
  response: { accessToken: string; refreshToken: string; expiresIn?: number; expiresAt?: number; scopes?: string[] },
): ClaudeCredentials {
  const base = existing.claudeAiOauth ?? ({} as ClaudeAiOauth);
  const expiresAt =
    typeof response.expiresAt === "number" && response.expiresAt > 0
      ? response.expiresAt
      : typeof response.expiresIn === "number" && response.expiresIn > 0
        ? Date.now() + response.expiresIn * 1000
        : base.expiresAt;

  return {
    ...existing,
    claudeAiOauth: {
      ...base,
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresAt,
      ...(Array.isArray(response.scopes) && response.scopes.length > 0 ? { scopes: response.scopes } : {}),
    },
  };
}

/** True when the access token is expired or close enough to expiry to be worth refreshing. */
export function needsRefresh(oauth: ClaudeAiOauth | null | undefined, skewMs = 5 * 60_000, now = Date.now()): boolean {
  if (!oauth) return false;
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  return expiresAt - now < skewMs;
}
