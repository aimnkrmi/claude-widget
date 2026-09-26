import { app } from "electron";

import { registerIpc } from "./ipc";
import { detectClaudeCodeVersion } from "./oauth";
import { userDataDir } from "./paths";
import { Poller } from "./poller";
import { Store } from "./store";
import { captureStatusline, isStatuslineInvocation } from "./statusline";
import { TrayIcon } from "./tray";
import { WindowManager } from "./window";

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

function runWidgetMode(): void {
  // The capture process is short-lived and must never contend for the single-instance lock,
  // otherwise two widgets would appear.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const userData = userDataDir();
  const store = new Store(userData);
  const windows = new WindowManager(store);

  // Assigned by `registerIpc` below; the poller cannot start before then, so this is only ever
  // read after it is set.
  let broadcast: () => void = () => undefined;

  const poller = new Poller(store, userData, {
    onState: (snapshot) => {
      tray.update(snapshot);
      broadcast();
    },
    onAuth: () => broadcast(),
    onPlan: () => broadcast(),
  });

  let quitting = false;
  const shutdown = (): void => {
    if (quitting) return;
    quitting = true;
    poller.stop();
    tray.destroy();
    windows.destroy();
    store.dispose();
    app.quit();
  };

  const tray = new TrayIcon(store, windows, {
    refreshNow: () => void poller.refreshNow(),
    quit: () => shutdown(),
  });

  broadcast = registerIpc({
    store,
    poller,
    windows,
    tray,
    userData,
    onQuit: () => shutdown(),
  });

  app.on("second-instance", () => windows.setWidgetVisible(true));
  app.on("before-quit", () => {
    poller.stop();
    store.dispose();
  });
  // Tray app: closing a window must not quit.
  app.on("window-all-closed", () => undefined);

  windows.createBar();
  tray.create();
  poller.start();
  app.setLoginItemSettings({ openAtLogin: store.get().autoLaunch, args: [] });

  // Probe the real Claude Code version in the background, then re-poll once so the usage request
  // carries a genuine `User-Agent` rather than the fallback.
  void detectClaudeCodeVersion().then(() => {
    void poller.refreshNow();
  });

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
  void app.whenReady().then(runWidgetMode, (error: unknown) => {
    console.error("claude-usage-widget failed to start:", error);
    app.quit();
  });
}
