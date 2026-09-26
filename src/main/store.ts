import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PlanInfo, PublicSettings } from "../shared/types";

export const CONFIG_VERSION = 1;

/** Hard floor on the poll interval. Never tight-loop against the usage endpoint. */
export const MIN_REFRESH_MINUTES = 5;

export interface Config {
  version: number;
  window: { x: number | null; y: number | null };
  panel: { x: number | null; y: number | null };
  refreshIntervalMinutes: number;
  autoLaunch: boolean;
  clickThrough: boolean;
  widgetVisible: boolean;
  /** OAuth token host that last worked, tried first on the next refresh. */
  tokenHost: string | null;
  statusline: {
    registered: boolean;
    /**
     * The exact `statusLine` value that was in `~/.claude/settings.json` before we touched it.
     * Stored verbatim (including `null`, meaning "the key was absent") so unregister restores the
     * file byte-for-byte rather than guessing.
     */
    priorValue: unknown;
    installedCommand: string | null;
  };
  lastProfile: PlanInfo | null;
}

export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  window: { x: null, y: null },
  panel: { x: null, y: null },
  refreshIntervalMinutes: 5,
  autoLaunch: false,
  clickThrough: false,
  widgetVisible: true,
  tokenHost: null,
  statusline: {
    registered: false,
    /**
     * The exact `statusLine` value that was in `~/.claude/settings.json` before we touched it.
     *
     * `undefined` means "we never registered, so there is nothing to restore" and MUST be the
     * default, because unregister treats it as a refusal. `null` means "we registered, and the key
     * was absent beforehand", so unregister deletes it. Collapsing the two would let a fresh
     * install delete a statusline it never touched.
     */
    priorValue: undefined,
    installedCommand: null,
  },
  lastProfile: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Merge an arbitrary parsed object onto the defaults, dropping anything of the wrong type. */
export function reconcileConfig(raw: unknown): Config {
  if (!isRecord(raw)) return { ...DEFAULT_CONFIG };
  const rawWindow = isRecord(raw["window"]) ? (raw["window"] as Record<string, unknown>) : {};
  const rawPanel = isRecord(raw["panel"]) ? (raw["panel"] as Record<string, unknown>) : {};
  const rawStatusline = isRecord(raw["statusline"]) ? (raw["statusline"] as Record<string, unknown>) : {};

  const interval = asNumberOrNull(raw["refreshIntervalMinutes"]);
  const statuslinePrior = rawStatusline["priorValue"];

  return {
    version: CONFIG_VERSION,
    window: { x: asNumberOrNull(rawWindow["x"]), y: asNumberOrNull(rawWindow["y"]) },
    panel: { x: asNumberOrNull(rawPanel["x"]), y: asNumberOrNull(rawPanel["y"]) },
    refreshIntervalMinutes:
      interval !== null && interval >= MIN_REFRESH_MINUTES ? Math.floor(interval) : DEFAULT_CONFIG.refreshIntervalMinutes,
    autoLaunch: asBoolean(raw["autoLaunch"], DEFAULT_CONFIG.autoLaunch),
    clickThrough: asBoolean(raw["clickThrough"], DEFAULT_CONFIG.clickThrough),
    widgetVisible: asBoolean(raw["widgetVisible"], DEFAULT_CONFIG.widgetVisible),
    tokenHost: asStringOrNull(raw["tokenHost"]),
    statusline: {
      registered: asBoolean(rawStatusline["registered"], false),
      // `undefined` and `null` are meaningfully different here: `null` means "the key was absent",
      // `undefined` means "we never recorded anything, do not restore".
      priorValue: statuslinePrior === undefined ? undefined : statuslinePrior,
      installedCommand: asStringOrNull(rawStatusline["installedCommand"]),
    },
    lastProfile: isRecord(raw["lastProfile"]) ? (raw["lastProfile"] as unknown as PlanInfo) : null,
  };
}

/**
 * Small JSON config persisted next to the app data. Writes are atomic (tmp file + rename) so a
 * crash mid-write can never leave a truncated config that breaks the next launch.
 */
export class Store {
  private data: Config;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly file: string;
  /** Set when a save fails; surfaced in the panel rather than thrown at the caller. */
  lastSaveError: string | null = null;

  constructor(private readonly dir: string) {
    this.file = join(dir, "config.json");
    this.data = this.read();
  }

  private read(): Config {
    try {
      return reconcileConfig(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  get(): Config {
    return this.data;
  }

  /** Shallow-merge a patch, re-reconcile, and schedule a debounced save. */
  update(patch: Partial<Config>): Config {
    this.data = reconcileConfig({ ...this.data, ...patch });
    this.schedule();
    return this.data;
  }

  setStatusline(patch: Partial<Config["statusline"]>): Config {
    this.data = reconcileConfig({
      ...this.data,
      statusline: { ...this.data.statusline, ...patch },
    });
    this.schedule();
    return this.data;
  }

  publicSettings(): PublicSettings {
    return {
      refreshIntervalMinutes: this.data.refreshIntervalMinutes,
      autoLaunch: this.data.autoLaunch,
      clickThrough: this.data.clickThrough,
      widgetVisible: this.data.widgetVisible,
      statuslineRegistered: this.data.statusline.registered,
      statuslineExistingCommand: this.data.statusline.installedCommand,
      statuslineRestorable: this.data.statusline.priorValue !== undefined,
    };
  }

  private schedule(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, 400);
    this.flushTimer.unref?.();
  }

  /** Write immediately. Used on quit, where a debounce would lose the change. */
  flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.file);
      this.lastSaveError = null;
    } catch (error) {
      this.lastSaveError = error instanceof Error ? error.message : String(error);
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best effort; the original config is untouched either way.
      }
    }
  }

  dispose(): void {
    this.flushNow();
  }
}
