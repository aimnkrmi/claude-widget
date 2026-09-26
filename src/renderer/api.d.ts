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
