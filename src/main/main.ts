import { app, powerMonitor, screen } from "electron";

import { openReleasePage, registerIpc } from "./ipc";
import { Logger, installCrashHandlers } from "./log";
import { Notifier } from "./notify";
import { detectClaudeCodeVersion } from "./oauth";
import { applyLoginItem, userDataDir } from "./paths";
import { Poller } from "./poller";
import { Store } from "./store";
import { captureStatusline, isStatuslineInvocation } from "./statusline";
import { TrayIcon } from "./tray";
import { UpdateChecker } from "./update";
import { WindowManager } from "./window";

/** Must match `build.appId` in package.json so toasts and the installer agree on identity. */
const APP_USER_MODEL_ID = "io.github.claude-usage-widget";

/**
 * Entry point.
 *
 * Two very different run modes share this file:
 *
 *  - **Statusline capture** - launched by Claude Code as `<exe> statusline`. It reads one JSON
 *    payload on stdin, writes a snapshot, and exits 0. No window, no network, and it must never
 *    fail loudly, because it runs inside Claude Code's render loop.
 *  - **Widget** - the normal mode: a tray app with a frameless always-on-top bar.
 */

/** How often the running widget checks for a snapshot a capture process just wrote. */
const STATUSLINE_POLL_MS = 5_000;

function runCaptureMode(): void {
  // Resolving userData requires the app to be ready, which guarantees the capture process writes
  // to exactly the same directory the widget reads - no duplicated path logic to drift.
  void app
    .whenReady()
    .then(() => {
      captureStatusline(userDataDir());
    })
    .catch(() => undefined)
    .finally(() => {
      // Always exit 0, even on empty stdin or a read error: Claude Code surfaces a non-zero exit
      // from a statusline command as a visible error in its own UI.
      app.exit(0);
    });
}

async function runWidgetMode(): Promise<void> {
  // The capture process is short-lived and must never contend for the single-instance lock,
  // otherwise two widgets would appear.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const userData = userDataDir();
  const logger = new Logger(userData);
  installCrashHandlers(logger);
  logger.info(`starting v${app.getVersion()} (${app.isPackaged ? "packaged" : "unpackaged"}, electron ${process.versions.electron})`);

  // Windows attributes toasts to this id; without it they show as "electron.app.Electron".
  app.setAppUserModelId(APP_USER_MODEL_ID);

  const store = new Store(userData);
  const windows = new WindowManager(store);
  windows.onRendererGone((label, reason) => logger.error(`${label} renderer gone: ${reason}`));

  // Assigned by `registerIpc` below; the poller cannot start before then, so this is only ever
  // read after it is set.
  let broadcast: () => void = () => undefined;

  const notifier = new Notifier(store, () => {
    windows.setWidgetVisible(true);
    windows.togglePanel();
  });

  let lastLoggedError: string | null = null;
  const poller = new Poller(store, userData, {
    onState: (snapshot) => {
      if (snapshot.lastError !== lastLoggedError) {
        lastLoggedError = snapshot.lastError;
        if (snapshot.lastError !== null) logger.warn(`poll: ${snapshot.lastError}`);
      }
      tray.update(snapshot);
      notifier.update(snapshot);
      broadcast();
    },
    onAuth: (auth) => {
      logger.info(`auth: ${auth.status}${auth.detail === null ? "" : ` - ${auth.detail}`}`);
      broadcast();
    },
    onPlan: () => broadcast(),
  });

  const updates = new UpdateChecker(store, app.getVersion(), () => {
    const found = updates.get();
    if (found !== null) logger.info(`update available: v${found.version}`);
    tray.sync();
    broadcast();
  });

  let quitting = false;
  const shutdown = (): void => {
    if (quitting) return;
    quitting = true;
    logger.info("quitting");
    poller.stop();
    updates.stop();
    tray.destroy();
    windows.destroy();
    store.dispose();
    app.quit();
  };

  const tray = new TrayIcon(store, windows, {
    refreshNow: () => void poller.refreshNow(),
    quit: () => shutdown(),
    getUpdate: () => updates.get(),
    openUpdate: () => openReleasePage(updates),
  });

  broadcast = registerIpc({
    store,
    poller,
    windows,
    tray,
    userData,
    updates,
    logDir: logger.dir,
    onQuit: () => shutdown(),
  });

  app.on("second-instance", () => windows.setWidgetVisible(true));
  app.on("before-quit", () => {
    poller.stop();
    store.dispose();
  });
  // Tray app: closing a window must not quit.
  app.on("window-all-closed", () => undefined);

  // After sleep the data can be hours old; after a display change the bar can be off-screen.
  powerMonitor.on("resume", () => poller.wake());
  powerMonitor.on("unlock-screen", () => poller.wake());
  screen.on("display-removed", () => windows.reclamp());
  screen.on("display-metrics-changed", () => windows.reclamp());

  windows.createBar();
  tray.create();
  applyLoginItem(store.get().autoLaunch);
  updates.start();

  // The usage endpoint wants a genuine `User-Agent: claude-code/<version>`; a wrong one can earn a
  // 429 and a 15-minute backoff. Probe the version first (bounded, never throws), then poll.
  const version = await detectClaudeCodeVersion();
  logger.info(`user agent: ${version}`);
  poller.start();

  // Handoff from the capture process. A separate short-lived process cannot use Electron's
  // single-instance IPC, so the widget watches the snapshot file instead. It is a few hundred
  // bytes and this is the only way to see a statusline update without waiting out the poll timer.
  const handoff = setInterval(() => poller.ingestStatusline(), STATUSLINE_POLL_MS);
  handoff.unref?.();
}

if (isStatuslineInvocation(process.argv)) {
  // Never take the single-instance lock here: this is a short-lived helper that must run
  // alongside an already-running widget.
  runCaptureMode();
} else {
  void app.whenReady().then(runWidgetMode).catch((error: unknown) => {
    console.error("claude-usage-widget failed to start:", error);
    app.quit();
  });
}
