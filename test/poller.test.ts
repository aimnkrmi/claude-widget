import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextDelayMs } from "../src/main/poller";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe("poll scheduling", () => {
  it("uses the configured interval when no reset is near", () => {
    assert.equal(nextDelayMs({ now: NOW, throttled: false, backoffIndex: 0, intervalMinutes: 10, resets: [NOW + 3 * 3_600_000] }), 10 * MIN);
  });

  it("never goes below the 5-minute floor for the interval", () => {
    assert.equal(nextDelayMs({ now: NOW, throttled: false, backoffIndex: 0, intervalMinutes: 1, resets: [] }), 5 * MIN);
  });

  it("pulls the next poll forward to just after an upcoming reset", () => {
    assert.equal(nextDelayMs({ now: NOW, throttled: false, backoffIndex: 0, intervalMinutes: 5, resets: [NOW + 2 * MIN, null] }), 3 * MIN);
  });

  it("ignores resets that are already in the past, so it cannot tight-loop", () => {
    assert.equal(nextDelayMs({ now: NOW, throttled: false, backoffIndex: 0, intervalMinutes: 5, resets: [NOW - 1, NOW] }), 5 * MIN);
  });

  it("waits at least a minute even for an imminent reset", () => {
    const delay = nextDelayMs({ now: NOW, throttled: false, backoffIndex: 0, intervalMinutes: 5, resets: [NOW + 1] });
    assert.ok(delay >= MIN, `expected >= ${MIN}, got ${delay}`);
  });

  it("follows the backoff ladder when throttled, regardless of resets", () => {
    const base = { now: NOW, throttled: true, intervalMinutes: 5, resets: [NOW + MIN] };
    assert.equal(nextDelayMs({ ...base, backoffIndex: 0 }), 15 * MIN);
    assert.equal(nextDelayMs({ ...base, backoffIndex: 1 }), 30 * MIN);
    assert.equal(nextDelayMs({ ...base, backoffIndex: 3 }), 60 * MIN);
    assert.equal(nextDelayMs({ ...base, backoffIndex: 99 }), 60 * MIN);
  });
});
