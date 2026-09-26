import { Notification } from "electron";

import type { UsageSnapshot, UsageWindow } from "../shared/types";
import { isResetDue } from "./normalize";
import type { Store } from "./store";

/**
 * Desktop notifications for the moments worth interrupting someone for: a window crossing 85% and
 * 95%, and the 5-hour window coming back after it had run high.
 *
 * The decision is a pure function over (previous state, snapshot) so it is unit-testable; the class
 * only owns the Electron side. Each threshold fires once and re-arms only after usage has dropped
 * clearly below it, so a value hovering around 85% never produces a stream of toasts.
 */

const HIGH = 85;
const CRITICAL = 95;
/** Re-arm a threshold only once usage falls this far below it. */
const HYSTERESIS = 5;
/** The session counts as "back" once it is below this after having been high. */
const RECOVERED = 50;

interface WindowAlertState {
  armedHigh: boolean;
  armedCritical: boolean;
}

export interface AlertState {
  session: WindowAlertState;
  weekly: WindowAlertState;
  /** The session window reached `HIGH` and has not reset since. */
  sessionWasHigh: boolean;
}

export interface Alert {
  title: string;
  body: string;
}

export function initialAlertState(): AlertState {
  return {
    session: { armedHigh: true, armedCritical: true },
    weekly: { armedHigh: true, armedCritical: true },
    sessionWasHigh: false,
  };
}

const LABELS = { session: "5-hour session", weekly: "7-day weekly" } as const;

/** Displayed percent, treating a window whose reset time has passed as empty. */
function percentOf(win: UsageWindow | null, now: number): number | null {
  if (win === null || win.percentUsed === null) return null;
  return isResetDue(win.resetsAt, now) ? 0 : win.percentUsed;
}

function resetHint(win: UsageWindow | null): string {
  if (win === null || win.resetsAt === null) return "";
  const at = new Date(win.resetsAt);
  return ` Resets ${at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}.`;
}

export function evaluateAlerts(
  previous: AlertState,
  snapshot: UsageSnapshot,
  now: number,
): { state: AlertState; alerts: Alert[] } {
  const state: AlertState = {
    session: { ...previous.session },
    weekly: { ...previous.weekly },
    sessionWasHigh: previous.sessionWasHigh,
  };
  const alerts: Alert[] = [];
  if (snapshot.source === "unknown") return { state, alerts };

  for (const kind of ["session", "weekly"] as const) {
    const win = snapshot[kind];
    const percent = percentOf(win, now);
    if (percent === null) continue;
    const slot = state[kind];

    if (percent >= CRITICAL && slot.armedCritical) {
      slot.armedCritical = false;
      slot.armedHigh = false;
      alerts.push({
        title: `Claude ${LABELS[kind]} window at ${Math.round(percent)}%`,
        body: `You are almost out; the next requests may be refused.${resetHint(win)}`,
      });
    } else if (percent >= HIGH && slot.armedHigh) {
      slot.armedHigh = false;
      alerts.push({
        title: `Claude ${LABELS[kind]} window at ${Math.round(percent)}%`,
        body: `Usage is getting high.${resetHint(win)}`,
      });
    }

    if (percent < HIGH - HYSTERESIS) slot.armedHigh = true;
    if (percent < CRITICAL - HYSTERESIS) slot.armedCritical = true;

    if (kind === "session") {
      if (percent >= HIGH) {
        state.sessionWasHigh = true;
      } else if (state.sessionWasHigh && percent < RECOVERED) {
        state.sessionWasHigh = false;
        alerts.push({ title: "Claude session window has reset", body: "Your 5-hour quota is available again." });
      }
    }
  }

  return { state, alerts };
}

export class Notifier {
  private state: AlertState = initialAlertState();

  constructor(
    private readonly store: Store,
    private readonly onClick: () => void,
  ) {}

  /**
   * Feed every published snapshot through here. State advances even while notifications are
   * disabled, so switching them on does not immediately replay old crossings.
   */
  update(snapshot: UsageSnapshot): void {
    const { state, alerts } = evaluateAlerts(this.state, snapshot, Date.now());
    this.state = state;
    if (!this.store.get().notifications || !Notification.isSupported()) return;
    for (const alert of alerts) {
      const toast = new Notification({ title: alert.title, body: alert.body, silent: false });
      toast.on("click", this.onClick);
      toast.show();
    }
  }
}
