import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareVersions, fetchNewerRelease, isRepoConfigured } from "../src/main/update";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("version comparison", () => {
  it("orders by major, minor, patch", () => {
    assert.ok(compareVersions("1.2.3", "1.2.4") < 0);
    assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
    assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
    assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  });

  it("sorts a prerelease before its release", () => {
    assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
    assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0);
    assert.ok(compareVersions("1.0.0-rc.1", "1.0.0-rc.2") < 0);
  });

  it("treats garbage as equal rather than as an update", () => {
    assert.equal(compareVersions("latest", "1.0.0"), 0);
  });
});

describe("release lookup", () => {
  const repo = "someone/claude-usage-widget";

  it("recognises the placeholder repo as unconfigured", () => {
    assert.equal(isRepoConfigured("OWNER/claude-usage-widget"), false);
    assert.equal(isRepoConfigured(repo), true);
    assert.equal(isRepoConfigured("not a repo"), false);
  });

  it("reports a newer release", async () => {
    const found = await fetchNewerRelease(
      "1.0.0",
      repo,
      fakeFetch(200, { tag_name: "v1.1.0", html_url: "https://github.com/someone/claude-usage-widget/releases/tag/v1.1.0" }),
    );
    assert.deepEqual(found, { version: "1.1.0", url: "https://github.com/someone/claude-usage-widget/releases/tag/v1.1.0" });
  });

  it("ignores the same or an older release", async () => {
    const body = { tag_name: "v1.0.0", html_url: "https://github.com/x/y/releases/tag/v1.0.0" };
    assert.equal(await fetchNewerRelease("1.0.0", repo, fakeFetch(200, body)), null);
    assert.equal(await fetchNewerRelease("1.2.0", repo, fakeFetch(200, body)), null);
  });

  it("refuses a release URL outside github.com", async () => {
    const body = { tag_name: "v9.0.0", html_url: "https://evil.example/download" };
    assert.equal(await fetchNewerRelease("1.0.0", repo, fakeFetch(200, body)), null);
  });

  it("never throws on HTTP or network failure", async () => {
    assert.equal(await fetchNewerRelease("1.0.0", repo, fakeFetch(404, { message: "Not Found" })), null);
    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    assert.equal(await fetchNewerRelease("1.0.0", repo, failing), null);
  });

  it("does not call the network while the repo is unconfigured", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    assert.equal(await fetchNewerRelease("1.0.0", "OWNER/claude-usage-widget", spy), null);
    assert.equal(called, false);
  });
});
