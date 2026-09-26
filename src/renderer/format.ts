/**
 * Thresholds and display formatting shared by the bar and the panel.
 *
 * A classic script like `creature.ts` (see the note in `bar.ts`): no top-level import/export, body in
 * an IIFE, and the result published as `window.cuwFormat`. It must load before `bar.js`/`panel.js`.
 * Every function is pure so `test/format.test.ts` can run this file in a `vm` sandbox.
 */

(() => {
  /** At or above this the window is amber. */
  const AMBER = 60;
  /** Above this the window is red. Matches `RED_THRESHOLD` in `src/main/normalize.ts`. */
  const RED = 85;
  /** At or above this the critter panics: the limit is in sight, not yet reached. */
  const CRITICAL = 95;

  /** A `resetsAt` in the past means the window has already rolled over. */
  function isResetDue(resetsAt: number | null, now: number): boolean {
    return resetsAt !== null && resetsAt > 0 && resetsAt <= now;
  }

  /**
   * The percentage to display. A window whose reset time has passed is shown as fully available
   * (0%) until the next poll confirms the new value, rather than as its stale pre-reset number.
   */
  function effectivePercent(win: UsageWindow | null, now: number): number | null {
    if (win === null || win.percentUsed === null) return null;
    if (isResetDue(win.resetsAt, now)) return 0;
    return Math.min(100, Math.max(0, win.percentUsed));
  }

  function level(percent: number | null, rateLimited: boolean): TrafficLevel {
    if (percent === null) return "unknown";
    if (rateLimited) return "alert";
    if (percent > RED) return "alert";
    if (percent >= AMBER) return "warn";
    return "ok";
  }

  /** `compact` is the bar (`3h45m`, `reset`); `long` is the panel (`3h 45m`, `rolled over`). */
  function countdown(resetsAt: number | null, now: number, style: FormatStyle = "compact"): string {
    if (resetsAt === null || resetsAt <= 0) return style === "compact" ? "--" : "unknown";
    const remaining = resetsAt - now;
    if (remaining <= 0) return style === "compact" ? "reset" : "rolled over - window has reset";
    const minutes = Math.floor(remaining / 60_000);
    if (minutes < 1) return "<1m";
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    const gap = style === "compact" ? "" : " ";
    if (days > 0) return `${days}d${gap}${hours}h`;
    if (hours > 0) return rest > 0 ? `${hours}h${gap}${rest}m` : `${hours}h`;
    return `${minutes}m`;
  }

  /** Relative age: `just now` / `12s ago`, `4m ago`, `2h ago`, `3d ago`. */
  function age(timestamp: number | null, now: number, style: FormatStyle = "compact"): string {
    if (timestamp === null || timestamp <= 0) return style === "compact" ? "no data" : "never";
    const delta = Math.max(0, now - timestamp);
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 1) return style === "compact" ? "just now" : `${Math.floor(delta / 1000)}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  /** Absolute local timestamp for the panel. */
  function stamp(resetsAt: number | null): string {
    if (resetsAt === null || resetsAt <= 0) return "unknown";
    return new Date(resetsAt).toLocaleString();
  }

  window.cuwFormat = { AMBER, RED, CRITICAL, isResetDue, effectivePercent, level, countdown, age, stamp };
})();
