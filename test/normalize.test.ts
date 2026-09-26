import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  EMPTY_USAGE,
  clampPercent,
  detectRateLimited,
  isEmptyUsage,
  isResetDue,
  normalizeStatuslinePayload,
  normalizeUsageResponse,
  toEpochMs,
  toSeverity,
  trafficLevel,
} from "../src/main/normalize";
import type { UsageWindow } from "../src/shared/types";

const FIXTURES = join(__dirname, "..", "..", "test", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function win(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    kind: "session",
    percentUsed: 0,
    resetsAt: null,
    severity: null,
    active: true,
    scoped: false,
    rawKind: null,
    ...overrides,
  };
}

describe("coercions", () => {
  it("clamps percentages into 0-100 and rejects junk", () => {
    assert.equal(clampPercent(43.5), 43.5);
    assert.equal(clampPercent("78.25"), 78.25);
    assert.equal(clampPercent(-3), 0);
    assert.equal(clampPercent(180), 100);
    assert.equal(clampPercent(null), null);
    assert.equal(clampPercent(""), null);
    assert.equal(clampPercent("abc"), null);
    assert.equal(clampPercent(Number.NaN), null);
    assert.equal(clampPercent(Number.POSITIVE_INFINITY), null);
    assert.equal(clampPercent({}), null);
  });

  it("reads epoch seconds, epoch millis, and ISO-8601 identically", () => {
    assert.equal(toEpochMs(1790422400), 1790422400000);
    assert.equal(toEpochMs(1790422400000), 1790422400000);
    assert.equal(toEpochMs("1790422400"), 1790422400000);
    assert.equal(toEpochMs("2026-09-26T11:20:00.000Z"), Date.parse("2026-09-26T11:20:00.000Z"));
    assert.equal(toEpochMs("not a date"), null);
    assert.equal(toEpochMs(0), null);
    assert.equal(toEpochMs(-5), null);
    assert.equal(toEpochMs(null), null);
    assert.equal(toEpochMs(undefined), null);
  });

  it("maps upstream severity spellings onto the narrow set", () => {
    assert.equal(toSeverity("rate_limited"), "rate_limited");
    assert.equal(toSeverity("RATE_LIMITED"), "rate_limited");
    assert.equal(toSeverity("rejected"), "rejected");
    assert.equal(toSeverity("warning"), "warning");
    assert.equal(toSeverity("normal"), "normal");
    assert.equal(toSeverity("nonsense"), null);
    assert.equal(toSeverity(7), null);
  });
});

describe("normalizeUsageResponse - flat generation", () => {
  it("reads five_hour and seven_day", () => {
    const result = normalizeUsageResponse(fixture("usage-flat.json"));
    assert.equal(result.session?.percentUsed, 43.5);
    assert.equal(result.session?.resetsAt, Date.parse("2026-09-26T14:32:11.000Z"));
    assert.equal(result.session?.rawKind, "five_hour");
    assert.equal(result.weekly?.percentUsed, 78.25);
    assert.equal(result.weekly?.resetsAt, Date.parse("2026-10-01T00:00:00.000Z"));
    assert.equal(result.rateLimited, false);
    assert.equal(isEmptyUsage(result), false);
  });

  it("maps the whole payload status onto rateLimited", () => {
    const result = normalizeUsageResponse({ five_hour: { utilization: 5 }, status: "rate_limited" });
    assert.equal(result.rateLimited, true);
  });
});

describe("normalizeUsageResponse - structured generation", () => {
  it("maps session, weekly_all and ignores weekly_scoped", () => {
    const result = normalizeUsageResponse(fixture("usage-limits-structured.json"));
    assert.equal(result.session?.percentUsed, 61.5);
    assert.equal(result.session?.rawKind, "session");
    assert.equal(result.session?.severity, "warning");
    assert.equal(result.weekly?.percentUsed, 91);
    assert.equal(result.weekly?.rawKind, "weekly_all");
    // The scoped 4% entry must never become the overall weekly figure.
    assert.notEqual(result.weekly?.percentUsed, 4);
  });

  it("prefers the structured array when the flat keys are null", () => {
    const result = normalizeUsageResponse(fixture("usage-limits-hybrid-null-flat.json"));
    assert.equal(result.session?.percentUsed, 37);
    assert.equal(result.session?.resetsAt, 1790419500000);
    assert.equal(result.weekly?.percentUsed, 64.9);
    assert.equal(result.weekly?.resetsAt, 1790996400000);
    assert.equal(result.rateLimited, true);
  });

  it("falls back to flat keys for a window the array does not describe", () => {
    const result = normalizeUsageResponse({
      five_hour: { utilization: 20, resets_at: "2026-09-27T00:00:00.000Z" },
      limits: [{ kind: "weekly_all", percent: 55, resets_at: "2026-10-01T00:00:00.000Z" }],
    });
    assert.equal(result.session?.percentUsed, 20);
    assert.equal(result.session?.rawKind, "five_hour");
    assert.equal(result.weekly?.percentUsed, 55);
    assert.equal(result.weekly?.rawKind, "weekly_all");
  });

  it("prefers the structured array over a populated flat key", () => {
    const result = normalizeUsageResponse({
      five_hour: { utilization: 99 },
      limits: [{ kind: "session", percent: 10, resets_at: "2026-09-27T00:00:00.000Z" }],
    });
    assert.equal(result.session?.percentUsed, 10);
  });

  it("respects is_active", () => {
    const result = normalizeUsageResponse({
      limits: [{ kind: "session", percent: 10, is_active: false }],
    });
    assert.equal(result.session?.active, false);
  });
});

describe("normalizeUsageResponse - hostile input", () => {
  it("returns empty usage for non-objects and unknown shapes", () => {
    for (const bad of [null, undefined, 42, "usage", [], true]) {
      const result = normalizeUsageResponse(bad);
      assert.deepEqual(result, { ...EMPTY_USAGE });
    }
  });

  it("survives malformed limits entries", () => {
    const result = normalizeUsageResponse({
      limits: [null, 5, "session", {}, { kind: 42 }, { kind: "session", percent: "abc" }, { kind: "session", percent: 7 }],
    });
    assert.equal(result.session?.percentUsed, 7);
  });

  it("tolerates a body where every window is present but null", () => {
    const result = normalizeUsageResponse({ five_hour: null, seven_day: null, limits: [] });
    assert.equal(result.session, null);
    assert.equal(result.weekly, null);
    assert.equal(isEmptyUsage(result), true);
  });
});

describe("normalizeStatuslinePayload", () => {
  it("reads used_percentage and epoch-second resets_at", () => {
    const result = normalizeStatuslinePayload(fixture("statusline-normal.json"));
    assert.equal(result.session?.percentUsed, 45.5);
    assert.equal(result.session?.resetsAt, 1790422400000);
    assert.equal(result.weekly?.percentUsed, 12.25);
    assert.equal(result.weekly?.resetsAt, 1790996400000);
    assert.equal(result.rateLimited, false);
  });

  it("handles a session-only payload with no weekly window", () => {
    const result = normalizeStatuslinePayload(fixture("statusline-session-only-limited.json"));
    assert.equal(result.session?.percentUsed, 96.5);
    assert.equal(result.weekly, null);
    assert.equal(result.rateLimited, true);
    assert.equal(isEmptyUsage(result), false);
  });

  it("returns empty usage for empty stdin and for a payload with no rate_limits", () => {
    assert.deepEqual(normalizeStatuslinePayload({}), { ...EMPTY_USAGE });
    assert.deepEqual(normalizeStatuslinePayload({ cost: { total_cost_usd: 1 } }), { ...EMPTY_USAGE });
    assert.deepEqual(normalizeStatuslinePayload(""), { ...EMPTY_USAGE });
  });

  it("accepts the alternative seven_day_all key", () => {
    const result = normalizeStatuslinePayload({
      rate_limits: { seven_day_all: { used_percentage: 5, resets_at: 1790996400 } },
    });
    assert.equal(result.weekly?.percentUsed, 5);
  });
});

describe("detectRateLimited", () => {
  it("trusts an explicit top-level status over per-window severity", () => {
    assert.equal(detectRateLimited({ status: "rate_limited" }, []), true);
    assert.equal(detectRateLimited({ status: "normal" }, []), false);
  });

  it("falls back to per-window severity", () => {
    const result = normalizeUsageResponse({
      status: "normal",
      limits: [{ kind: "session", percent: 10, severity: "rate_limited" }],
    });
    assert.equal(result.rateLimited, true);
  });
});

describe("presentation helpers", () => {
  it("classifies traffic with red winning over amber", () => {
    assert.equal(trafficLevel(win({ percentUsed: 10 })), "ok");
    assert.equal(trafficLevel(win({ percentUsed: 60 })), "warn");
    assert.equal(trafficLevel(win({ percentUsed: 85 })), "warn");
    assert.equal(trafficLevel(win({ percentUsed: 85.1 })), "alert");
    assert.equal(trafficLevel(win({ percentUsed: 99 })), "alert");
    assert.equal(trafficLevel(win({ percentUsed: 5 }), true), "alert");
    assert.equal(trafficLevel(win({ percentUsed: 5, severity: "rate_limited" })), "alert");
    assert.equal(trafficLevel(win({ percentUsed: null })), "unknown");
    assert.equal(trafficLevel(null), "unknown");
  });

  it("treats a past resets_at as a rolled-over window", () => {
    const now = 1_800_000_000_000;
    assert.equal(isResetDue(now - 1, now), true);
    assert.equal(isResetDue(now + 1, now), false);
    assert.equal(isResetDue(null, now), false);
  });
});
