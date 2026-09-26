import { app, ipcMain, shell } from "electron";

import type { AuthState, PlanInfo, StatuslineStatus, WidgetState } from "../shared/types";
import type { Poller } from "./poller";
import { buildStatuslineCommand, claudeAuthStatus, registerStatusline, statuslineStatus, unregisterStatusline } from "./statusline";
import { applyLoginItem, claudeSettingsPath, selfLaunchArgs } from "./paths";
import type { Store } from "./store";
import type { TrayIcon } from "./tray";
import type { UpdateChecker } from "./update";
import type { WindowManager } from "./window";

/**
 * The entire renderer-facing API surface.
 *
 * Every handler here returns a `WidgetState` or a status object. No handler can return a token,
 * a credential path body, or any raw OAuth payload: the renderer only ever sees normalized data.
 */

export const CHANNELS = {
  getState: "widget:get-state",
  stateChanged: "widget:state-changed",
  authChanged: "widget:auth-changed",
  planChanged: "widget:plan-changed",
  refresh: "widget:refresh",
  resetAuth: "widget:reset-auth",
  dragStart: "widget:drag-start",
  dragMove: "widget:drag-move",
  dragEnd: "widget:drag-end",
  togglePanel: "widget:toggle-panel",
  hidePanel: "widget:hide-panel",
  setClickThrough: "widget:set-click-through",
  setWidgetVisible: "widget:set-widget-visible",
  setAutoLaunch: "widget:set-auto-launch",
  setRefreshInterval: "widget:set-refresh-interval",
  getStatusline: "widget:get-statusline",
  registerStatusline: "widget:register-statusline",
  unregisterStatusline: "widget:unregister-statusline",
  setNotifications: "widget:set-notifications",
  setCheckForUpdates: "widget:set-check-for-updates",
  openUpdatePage: "widget:open-update-page",
  openLogFolder: "widget:open-log-folder",
  openSettingsFolder: "widget:open-settings-folder",
  quit: "widget:quit",
} as const;

export interface IpcDeps {
  store: Store;
  poller: Poller;
  windows: WindowManager;
  tray: TrayIcon;
  userData: string;
  updates: UpdateChecker;
  logDir: string;
  onQuit: () => void;
}

/** Open a release page, but only ever on github.com. */
export function openReleasePage(updates: UpdateChecker): void {
  const url = updates.get()?.url;
  if (url !== undefined && url.startsWith("https://github.com/")) void shell.openExternal(url);
}

/**
 * Resolve the plan badge label.
 *
 * `subscription` is the human-meaningful value (`pro`, `max`) and comes from the credentials file
 * when the profile endpoint omits it, because `/api/oauth/profile` frequently reports only
 * `rate_limit_tier`. `default_claude_ai` is an internal tier id, not something to show a user, so
 * it is only used as a last resort and prettified.
 */
function planLabel(auth: AuthState, plan: PlanInfo): string {
  if (auth.status === "signed-out") return "signed out";
  if (auth.status === "insufficient-scope") return "no scope";

  const subscription = plan.subscription?.trim();
  if (subscription !== undefined && subscription !== "" && !subscription.startsWith("default_claude_ai")) {
    return subscription.replace(/^claude_?/i, "");
  }

  const tier = plan.tier?.trim();
  if (tier !== undefined && tier !== "") {
    if (tier.startsWith("default_claude_ai")) return plan.hasClaudeMax === true ? "Max" : "Claude";
    return tier.replace(/^claude_?/i, "").replace(/_/g, " ");
  }

  return "Claude";
}

export function buildState(deps: IpcDeps): WidgetState {
  const auth = deps.poller.getAuth();
  const plan = deps.store.get().lastProfile ?? {
    tier: null,
    subscription: null,
    hasClaudeMax: null,
    email: null,
    organizationName: null,
  };
  return {
    snapshot: deps.poller.getSnapshot(),
    update: deps.updates.get(),
    plan,
    planLabel: planLabel(auth, plan),
    auth,
    settings: deps.store.publicSettings(),
    appVersion: app.getVersion(),
  };
}

function statuslineInfo(deps: IpcDeps): StatuslineStatus {
  return statuslineStatus(deps.store, deps.userData);
}

/** Registers every handler and returns the broadcaster the poller's events feed into. */
export function registerIpc(deps: IpcDeps): () => void {
  const { store, poller, windows, tray } = deps;

  const publish = (): void => {
    const state = buildState(deps);
    windows.broadcast(CHANNELS.stateChanged, state);
  };

  ipcMain.handle(CHANNELS.getState, () => buildState(deps));

  ipcMain.handle(CHANNELS.refresh, async () => {
    await poller.refreshNow();
    publish();
    return buildState(deps);
  });

  ipcMain.handle(CHANNELS.resetAuth, async () => {
    // Use the CLI only as a diagnostic; it can report "logged in" where the file is unusable,
    // which is exactly the ambiguity the user needs disambiguated.
    const cli = await claudeAuthStatus();
    poller.reset();
    poller.ingestStatusline();
    publish();
    return { state: buildState(deps), cliOutput: cli.output, cliAvailable: cli.ok };
  });

  ipcMain.handle(CHANNELS.dragStart, () => {
    windows.beginDrag();
  });

  ipcMain.handle(CHANNELS.dragMove, (_event, point: { x: number; y: number }) => {
    if (typeof point?.x === "number" && typeof point?.y === "number") windows.dragTo(point.x, point.y);
  });

  ipcMain.handle(CHANNELS.dragEnd, () => {
    windows.endDrag();
  });

  ipcMain.handle(CHANNELS.togglePanel, () => {
    windows.togglePanel();
  });

  ipcMain.handle(CHANNELS.hidePanel, () => {
    windows.hidePanel();
  });

  ipcMain.handle(CHANNELS.setClickThrough, (_event, enabled: boolean) => {
    windows.setClickThrough(Boolean(enabled));
    tray.sync();
    publish();
    return buildState(deps);
  });

  ipcMain.handle(CHANNELS.setWidgetVisible, (_event, visible: boolean) => {
    windows.setWidgetVisible(Boolean(visible));
    tray.sync();
    publish();
    return buildState(deps);
  });

  ipcMain.handle(CHANNELS.setAutoLaunch, (_event, enabled: boolean) => {
    const value = Boolean(enabled);
    applyLoginItem(value);
    store.update({ autoLaunch: value });
    publish();
    return buildState(deps);
  });

  ipcMain.handle(CHANNELS.setRefreshInterval, (_event, minutes: number) => {
    if (typeof minutes === "number" && Number.isFinite(minutes)) {
      store.update({ refreshIntervalMinutes: Math.floor(minutes) });
      poller.reschedule();
      tray.sync();
    }
    publish();
    return buildState(deps);
  });

  ipcMain.handle(CHANNELS.getStatusline, () => statuslineInfo(deps));

  ipcMain.handle(CHANNELS.registerStatusline, () => {
    const command = buildStatuslineCommand(process.execPath, selfLaunchArgs());
    const outcome = registerStatusline(claudeSettingsPath(), command, store);
    publish();
    return {
      ok: outcome.ok,
      message: outcome.ok
        ? `Registered in ${claudeSettingsPath()}. Restart Claude Code or start a new session for it to take effect.`
        : outcome.message,
      status: statuslineInfo(deps),
      state: buildState(deps),
    };
  });

  ipcMain.handle(CHANNELS.unregisterStatusline, () => {
    const outcome = unregisterStatusline(claudeSettingsPath(), store);
    publish();
    return {
      ok: outcome.ok,
      message: outcome.ok ? "Previous statusLine restored." : outcome.message,
      status: statuslineInfo(deps),
      state: buildState(deps),
    };
  });

  ipcMain.handle(CHANNELS.setNotifications, (_event, enabled: boolean) => {
    store.update({ notifications: Boolean(enabled) });
    publish();
    return buildState(deps);
  });

  ipcMain.handle(CHANNELS.setCheckForUpdates, (_event, enabled: boolean) => {
    const value = Boolean(enabled);
    store.update({ checkForUpdates: value });
    if (value) void deps.updates.check();
    tray.sync();
    publish();
    return buildState(deps);
  });

  ipcMain.handle(CHANNELS.openUpdatePage, () => {
    openReleasePage(deps.updates);
  });

  ipcMain.handle(CHANNELS.openLogFolder, () => {
    void shell.openPath(deps.logDir);
  });

  ipcMain.handle(CHANNELS.openSettingsFolder, () => {
    void shell.openPath(claudeSettingsPath());
  });

  ipcMain.handle(CHANNELS.quit, () => {
    deps.onQuit();
  });

  return publish;
}
