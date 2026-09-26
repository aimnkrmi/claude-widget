import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  CredentialWriteError,
  hasRequiredScope,
  mergeTokenResponse,
  needsRefresh,
  readCredentials,
  readCredentialsFile,
  writeCredentialsAtomically,
} from "../src/main/credentials";
import type { ClaudeCredentials } from "../src/main/credentials";
import { DEFAULT_CONFIG, MIN_REFRESH_MINUTES, reconcileConfig } from "../src/main/store";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cuw-test-"));
  temps.push(dir);
  return dir;
}

function credsFile(dir: string, name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return path;
}

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function sampleCreds(): ClaudeCredentials {
  return {
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-original",
      refreshToken: "sk-ant-ort01-original",
      expiresAt: 1_900_000_000_000,
      refreshTokenExpiresAt: 1_900_000_000_000,
      scopes: ["user:profile", "user:inference"],
      subscriptionType: "pro",
      rateLimitTier: "default_claude_ai",
    },
    mcpOAuth: { keepMe: { token: "unrelated" } },
  };
}

describe("credential discovery", () => {
  it("returns typed failures instead of throwing", () => {
    const dir = tempDir();
    assert.equal(readCredentialsFile(join(dir, "nope.json")).failure, "missing");
    assert.equal(readCredentialsFile(credsFile(dir, "bad.json", "{not json")).failure, "malformed");
    assert.equal(readCredentialsFile(credsFile(dir, "arr.json", [])).failure, "malformed");
    assert.equal(readCredentialsFile(credsFile(dir, "nooauth.json", { a: 1 })).failure, "no-oauth");
    assert.equal(
      readCredentialsFile(credsFile(dir, "noacc.json", { claudeAiOauth: { accessToken: "", refreshToken: "r" } }))
        .failure,
      "no-access-token",
    );
    assert.equal(
      readCredentialsFile(credsFile(dir, "noref.json", { claudeAiOauth: { accessToken: "a", refreshToken: "  " } }))
        .failure,
      "no-refresh-token",
    );
  });

  it("takes the first readable candidate", () => {
    const dir = tempDir();
    const first = credsFile(dir, ".credentials.json", sampleCreds());
    const second = credsFile(dir, "second.json", sampleCreds());
    const result = readCredentials([join(dir, "absent.json"), first, second]);
    assert.equal(result.ok, true);
    assert.equal(result.path, first);
  });

  it("reports a missing file when nothing exists", () => {
    const dir = tempDir();
    const result = readCredentials([join(dir, "a.json"), join(dir, "b.json")]);
    assert.equal(result.ok, false);
    assert.equal(result.failure, "missing");
  });

  it("detects the required scope", () => {
    assert.equal(hasRequiredScope({ accessToken: "a", refreshToken: "b", expiresAt: 1, scopes: ["user:profile"] }), true);
    assert.equal(hasRequiredScope({ accessToken: "a", refreshToken: "b", expiresAt: 1, scopes: ["user:inference"] }), false);
    assert.equal(hasRequiredScope({ accessToken: "a", refreshToken: "b", expiresAt: 1 }), false);
    assert.equal(hasRequiredScope(null), false);
  });

  it("triggers refresh inside the 5 minute skew", () => {
    const now = 1_800_000_000_000;
    assert.equal(needsRefresh({ accessToken: "a", refreshToken: "b", expiresAt: now + 10 * 60_000 }, 5 * 60_000, now), false);
    assert.equal(needsRefresh({ accessToken: "a", refreshToken: "b", expiresAt: now + 4 * 60_000 }, 5 * 60_000, now), true);
    assert.equal(needsRefresh({ accessToken: "a", refreshToken: "b", expiresAt: now - 1 }, 5 * 60_000, now), true);
    assert.equal(needsRefresh({ accessToken: "a", refreshToken: "b", expiresAt: 0 }, 5 * 60_000, now), true);
    assert.equal(needsRefresh(null, 5 * 60_000, now), false);
  });
});

describe("atomic credential write-back", () => {
  it("rotates tokens and preserves every unknown key", () => {
    const dir = tempDir();
    const path = credsFile(dir, ".credentials.json", sampleCreds());

    const merged = mergeTokenResponse(sampleCreds(), {
      accessToken: "sk-ant-oat01-rotated",
      refreshToken: "sk-ant-ort01-rotated",
      expiresIn: 3600,
    });
    const outcome = writeCredentialsAtomically(path, merged);

    assert.ok(outcome.bytes > 0);
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.claudeAiOauth.accessToken, "sk-ant-oat01-rotated");
    assert.equal(written.claudeAiOauth.refreshToken, "sk-ant-ort01-rotated");
    assert.ok(written.claudeAiOauth.expiresAt > Date.now());
    assert.equal(written.claudeAiOauth.subscriptionType, "pro");
    assert.equal(written.claudeAiOauth.rateLimitTier, "default_claude_ai");
    assert.deepEqual(written.mcpOAuth, { keepMe: { token: "unrelated" } });
  });

  it("survives five consecutive rotations with a valid, non-empty file every time", () => {
    const dir = tempDir();
    const path = credsFile(dir, ".credentials.json", sampleCreds());

    for (let i = 0; i < 5; i += 1) {
      const current = readCredentialsFile(path);
      assert.equal(current.ok, true, `read ${i} failed`);
      const merged = mergeTokenResponse(current.data as ClaudeCredentials, {
        accessToken: `sk-ant-oat01-gen-${i}`,
        refreshToken: `sk-ant-ort01-gen-${i}`,
        expiresIn: 3600,
      });
      writeCredentialsAtomically(path, merged);

      const after = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(after.claudeAiOauth.accessToken, `sk-ant-oat01-gen-${i}`);
      assert.equal(after.claudeAiOauth.refreshToken, `sk-ant-ort01-gen-${i}`);
      assert.notEqual(after.claudeAiOauth.expiresAt, 0);
      assert.equal(existsSync(join(dir, ".credentials.json.tmp")), false, "tmp file must not survive");
    }
  });

  it("refuses to write empty tokens and leaves the original untouched", () => {
    const dir = tempDir();
    const path = credsFile(dir, ".credentials.json", sampleCreds());
    const before = readFileSync(path, "utf8");

    const badCases: Array<[string, ClaudeCredentials]> = [
      ["empty accessToken", { ...sampleCreds(), claudeAiOauth: { ...sampleCreds().claudeAiOauth, accessToken: "" } }],
      ["empty refreshToken", { ...sampleCreds(), claudeAiOauth: { ...sampleCreds().claudeAiOauth, refreshToken: "" } }],
      ["zero expiresAt", { ...sampleCreds(), claudeAiOauth: { ...sampleCreds().claudeAiOauth, expiresAt: 0 } }],
      ["negative expiresAt", { ...sampleCreds(), claudeAiOauth: { ...sampleCreds().claudeAiOauth, expiresAt: -1 } }],
      ["no oauth", { mcpOAuth: {} } as unknown as ClaudeCredentials],
    ];

    for (const [label, bad] of badCases) {
      assert.throws(() => writeCredentialsAtomically(path, bad), CredentialWriteError, label);
      assert.equal(readFileSync(path, "utf8"), before, `${label} must not modify the file`);
    }
    assert.equal(existsSync(join(dir, ".credentials.json.tmp")), false);
  });

  it("leaves no tmp file behind when the target directory is not writable", () => {
    const dir = tempDir();
    const path = credsFile(dir, ".credentials.json", sampleCreds());
    const before = readFileSync(path, "utf8");

    // A directory path in place of the file makes writeFileSync fail before the rename.
    assert.throws(() => writeCredentialsAtomically(dir, sampleCreds()), CredentialWriteError);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(existsSync(join(dir, ".credentials.json.tmp")), false);
  });

  it("prefers an explicit expiresAt over expiresIn and keeps the prior value when neither is usable", () => {
    const base = sampleCreds();
    const explicit = mergeTokenResponse(base, {
      accessToken: "a",
      refreshToken: "b",
      expiresAt: 1_950_000_000_000,
      expiresIn: 60,
    });
    assert.equal(explicit.claudeAiOauth.expiresAt, 1_950_000_000_000);

    const derived = mergeTokenResponse(base, { accessToken: "a", refreshToken: "b", expiresIn: 3600 });
    assert.ok(derived.claudeAiOauth.expiresAt > Date.now());

    const kept = mergeTokenResponse(base, { accessToken: "a", refreshToken: "b" });
    assert.equal(kept.claudeAiOauth.expiresAt, base.claudeAiOauth.expiresAt);
  });

  it("replaces scopes only when the response carries them", () => {
    const base = sampleCreds();
    assert.deepEqual(mergeTokenResponse(base, { accessToken: "a", refreshToken: "b" }).claudeAiOauth.scopes, base.claudeAiOauth.scopes);
    assert.deepEqual(
      mergeTokenResponse(base, { accessToken: "a", refreshToken: "b", scopes: ["user:profile"] }).claudeAiOauth.scopes,
      ["user:profile"],
    );
  });
});

describe("config reconciliation", () => {
  it("falls back to defaults for garbage", () => {
    const config = reconcileConfig("nope");
    assert.equal(config.refreshIntervalMinutes, DEFAULT_CONFIG.refreshIntervalMinutes);
    assert.ok(config.refreshIntervalMinutes >= MIN_REFRESH_MINUTES);
    assert.equal(config.statusline.registered, false);
    assert.equal(config.tokenHost, null);
  });

  it("never accepts a refresh interval below the floor", () => {
    assert.equal(reconcileConfig({ refreshIntervalMinutes: 1 }).refreshIntervalMinutes, DEFAULT_CONFIG.refreshIntervalMinutes);
    assert.equal(reconcileConfig({ refreshIntervalMinutes: 4 }).refreshIntervalMinutes, DEFAULT_CONFIG.refreshIntervalMinutes);
    assert.equal(reconcileConfig({ refreshIntervalMinutes: 30 }).refreshIntervalMinutes, 30);
  });

  it("distinguishes 'no prior statusLine' from 'never recorded one'", () => {
    const objectPrior = reconcileConfig({ statusline: { priorValue: { type: "command", command: "x" } } }).statusline.priorValue as
      | { type: string }
      | undefined;
    assert.equal(reconcileConfig({ statusline: { priorValue: null } }).statusline.priorValue, null);
    assert.equal(objectPrior?.type, "command");
    assert.equal(reconcileConfig({}).statusline.priorValue, undefined);
  });
});
