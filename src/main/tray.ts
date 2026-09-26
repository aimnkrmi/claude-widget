import { Menu, Tray as ElectronTray, app, nativeImage } from "electron";

import { assetPath } from "./paths";
import type { UsageSnapshot } from "../shared/types";
import { trafficLevel } from "./normalize";
import type { Store } from "./store";
import type { WindowManager } from "./window";

/**
 * Tray icon and menu. The icon colour tracks the account state so the widget is readable even
 * when the bar is hidden or click-through is on.
 */

const ICON_VARIANTS = {
  ok: ["tray.png", "tray@2x.png"],
  muted: ["tray-muted.png", "tray-muted@2x.png"],
  alert: ["tray-alert.png", "tray-alert@2x.png"],
} as const;

type IconVariant = keyof typeof ICON_VARIANTS;

export interface TrayActions {
  refreshNow: () => void;
  quit: () => void;
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
      if (bar.isVisible() && !this.store.get().clickThrough) this.windows.hidePanel();
      this.windows.setWidgetVisible(!bar.isVisible() || this.store.get().widgetVisible);
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
    const level = trafficLevel(snapshot.session, snapshot.rateLimited);
    const weekly = trafficLevel(snapshot.weekly, snapshot.rateLimited);
    const variant: IconVariant = snapshot.source === "unknown" ? "muted" : level === "alert" || weekly === "alert" ? "alert" : "ok";
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
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Show widget",
          type: "checkbox",
          checked: config.widgetVisible,
          click: () => this.windows.setWidgetVisible(true),
        },
        {
          label: "Click through",
          type: "checkbox",
          checked: config.clickThrough,
          click: (item) => this.windows.setClickThrough(item.checked),
        },
        { type: "separator" },
        { label: "Refresh now", click: () => this.actions.refreshNow() },
        { type: "separator" },
        {
          label: "Launch at login",
          type: "checkbox",
          checked: config.autoLaunch,
          click: (item) => {
            const enabled = item.checked;
            app.setLoginItemSettings({ openAtLogin: enabled, args: [] });
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
