import type { UpdateInfo } from "../shared/types";
import type { Store } from "./store";

/**
 * Notify-only update check against GitHub Releases.
 *
 * Once shortly after start and then once a day, when enabled. It never downloads or installs
 * anything: a newer release just surfaces as a tray item and a panel card linking to the release
 * page. This is the only request the widget makes to anything other than Anthropic.
 */

/** `owner/repo` on GitHub. Also referenced by `repository` and `build.publish` in package.json. */
export const GITHUB_REPO = "OWNER/claude-usage-widget";

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** True until `GITHUB_REPO` has been filled in; checks are skipped rather than hitting a 404. */
export function isRepoConfigured(repo: string = GITHUB_REPO): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.startsWith("OWNER/");
}

function parseVersion(raw: string): { core: number[]; pre: string | null } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(raw.trim());
  if (match === null) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

/**
 * Semver precedence: negative when `a < b`, positive when `a > b`, 0 when equal or unparseable. A
 * prerelease sorts before its release; prerelease identifiers compare as plain strings, which is
 * enough to tell `rc.1` from `rc.2`.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return 0;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * Read `releases/latest` (which already excludes drafts and prereleases). Returns the release only
 * when it is newer than `current`. Never throws.
 */
export async function fetchNewerRelease(
  current: string,
  repo: string = GITHUB_REPO,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
  if (!isRepoConfigured(repo)) return null;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "claude-usage-widget" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const record = body as Record<string, unknown>;
    const tag = record["tag_name"];
    const url = record["html_url"];
    if (typeof tag !== "string" || typeof url !== "string") return null;
    // Only ever link to GitHub; the URL is opened in the user's browser.
    if (!url.startsWith("https://github.com/")) return null;
    if (compareVersions(tag, current) <= 0) return null;
    return { version: tag.replace(/^v/, ""), url };
  } catch {
    return null;
  }
}

export class UpdateChecker {
  private latest: UpdateInfo | null = null;
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly currentVersion: string,
    private readonly onChange: () => void,
  ) {}

  /** The newer release, or `null` when there is none or checks are off. */
  get(): UpdateInfo | null {
    return this.store.get().checkForUpdates ? this.latest : null;
  }

  start(): void {
    this.stop();
    this.timer = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.timer.unref?.();
    this.interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.interval !== null) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  async check(): Promise<void> {
    if (!this.store.get().checkForUpdates) return;
    const found = await fetchNewerRelease(this.currentVersion);
    if (found?.version === this.latest?.version) return;
    this.latest = found;
    this.onChange();
  }
}
