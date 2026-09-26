import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { Logger, redact } from "../src/main/log";

describe("diagnostic log", () => {
  const dir = mkdtempSync(join(tmpdir(), "cuw-log-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("masks anything shaped like an Anthropic token", () => {
    assert.equal(redact("refresh sk-ant-ort01-abc_DEF-123 failed"), "refresh sk-ant-*** failed");
  });

  it("appends redacted lines to logs/main.log", () => {
    const logger = new Logger(dir);
    logger.info("hello");
    logger.error("boom", new Error("token sk-ant-oat01-secret leaked"));
    const text = readFileSync(join(dir, "logs", "main.log"), "utf8");
    assert.match(text, /INFO hello/);
    assert.match(text, /ERROR boom: token sk-ant-\*\*\* leaked/);
    assert.doesNotMatch(text, /secret/);
  });
});
