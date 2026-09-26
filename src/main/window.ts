import { BrowserWindow, screen } from "electron";

import { assetPath } from "./paths";
import type { Store } from "./store";

/**
 * The two windows. The bar is a draggable ambient strip; the panel is a small always-on-top
 * detail view. Both are frameless, transparent and click-through aware.
 *
 * Renderer runs with `contextIsolation: true` and `nodeIntegration: false`; the only bridge is
 * the preload's narrow typed API, and no token ever crosses it.
 */

// The bar is a critter plus two rows, so it is wider and taller than the original two-bar strip.
const BAR_WIDTH = 322;
const BAR_HEIGHT = 74;
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 470;

/** How long a drag stays armed without a move before it is force-released. */
const DRAG_WATCHDOG_MS = 2_000;

function clampToWorkArea(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const display = screen.getDisplayMatching({ x, y, width, height });
  const area = display.workArea;
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), Math.max(maxX, area.x))),
    y: Math.round(Math.min(Math.max(y, area.y), Math.max(maxY, area.y))),
  };
}

function commonOptions(width: number, height: number): Electron.BrowserWindowConstructorOptions {
  return {
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: assetPath("..", "preload", "index.js"),
    },
  };
}

/**
 * A frameless app has no DevTools in front of the user, so renderer failures are otherwise
 * invisible. Opt in with `CLUW_DEBUG=1` to get renderer console output on the main stdout.
 */
function forwardRendererConsole(win: BrowserWindow, label: string): void {
  if (process.env["CLUW_DEBUG"] === undefined) return;
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const levelName = ["debug", "info", "warning", "error"][level] ?? String(level);
    console.log(`[${label}:${levelName}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`[${label}] did-fail-load ${code} ${description} ${url}`);
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[${label}] preload-error ${preloadPath}: ${error.message}`);
  });
}

/**
 * `getPosition()` is typed as a plain array, so under `noUncheckedIndexedAccess` each element is
 * `number | undefined`. Positions are always written as a pair, so a missing value is a bug worth
 * skipping rather than persisting a `null` over good data.
 */
function positionOf(win: BrowserWindow): { x: number; y: number } | null {
  const position = win.getPosition();
  const [x, y] = position;
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { x, y };
}

/**
 * Pin a window to a fixed size. On Windows with fractional display scaling, moving a transparent
 * frameless window rounds its bounds through DIP/pixel conversion and the size creeps up by a pixel
 * per move. During a drag that compounds into an invisible, screen-covering window that swallows
 * every click, so the size is locked here and re-asserted whenever it drifts.
 */
function lockSize(win: BrowserWindow, width: number, height: number): void {
  win.setMinimumSize(width, height);
  win.setMaximumSize(width, height);
  win.on("resize", () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getSize();
    if (w !== width || h !== height) win.setSize(width, height, false);
  });
}

export class WindowManager {
  private bar: BrowserWindow | null = null;
  private panel: BrowserWindow | null = null;
  private dragging = false;
  private dragOffset: { x: number; y: number } | null = null;
  private dragWatchdog: NodeJS.Timeout | null = null;

  constructor(private readonly store: Store) {}

  createBar(): BrowserWindow {
    if (this.bar !== null && !this.bar.isDestroyed()) return this.bar;

    const saved = this.store.get().window;
    const fallback = { x: screen.getPrimaryDisplay().workArea.x + 40, y: screen.getPrimaryDisplay().workArea.y + 40 };
    const position = clampToWorkArea(
      saved.x ?? fallback.x,
      saved.y ?? fallback.y,
      BAR_WIDTH,
      BAR_HEIGHT,
    );

    const win = new BrowserWindow({
      ...commonOptions(BAR_WIDTH, BAR_HEIGHT),
      x: position.x,
      y: position.y,
      alwaysOnTop: true,
    });

    // "screen-saver" keeps the bar above fullscreen apps, not just normal ones.
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    lockSize(win, BAR_WIDTH, BAR_HEIGHT);

    win.loadFile(assetPath("..", "renderer", "bar.html"));
    forwardRendererConsole(win, "bar");

    win.on("moved", () => {
      if (win.isDestroyed()) return;
      const position = positionOf(win);
      if (position !== null) this.store.update({ window: position });
    });

    win.on("blur", () => {
      // Clicking the bar opens the panel, and focusing the panel blurs the bar. Hiding on blur
      // without this check would make the panel close the instant it opened, so the decision is
      // deferred a tick and re-evaluated once focus has actually settled.
      setTimeout(() => {
        const focused = BrowserWindow.getFocusedWindow();
        if (focused === null) return; // Focus left the app entirely; leave the panel as-is.
        if (this.panel !== null && !this.panel.isDestroyed() && focused !== this.panel) this.panel.hide();
      }, 0);
    });

    this.bar = win;
    this.applyClickThrough();
    if (this.store.get().widgetVisible) win.showInactive();
    return win;
  }

  createPanel(): BrowserWindow {
    if (this.panel !== null && !this.panel.isDestroyed()) return this.panel;

    const bar = this.bar;
    const saved = this.store.get().panel;
    const anchor =
      bar !== null && !bar.isDestroyed()
        ? bar.getBounds()
        : { x: screen.getPrimaryDisplay().workArea.x + 40, y: screen.getPrimaryDisplay().workArea.y + 120 };

    const position = clampToWorkArea(
      saved.x ?? anchor.x,
      saved.y ?? anchor.y + BAR_HEIGHT + 8,
      PANEL_WIDTH,
      PANEL_HEIGHT,
    );

    const win = new BrowserWindow({
      ...commonOptions(PANEL_WIDTH, PANEL_HEIGHT),
      x: position.x,
      y: position.y,
      alwaysOnTop: true,
      skipTaskbar: false,
    });

    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    lockSize(win, PANEL_WIDTH, PANEL_HEIGHT);
    win.loadFile(assetPath("..", "renderer", "panel.html"));
    forwardRendererConsole(win, "panel");

    win.on("moved", () => {
      if (win.isDestroyed()) return;
      const position = positionOf(win);
      if (position !== null) this.store.update({ panel: position });
    });

    this.panel = win;
    return win;
  }

  getBar(): BrowserWindow | null {
    return this.bar !== null && !this.bar.isDestroyed() ? this.bar : null;
  }

  getPanel(): BrowserWindow | null {
    return this.panel !== null && !this.panel.isDestroyed() ? this.panel : null;
  }

  togglePanel(): void {
    const panel = this.createPanel();
    if (panel.isVisible()) {
      panel.hide();
      return;
    }
    const bar = this.getBar();
    if (bar !== null) {
      const bounds = bar.getBounds();
      const clamped = clampToWorkArea(bounds.x + bounds.width - PANEL_WIDTH, bounds.y + BAR_HEIGHT + 8, PANEL_WIDTH, PANEL_HEIGHT);
      panel.setBounds({ x: clamped.x, y: clamped.y, width: PANEL_WIDTH, height: PANEL_HEIGHT });
    }
    panel.show();
    panel.focus();
  }

  hidePanel(): void {
    this.getPanel()?.hide();
  }

  setWidgetVisible(visible: boolean): void {
    this.store.update({ widgetVisible: visible });
    const bar = this.getBar();
    if (bar === null) return;
    if (visible) bar.showInactive();
    else bar.hide();
  }

  /**
   * Click-through mode. `forward: true` keeps mousemove events flowing so hover reveal still
   * works while clicks fall through to whatever is underneath.
   */
  setClickThrough(enabled: boolean): void {
    this.store.update({ clickThrough: enabled });
    this.applyClickThrough();
  }

  private applyClickThrough(): void {
    const bar = this.getBar();
    if (bar === null) return;
    bar.setIgnoreMouseEvents(this.store.get().clickThrough, { forward: true });
  }

  /* ------------------------------- drag support ---------------------------------------------- */

  /**
   * The bar is frameless, so the renderer drives the move. We keep the grab offset ourselves
   * because `moved` only reports the final position.
   *
   * `beginDrag` also arms a watchdog: the renderer normally sends `dragEnd` on mouseup, but if that
   * message is lost - the release happened outside the window, or the renderer was torn down - the
   * drag would otherwise stay armed and the widget would follow the pointer indefinitely.
   */
  beginDrag(): void {
    const bar = this.getBar();
    if (bar === null) return;
    const position = positionOf(bar);
    if (position === null) return;
    const cursor = screen.getCursorScreenPoint();
    this.dragging = true;
    this.dragOffset = { x: cursor.x - position.x, y: cursor.y - position.y };
    this.hidePanel();
    this.armDragWatchdog();
  }

  private armDragWatchdog(): void {
    if (this.dragWatchdog !== null) clearTimeout(this.dragWatchdog);
    this.dragWatchdog = setTimeout(() => this.endDrag(), DRAG_WATCHDOG_MS);
    this.dragWatchdog.unref?.();
  }

  dragTo(screenX: number, screenY: number): void {
    if (!this.dragging || this.dragOffset === null) return;
    const bar = this.getBar();
    if (bar === null) return;
    // Clamp with the fixed size and write it back on every move: reading `getBounds()` here would
    // feed any size drift straight back into the next move and let it compound.
    const clamped = clampToWorkArea(screenX - this.dragOffset.x, screenY - this.dragOffset.y, BAR_WIDTH, BAR_HEIGHT);
    bar.setBounds({ x: clamped.x, y: clamped.y, width: BAR_WIDTH, height: BAR_HEIGHT }, false);
    this.armDragWatchdog();
  }

  endDrag(): void {
    if (this.dragWatchdog !== null) {
      clearTimeout(this.dragWatchdog);
      this.dragWatchdog = null;
    }
    const bar = this.getBar();
    this.dragging = false;
    this.dragOffset = null;
    if (bar === null || bar.isDestroyed()) return;
    const bounds = bar.getBounds();
    if (bounds.width !== BAR_WIDTH || bounds.height !== BAR_HEIGHT) {
      const clamped = clampToWorkArea(bounds.x, bounds.y, BAR_WIDTH, BAR_HEIGHT);
      bar.setBounds({ x: clamped.x, y: clamped.y, width: BAR_WIDTH, height: BAR_HEIGHT }, false);
    }
    const position = positionOf(bar);
    if (position !== null) this.store.update({ window: position });
  }

  broadcast(channel: string, payload: unknown): void {
    for (const win of [this.getBar(), this.getPanel()]) {
      if (win !== null) win.webContents.send(channel, payload);
    }
  }

  sendTo(channel: string, payload: unknown, target: "bar" | "panel" = "bar"): void {
    const win = target === "bar" ? this.getBar() : this.getPanel();
    win?.webContents.send(channel, payload);
  }

  destroy(): void {
    if (this.dragWatchdog !== null) clearTimeout(this.dragWatchdog);
    this.dragWatchdog = null;
    this.bar?.destroy();
    this.panel?.destroy();
    this.bar = null;
    this.panel = null;
  }
}
