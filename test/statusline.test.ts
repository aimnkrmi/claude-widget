import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { DEFAULT_CONFIG, Store } from "../src/main/store";
import {
  buildStatuslineCommand,
  isStatuslineInvocation,
  parseAndStoreStatusline,
  readExistingStatusline,
  registerStatusline,
  unregisterStatusline,
} from "../src/main/statusline";
import { normalizeStatuslinePayload } from "../src/main/normalize";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cuw-sl-"));
  temps.push(dir);
  return dir;
}

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A Store backed by a real temp dir so statusline prior-value bookkeeping behaves for real. */
function makeStore(dir: string): Store {
  const store = new Store(dir);
  assert.deepEqual(store.get(), { ...DEFAULT_CONFIG });
  return store;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("statusline invocation detection", () => {
  it("matches the flag in any argument position", () => {
    assert.equal(isStatuslineInvocation(["electron", ".", "statusline"]), true);
    assert.equal(isStatuslineInvocation(["exe", "--statusline"]), true);
    assert.equal(isStatuslineInvocation(["electron", "."]), false);
    assert.equal(isStatuslineInvocation(["electron", ".", "statuslines"]), false);
  });
});

describe("statusline command construction", () => {
  it("uses forward slashes and quotes paths containing spaces", () => {
    assert.equal(
      buildStatuslineCommand("D:\\Programming Language\\claude-widget\\widget.exe"),
      '"D:/Programming Language/claude-widget/widget.exe" statusline',
    );
    assert.equal(buildStatuslineCommand("C:\\tools\\widget.exe"), "C:/tools/widget.exe statusline");
  });
});

describe("parseAndStoreStatusline", () => {
  it("treats blank input as an empty payload and writes nothing", () => {
    const dir = tempDir();
    for (const text of ["", "   ", "\n", "\u00a0"]) {
      const result = parseAndStoreStatusline(dir, text);
      assert.deepEqual(result, { emptyStdin: true, wroteSnapshot: false, payload: null });
    }
    assert.equal(existsSync(join(dir, "usage-snapshot.json")), false);
  });

  it("survives unparseable JSON without throwing", () => {
    const dir = tempDir();
    assert.deepEqual(parseAndStoreStatusline(dir, "{not json"), {
      emptyStdin: false,
      wroteSnapshot: false,
      payload: null,
    });
    assert.equal(existsSync(join(dir, "usage-snapshot.json")), false);
  });

  it("writes a snapshot whose payload normalizes correctly", () => {
    const dir = tempDir();
    const payload = {
      rate_limits: {
        five_hour: { used_percentage: 45.5, resets_at: 1790422400 },
        seven_day: { used_percentage: 12.25, resets_at: 1790996400 },
        status: "normal",
      },
    };
    const result = parseAndStoreStatusline(dir, JSON.stringify(payload));
    assert.equal(result.emptyStdin, false);
    assert.equal(result.wroteSnapshot, true);

    const written = readJson(join(dir, "usage-snapshot.json"));
    assert.equal(typeof written["capturedAt"], "number");
    const usage = normalizeStatuslinePayload(written["payload"]);
    assert.equal(usage.session?.percentUsed, 45.5);
    assert.equal(usage.session?.resetsAt, 1790422400000);
    assert.equal(usage.weekly?.percentUsed, 12.25);
    assert.equal(usage.rateLimited, false);
  });

  it("accepts a payload with a UTF-8 BOM", () => {
    const dir = tempDir();
    const result = parseAndStoreStatusline(dir, `\ufeff${JSON.stringify({ rate_limits: { five_hour: { used_percentage: 7 } } })}`);
    assert.equal(result.wroteSnapshot, true);
  });

  it("leaves no tmp file behind", () => {
    const dir = tempDir();
    parseAndStoreStatusline(dir, JSON.stringify({ rate_limits: {} }));
    assert.equal(existsSync(join(dir, "usage-snapshot.json.tmp")), false);
  });
});

describe("settings.json registration", () => {
  it("preserves unrelated keys and records that statusLine was absent", () => {
    const dir = tempDir();
    const settings = join(dir, "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({ permissions: { defaultMode: "auto" }, theme: "dark", model: "sonnet" }, null, 2),
      "utf8",
    );
    const store = makeStore(dir);

    const outcome = registerStatusline(settings, "C:/widget.exe statusline", store);
    assert.equal(outcome.ok, true);

    const after = readJson(settings);
    assert.deepEqual(after["permissions"], { defaultMode: "auto" });
    assert.equal(after["theme"], "dark");
    assert.equal(after["model"], "sonnet");
    assert.deepEqual(after["statusLine"], { type: "command", command: "C:/widget.exe statusline" });
    assert.equal(store.get().statusline.registered, true);
    assert.equal(store.get().statusline.priorValue, null);

    const restored = unregisterStatusline(settings, store);
    assert.equal(restored.ok, true);
    const back = readJson(settings);
    assert.equal("statusLine" in back, false);
    assert.deepEqual(back["permissions"], { defaultMode: "auto" });
  });

  it("records an existing statusLine verbatim and restores it exactly", () => {
    const dir = tempDir();
    const settings = join(dir, "settings.json");
    const prior = { type: "command", command: "C:/other/thing.ps1", padding: 3 };
    writeFileSync(settings, JSON.stringify({ statusLine: prior, theme: "light" }, null, 2), "utf8");
    const store = makeStore(dir);

    registerStatusline(settings, "C:/widget.exe statusline", store);
    assert.deepEqual(readJson(settings)["statusLine"], { type: "command", command: "C:/widget.exe statusline" });

    assert.equal(unregisterStatusline(settings, store).ok, true);
    assert.deepEqual(readJson(settings)["statusLine"], prior);
    assert.equal(readJson(settings)["theme"], "light");
  });

  it("reads the current command and whether the key exists", () => {
    const dir = tempDir();
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ theme: "dark" }), "utf8");
    assert.deepEqual(readExistingStatusline(settings), { present: false, command: null, raw: undefined });

    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "x" } }), "utf8");
    assert.equal(readExistingStatusline(settings).present, true);
    assert.equal(readExistingStatusline(settings).command, "x");

    writeFileSync(settings, JSON.stringify({ statusLine: "something-else" }), "utf8");
    const odd = readExistingStatusline(settings);
    assert.equal(odd.present, true);
    assert.equal(odd.command, null);
  });

  it("refuses to overwrite a settings.json that is not valid JSON", () => {
    const dir = tempDir();
    const settings = join(dir, "settings.json");
    writeFileSync(settings, "{ this is not json", "utf8");
    const store = makeStore(dir);

    const outcome = registerStatusline(settings, "C:/widget.exe statusline", store);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "unreadable");
    assert.equal(readFileSync(settings, "utf8"), "{ this is not json");
    assert.equal(store.get().statusline.registered, false);
  });

  it("refuses to unregister when no prior value was ever recorded", () => {
    const dir = tempDir();
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ theme: "dark" }), "utf8");
    const store = makeStore(dir);

    const outcome = unregisterStatusline(settings, store);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "not-restorable");
    assert.deepEqual(readJson(settings), { theme: "dark" });
  });

  it("writes settings.json when the file does not exist yet", () => {
    const dir = tempDir();
    const settings = join(dir, "settings.json");
    const store = makeStore(dir);

    assert.equal(registerStatusline(settings, "C:/widget.exe statusline", store).ok, true);
    assert.deepEqual(readJson(settings)["statusLine"], { type: "command", command: "C:/widget.exe statusline" });
  });
});
