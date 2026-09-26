type WidgetState = import("../shared/types").WidgetState;
type UsageWindow = import("../shared/types").UsageWindow;
type StatuslineStatus = import("../shared/types").StatuslineStatus;

interface StatuslineStatusAction {
  ok: boolean;
  message: string;
  status: StatuslineStatus;
  state: WidgetState;
}

interface WidgetApi {
  getState: () => Promise<WidgetState>;
  onState: (callback: (state: WidgetState) => void) => () => void;

  refresh: () => Promise<WidgetState>;
  resetAuth: () => Promise<{ state: WidgetState; cliOutput: string; cliAvailable: boolean }>;

  dragStart: () => void;
  dragMove: (x: number, y: number) => void;
  dragEnd: () => void;

  togglePanel: () => void;
  hidePanel: () => void;

  setClickThrough: (enabled: boolean) => Promise<WidgetState>;
  setWidgetVisible: (visible: boolean) => Promise<WidgetState>;
  setAutoLaunch: (enabled: boolean) => Promise<WidgetState>;
  setRefreshInterval: (minutes: number) => Promise<WidgetState>;

  getStatusline: () => Promise<StatuslineStatus>;
  registerStatusline: () => Promise<StatuslineStatusAction>;
  unregisterStatusline: () => Promise<StatuslineStatusAction>;

  setNotifications: (enabled: boolean) => Promise<WidgetState>;
  setCheckForUpdates: (enabled: boolean) => Promise<WidgetState>;
  openUpdatePage: () => void;
  openLogFolder: () => void;

  openSettingsFolder: () => void;
  quit: () => void;
}

interface Window {
  widgetApi: WidgetApi;
}

/** Moods the bar critter can be in, driven by the same traffic level as the bars. */
type CritterMood = "ok" | "warn" | "alert" | "critical" | "spent" | "sleep";

interface Critter {
  setMood: (mood: CritterMood) => void;
  start: () => void;
  stop: () => void;
}

interface Window {
  /** Defined by `creature.js`, which loads before `bar.js`. */
  cuwCreateCritter: (canvas: HTMLCanvasElement) => Critter;
}

type TrafficLevel = "ok" | "warn" | "alert" | "unknown";
type FormatStyle = "compact" | "long";

interface CuwFormat {
  AMBER: number;
  RED: number;
  CRITICAL: number;
  isResetDue: (resetsAt: number | null, now: number) => boolean;
  effectivePercent: (win: UsageWindow | null, now: number) => number | null;
  level: (percent: number | null, rateLimited: boolean) => TrafficLevel;
  countdown: (resetsAt: number | null, now: number, style?: FormatStyle) => string;
  age: (timestamp: number | null, now: number, style?: FormatStyle) => string;
  stamp: (resetsAt: number | null) => string;
}

interface Window {
  /** Defined by `format.js`, which loads before `bar.js` and `panel.js`. */
  cuwFormat: CuwFormat;
}
