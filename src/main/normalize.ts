/**
 * The ONLY module that knows how upstream payload field names map onto `UsageSnapshot`.
 *
 * Two upstream generations are handled:
 *
 *  1. Flat OAuth body  - `five_hour` / `seven_day` objects with `utilization` (0-100) and
 *     `resets_at` as an ISO-8601 string.
 *  2. Structured body  - a `limits[]` array of `{ kind, percent, resets_at, severity, is_active, scope }`.
 *
 * The Claude Code statusline payload is a third dialect: `used_percentage` is a 0-100 float and
 * `resets_at` is Unix *epoch seconds* rather than ISO-8601. Both dialects funnel through the same
 * value coercions so the rest of the app only ever sees normalized numbers.
 *
 * Every function here is pure and total: hostile input yields `null` fields, never a throw.
 */

import type { Severity, UsageWindow, WindowKind } from "../shared/types";

/** Raw pre-normalization window data. */
export interface RawWindow {
  kind: WindowKind;
  percentUsed: number | null;
  resetsAt: number | null;
  severity: Severity | null;
  active: boolean;
  scoped: boolean;
  rawKind: string | null;
}

export interface NormalizedUsage {
  session: RawWindow | null;
  weekly: RawWindow | null;
  /** First `weekly_scoped` (per-model) limit, if any. */
  weeklyScoped: RawWindow | null;
  rateLimited: boolean;
}

export const EMPTY_USAGE: NormalizedUsage = Object.freeze({
  session: null,
  weekly: null,
  weeklyScoped: null,
  rateLimited: false,
});

/** Structured `limits[].kind` -> internal window kind. */
const STRUCTURED_KIND_MAP: Record<string, WindowKind> = {
  session: "session",
  five_hour: "session",
  weekly_all: "weekly",
  seven_day: "weekly",
  weekly: "weekly",
};

/** Statusline key -> internal window kind. */
const STATUSLINE_KEY_MAP: Record<string, WindowKind> = {
  five_hour: "session",
  session: "session",
  seven_day: "weekly",
  seven_hour: "weekly",
  seven_day_all: "weekly",
  weekly: "weekly",
};

/** Upstream `scope` values that mark a weekly limit as model-scoped rather than overall. */
const SCOPED_MARKERS = new Set([
  "weekly_scoped",
  "scoped",
  "model",
  "per_model",
  "per-model",
]);

/** Anything at or above this percent is rendered red. */
export const RED_THRESHOLD = 85;
export const AMBER_THRESHOLD = 60;

export type TrafficLevel = "ok" | "warn" | "alert" | "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a number-ish value, returning `null` for anything unusable. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Clamp a percent into 0-100. `null` in, `null` out. */
export function clampPercent(value: unknown): number | null {
  const num = toFiniteNumber(value);
  if (num === null) return null;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return num;
}

/**
 * Normalize a reset timestamp to epoch milliseconds.
 *
 * Accepts ISO-8601 strings, Unix epoch seconds, and Unix epoch milliseconds. Bare numbers are
 * disambiguated by magnitude: anything below 1e11 is far too small to be a millisecond epoch for
 * a date after 1973, so it is read as seconds. Strings that look numeric are treated the same way.
 */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // Pure-numeric strings are epoch numbers, not dates.
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return secondsOrMillisToMs(Number(trimmed));
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return secondsOrMillisToMs(value);
}

function secondsOrMillisToMs(value: unknown): number | null {
  const num = toFiniteNumber(value);
  if (num === null || num <= 0) return null;
  return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
}

/** Map any upstream severity/status string onto our narrow set. */
export function toSeverity(value: unknown): Severity | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "") return null;
  if (key === "rate_limited" || key === "rate_limited_now" || key === "limited") {
    return "rate_limited";
  }
  if (key === "rejected" || key === "rejected_now" || key === "rejected_requests") {
    return "rejected";
  }
  if (key === "warning" || key === "warn" || key === "approaching" || key === "approaching_limit") {
    return "warning";
  }
  if (key === "normal" || key === "ok" || key === "healthy") return "normal";
  return null;
}

/**
 * Decide whether the payload as a whole reports an active rate limit.
 *
 * Sources, in order of trust: an explicit top-level `status`/`rate_limit_status`, any per-window
 * `severity`, and finally the raw per-window `status`.
 */
export function detectRateLimited(source: Record<string, unknown>, windows: Array<RawWindow | null>): boolean {
  const topLevel = toSeverity(source["status"] ?? source["rate_limit_status"] ?? source["overall_status"]);
  if (topLevel === "rate_limited") return true;

  for (const win of windows) {
    if (!win) continue;
    if (win.severity === "rate_limited") return true;
  }
  return false;
}

function buildWindow(
  kind: WindowKind,
  body: unknown,
  kindLabel: string,
  scoped: boolean,
  percentKeys: readonly string[],
  severityKeys: readonly string[],
): RawWindow | null {
  if (!isRecord(body)) return null;

  const percent =
    firstNumber(body, percentKeys) ??
    // `utilization` is the flat-generation key; accept it everywhere as a fallback.
    firstNumber(body, ["utilization", "percentage"]);

  const resetsAt = firstTimestamp(body, ["resets_at", "resetsAt", "reset_at", "resetAt"]);

  const severity =
    toSeverity(firstValue(body, severityKeys)) ??
    toSeverity(body["status"]) ??
    toSeverity(body["severity"]);

  const activeRaw = body["is_active"] ?? body["isActive"] ?? body["active"];

  return {
    kind,
    percentUsed: clampPercent(percent),
    resetsAt,
    severity,
    active: typeof activeRaw === "boolean" ? activeRaw : true,
    scoped,
    rawKind: kindLabel,
  };
}

function firstValue(body: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstNumber(body: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = toFiniteNumber(body[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstTimestamp(body: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = toEpochMs(body[key]);
    if (value !== null) return value;
  }
  return null;
}

function isWindowPopulated(win: RawWindow | null): win is RawWindow {
  if (!win) return false;
  return win.percentUsed !== null || win.resetsAt !== null || win.severity !== null;
}

/**
 * Normalize `GET /api/oauth/usage`.
 *
 * Preference order per window: a structured `limits[]` entry, then the flat key. `weekly_scoped`
 * entries are never surfaced as the overall weekly window; they are reported separately.
 */
export function normalizeUsageResponse(raw: unknown): NormalizedUsage {
  if (!isRecord(raw)) return { ...EMPTY_USAGE };

  // A 429 body sometimes still carries useful data; a non-200 with an error does not.
  const structured = readStructuredLimits(raw["limits"]);

  const flat: Record<WindowKind, RawWindow | null> = {
    session: buildWindow(
      "session",
      raw["five_hour"] ?? raw["session"],
      "five_hour",
      false,
      ["utilization", "percent_used", "percentUsed", "percent"],
      ["severity", "status"],
    ),
    weekly: buildWindow(
      "weekly",
      raw["seven_day"] ?? raw["seven_hour"] ?? raw["weekly"],
      "seven_day",
      false,
      ["utilization", "percent_used", "percentUsed", "percent"],
      ["severity", "status"],
    ),
  };

  const scoped: RawWindow | null = structured.scoped;
  const out: NormalizedUsage = {
    session: pick(structured.session, flat.session),
    weekly: pick(structured.weekly, flat.weekly),
    weeklyScoped: isWindowPopulated(scoped) ? scoped : null,
    rateLimited: detectRateLimited(raw, [structured.session, structured.weekly, scoped, flat.session, flat.weekly]),
  };
  return out;
}

function readStructuredLimits(limits: unknown): {
  session: RawWindow | null;
  weekly: RawWindow | null;
  scoped: RawWindow | null;
} {
  const result = { session: null as RawWindow | null, weekly: null as RawWindow | null, scoped: null as RawWindow | null };
  if (!Array.isArray(limits)) return result;

  for (const entry of limits) {
    if (!isRecord(entry)) continue;
    const kindLabel = typeof entry["kind"] === "string" ? (entry["kind"] as string) : null;
    if (kindLabel === null) continue;

    const normalizedKind = STRUCTURED_KIND_MAP[kindLabel.toLowerCase()];
    if (normalizedKind === undefined) continue;

    const scoped =
      SCOPED_MARKERS.has(kindLabel.toLowerCase()) ||
      SCOPED_MARKERS.has(String(entry["scope"] ?? "").toLowerCase()) ||
      entry["scoped"] === true;

    const win = buildWindow(
      normalizedKind,
      entry,
      kindLabel,
      scoped,
      ["percent", "percent_used", "percentUsed", "utilization", "used_percentage", "usedPercentage"],
      ["severity", "status"],
    );
    if (!win) continue;

    if (scoped) {
      // Keep only the first scoped entry; v1 ignores these for display.
      if (result.scoped === null) result.scoped = win;
    } else if (isWindowPopulated(win)) {
      if (normalizedKind === "session") {
        if (result.session === null || !isWindowPopulated(result.session)) result.session = win;
      } else if (result.weekly === null || !isWindowPopulated(result.weekly)) {
        result.weekly = win;
      }
    }
  }

  return result;
}

function pick(primary: RawWindow | null, fallback: RawWindow | null): RawWindow | null {
  if (isWindowPopulated(primary)) return primary;
  if (isWindowPopulated(fallback)) return fallback;
  return primary ?? fallback;
}

/**
 * Normalize the Claude Code statusline payload.
 *
 * The statusline nests everything under `rate_limits`. Field names differ from the API:
 * `used_percentage` instead of `utilization`/`percent`, and `resets_at` in Unix epoch seconds.
 * Either window may be independently absent - that is normal, not an error.
 */
export function normalizeStatuslinePayload(raw: unknown): NormalizedUsage {
  if (!isRecord(raw)) return { ...EMPTY_USAGE };

  const container = isRecord(raw["rate_limits"]) ? (raw["rate_limits"] as Record<string, unknown>) : raw;

  const found: Record<WindowKind, RawWindow | null> = { session: null, weekly: null };

  for (const [key, kind] of Object.entries(STATUSLINE_KEY_MAP)) {
    if (!isRecord(container[key])) continue;
    const win = buildWindow(kind, container[key], key, false, ["used_percentage", "usedPercentage", "percent", "utilization"], [
      "severity",
      "status",
    ]);
    if (win && isWindowPopulated(win) && found[kind] === null) found[kind] = win;
  }

  return {
    session: found.session,
    weekly: found.weekly,
    weeklyScoped: null,
    // `status` lives inside `rate_limits` in this dialect, so check the container too.
    rateLimited: detectRateLimited(container, [found.session, found.weekly]) || detectRateLimited(raw, [found.session, found.weekly]),
  };
}

/** True when a normalized usage object carries no usable information at all. */
export function isEmptyUsage(usage: NormalizedUsage): boolean {
  return !isWindowPopulated(usage.session) && !isWindowPopulated(usage.weekly);
}

/**
 * Traffic light for a window.
 *
 * Red wins over amber. A rate-limited account is always red even if the percent is low, and an
 * unknown percent is `unknown` rather than optimistically green.
 */
export function trafficLevel(win: UsageWindow | null, accountRateLimited = false): TrafficLevel {
  if (!win || win.percentUsed === null) return "unknown";
  if (accountRateLimited || win.severity === "rate_limited") return "alert";
  if (win.percentUsed > RED_THRESHOLD) return "alert";
  if (win.percentUsed >= AMBER_THRESHOLD) return "warn";
  return "ok";
}

/**
 * A `resets_at` in the past means the window has already rolled over - render it as fully
 * available rather than as a negative countdown.
 */
export function isResetDue(resetsAt: number | null, now: number): boolean {
  return resetsAt !== null && resetsAt > 0 && resetsAt <= now;
}
