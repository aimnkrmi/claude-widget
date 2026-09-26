import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type AlertState, evaluateAlerts, initialAlertState } from "../src/main/notify";
import type { UsageSnapshot, UsageWindow } from "../src/shared/types";

const NOW = 1_800_000_000_000;

function win(percentUsed: number | null, resetsAt: number | null = NOW + 3_600_000): UsageWindow {
  return { kind: "session", percentUsed, resetsAt, severity: null, active: true, scoped: false, rawKind: "five_hour" };
}

function snap(session: number | null, weekly: number | null = 10, overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    session: session === null ? null : win(session),
    weekly: weekly === null ? null : { ...win(weekly), kind: "weekly" },
    weeklyScoped: null,
    rateLimited: false,
    source: "oauth",
    fetchedAt: NOW,
    updatedAt: NOW,
    throttled: false,
    stale: false,
    lastError: null,
    ...overrides,
  };
}

/** Run a sequence of session percentages and return the alert titles per step. */
function run(percents: number[], start: AlertState = initialAlertState()): string[][] {
  let state = start;
  return percents.map((p) => {
    const result = evaluateAlerts(state, snap(p), NOW);
    state = result.state;
    return result.alerts.map((a) => a.title);
  });
}

describe("usage notifications", () => {
  it("fires once at 85% and once at 95%", () => {
    const steps = run([50, 86, 88, 96, 97]);
    assert.deepEqual(steps.map((s) => s.length), [0, 1, 0, 1, 0]);
    assert.match(steps[1]?.[0] ?? "", /86%/);
    assert.match(steps[3]?.[0] ?? "", /96%/);
  });

  it("jumping straight past 95% fires only the critical alert", () => {
    const steps = run([10, 97, 90]);
    assert.deepEqual(steps.map((s) => s.length), [0, 1, 0]);
  });

  it("does not re-fire while hovering around the threshold", () => {
    const steps = run([86, 84, 86, 83, 87]);
    assert.deepEqual(steps.map((s) => s.length), [1, 0, 0, 0, 0]);
  });

  it("re-arms after dropping clearly below the threshold", () => {
    const steps = run([86, 70, 86]);
    // 70 is below the re-arm line but above the "session is back" line, so no reset toast.
    assert.deepEqual(steps.map((s) => s.length), [1, 0, 1]);
  });

  it("announces the session reset after it had run high", () => {
    const steps = run([90, 5]);
    assert.deepEqual(steps[1], ["Claude session window has reset"]);
  });

  it("treats a window whose reset time has passed as empty", () => {
    const high = evaluateAlerts(initialAlertState(), snap(92), NOW).state;
    const pastReset = snap(92);
    pastReset.session = win(92, NOW - 1000);
    const { alerts } = evaluateAlerts(high, pastReset, NOW);
    assert.deepEqual(alerts.map((a) => a.title), ["Claude session window has reset"]);
  });

  it("stays quiet without data", () => {
    const { alerts } = evaluateAlerts(initialAlertState(), snap(99, 99, { source: "unknown" }), NOW);
    assert.equal(alerts.length, 0);
  });

  it("tracks the weekly window independently", () => {
    const { alerts } = evaluateAlerts(initialAlertState(), snap(10, 90), NOW);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]?.title ?? "", /7-day/);
  });
});
