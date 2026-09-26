import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import ts from "typescript";

import type { UsageWindow } from "../src/shared/types";

/**
 * `src/renderer/format.ts` is a classic browser script that publishes `window.cuwFormat`, so it
 * cannot be imported. Transpile it and run it in a sandbox with a stand-in `window` instead.
 */
interface Format {
  AMBER: number;
  RED: number;
  CRITICAL: number;
  isResetDue: (resetsAt: number | null, now: number) => boolean;
  effectivePercent: (win: UsageWindow | null, now: number) => number | null;
  level: (percent: number | null, rateLimited: boolean) => string;
  countdown: (resetsAt: number | null, now: number, style?: "compact" | "long") => string;
  age: (timestamp: number | null, now: number, style?: "compact" | "long") => string;
  stamp: (resetsAt: number | null) => string;
}

function loadFormat(): Format {
  const source = readFileSync(join(__dirname, "..", "..", "src", "renderer", "format.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = { window: {} as { cuwFormat?: Format } };
  runInNewContext(js, sandbox);
  assert.ok(sandbox.window.cuwFormat, "format.ts did not publish window.cuwFormat");
  return sandbox.window.cuwFormat;
}

const fmt = loadFormat();
const NOW = 1_800_000_000_000;

function win(percentUsed: number | null, resetsAt: number | null): UsageWindow {
  return { kind: "session", percentUsed, resetsAt, severity: null, active: true, scoped: false, rawKind: null };
}

describe("renderer formatting", () => {
  it("classifies traffic levels like the main process", () => {
    assert.equal(fmt.level(10, false), "ok");
    assert.equal(fmt.level(60, false), "warn");
    assert.equal(fmt.level(85, false), "warn");
    assert.equal(fmt.level(85.1, false), "alert");
    assert.equal(fmt.level(5, true), "alert");
    assert.equal(fmt.level(null, false), "unknown");
  });

  it("shows a window whose reset has passed as empty", () => {
    assert.equal(fmt.effectivePercent(win(92, NOW - 1), NOW), 0);
    assert.equal(fmt.effectivePercent(win(92, NOW + 1), NOW), 92);
    assert.equal(fmt.effectivePercent(win(140, null), NOW), 100);
    assert.equal(fmt.effectivePercent(win(null, NOW + 1), NOW), null);
    assert.equal(fmt.effectivePercent(null, NOW), null);
  });

  it("formats compact countdowns for the bar", () => {
    assert.equal(fmt.countdown(null, NOW), "--");
    assert.equal(fmt.countdown(NOW - 5000, NOW), "reset");
    assert.equal(fmt.countdown(NOW + 30_000, NOW), "<1m");
    assert.equal(fmt.countdown(NOW + 48 * 60_000, NOW), "48m");
    assert.equal(fmt.countdown(NOW + (3 * 60 + 45) * 60_000, NOW), "3h45m");
    assert.equal(fmt.countdown(NOW + 3 * 3_600_000, NOW), "3h");
    assert.equal(fmt.countdown(NOW + 50 * 3_600_000, NOW), "2d2h");
  });

  it("formats long countdowns for the panel", () => {
    assert.equal(fmt.countdown(null, NOW, "long"), "unknown");
    assert.equal(fmt.countdown(NOW - 5000, NOW, "long"), "rolled over - window has reset");
    assert.equal(fmt.countdown(NOW + (2 * 60 + 14) * 60_000, NOW, "long"), "2h 14m");
    assert.equal(fmt.countdown(NOW + 50 * 3_600_000, NOW, "long"), "2d 2h");
  });

  it("formats relative ages", () => {
    assert.equal(fmt.age(null, NOW), "no data");
    assert.equal(fmt.age(null, NOW, "long"), "never");
    assert.equal(fmt.age(NOW - 5_000, NOW), "just now");
    assert.equal(fmt.age(NOW - 5_000, NOW, "long"), "5s ago");
    assert.equal(fmt.age(NOW - 4 * 60_000, NOW), "4m ago");
    assert.equal(fmt.age(NOW - 2 * 3_600_000, NOW), "2h ago");
    assert.equal(fmt.age(NOW - 3 * 86_400_000, NOW), "3d ago");
  });

  it("keeps its thresholds in step with the main process", async () => {
    const normalize = await import("../src/main/normalize");
    assert.equal(fmt.RED, normalize.RED_THRESHOLD);
    assert.equal(fmt.AMBER, normalize.AMBER_THRESHOLD);
  });
});
