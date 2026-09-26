import { Menu, Tray as ElectronTray, nativeImage } from "electron";

import { applyLoginItem, assetPath } from "./paths";
import type { UpdateInfo, UsageSnapshot } from "../shared/types";
import { trafficLevel } from "./normalize";
import { REFRESH_INTERVAL_CHOICES, type Store } from "./store";
import type { WindowManager } from "./window";

/**
 * Tray icon and menu. The icon colour tracks the account state so the widget is readable even
 * when the bar is hidden or click-through is on.
 */

const ICON_VARIANTS = {
  ok: ["tray.png", "tray@2x.png"],
  warn: ["tray-warn.png", "tray-warn@2x.png"],
  muted: ["tray-muted.png", "tray-muted@2x.png"],
  alert: ["tray-alert.png", "tray-alert@2x.png"],
} as const;

type IconVariant = keyof typeof ICON_VARIANTS;

export interface TrayActions {
  refreshNow: () => void;
  setRefreshInterval: (minutes: number) => void;
  quit: () => void;
  /** A newer release, if the update check found one. */
  getUpdate: () => UpdateInfo | null;
  openUpdate: () => void;
}

/** The preset intervals, plus the current one if it was set by hand in settings.json. */
function intervalChoices(current: number): number[] {
  const choices: number[] = [...REFRESH_INTERVAL_CHOICES];
  if (!choices.includes(current)) choices.push(current);
  return choices.sort((a, b) => a - b);
}

export class TrayIcon {
  private tray: ElectronTray | null = null;
  private lastVariant: IconVariant | null = null;

  constructor(
    private readonly store: Store,
    private readonly windows: WindowManager,
    private readonly actions: TrayActions,
  ) {}

  create(): void {
    if (this.tray !== null) return;
    this.tray = new ElectronTray(this.loadImage("ok"));
    this.tray.setToolTip("Claude Usage Widget");
    // Left click toggles the bar; the full menu is on right click, matching Windows conventions.
    this.tray.on("click", () => {
      const bar = this.windows.getBar();
      if (bar === null) return;
      const show = !bar.isVisible();
      if (!show) this.windows.hidePanel();
      this.windows.setWidgetVisible(show);
      this.rebuild();
    });
    this.tray.on("right-click", () => this.rebuild());
    this.rebuild();
  }

  private loadImage(variant: IconVariant): Electron.NativeImage {
    const [one, two] = ICON_VARIANTS[variant];
    const image = nativeImage.createFromPath(assetPath("..", "..", "assets", one ?? "tray.png"));
    if (two !== undefined) {
      const retina = nativeImage.createFromPath(assetPath("..", "..", "assets", two));
      if (!retina.isEmpty()) image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: retina.toBitmap() });
    }
    return image;
  }

  /** Swap the icon to match the worst of the two windows. Cheap no-op when unchanged. */
  update(snapshot: UsageSnapshot): void {
    if (this.tray === null) return;
    const levels = [trafficLevel(snapshot.session, snapshot.rateLimited), trafficLevel(snapshot.weekly, snapshot.rateLimited)];
    const variant: IconVariant =
      snapshot.source === "unknown"
        ? "muted"
        : levels.includes("alert")
          ? "alert"
          : levels.includes("warn")
            ? "warn"
            : "ok";
    if (variant !== this.lastVariant) {
      this.lastVariant = variant;
      this.tray.setImage(this.loadImage(variant));
    }
    this.tray.setToolTip(this.tooltip(snapshot));
    this.rebuild();
  }

  private tooltip(snapshot: UsageSnapshot): string {
    const parts: string[] = ["Claude Usage Widget"];
    if (snapshot.session?.percentUsed != null) parts.push(`5h: ${Math.round(snapshot.session.percentUsed)}%`);
    if (snapshot.weekly?.percentUsed != null) parts.push(`7d: ${Math.round(snapshot.weekly.percentUsed)}%`);
    if (snapshot.source === "unknown") parts.push("no data");
    else if (snapshot.throttled) parts.push("throttled");
    else if (snapshot.stale) parts.push("stale");
    return parts.join(" - ");
  }

  private rebuild(): void {
    if (this.tray === null) return;
    const config = this.store.get();
    const update = this.actions.getUpdate();
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(update === null
          ? []
          : [
              { label: `Update available: v${update.version}`, click: () => this.actions.openUpdate() },
              { type: "separator" as const },
            ]),
        {
          label: "Show widget",
          type: "checkbox",
          checked: config.widgetVisible,
          click: (item) => {
            if (!item.checked) this.windows.hidePanel();
            this.windows.setWidgetVisible(item.checked);
          },
        },
        {
          label: "Click through",
          type: "checkbox",
          checked: config.clickThrough,
          click: (item) => this.windows.setClickThrough(item.checked),
        },
        { type: "separator" },
        { label: "Refresh now", click: () => this.actions.refreshNow() },
        {
          label: "Refresh every",
          submenu: intervalChoices(config.refreshIntervalMinutes).map((minutes) => ({
            label: minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minutes`,
            type: "radio" as const,
            checked: minutes === config.refreshIntervalMinutes,
            click: () => this.actions.setRefreshInterval(minutes),
          })),
        },
        { type: "separator" },
        {
          label: "Launch at login",
          type: "checkbox",
          checked: config.autoLaunch,
          click: (item) => {
            const enabled = item.checked;
            applyLoginItem(enabled);
            this.store.update({ autoLaunch: enabled });
          },
        },
        { type: "separator" },
        { label: "Quit", click: () => this.actions.quit() },
      ]),
    );
  }

  /** Reflect an external change (e.g. the panel toggled click-through) back into the menu. */
  sync(): void {
    this.rebuild();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
