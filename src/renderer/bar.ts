/**
 * The ambient bar: two windows' worth of quota, a plan badge, and a freshness hint.
 *
 * Loaded with a classic `<script src>` tag rather than as an ES module, because Chromium refuses
 * module scripts over `file://` without `--allow-file-access-from-files`. A classic script must
 * contain no `import`/`export` statement, and tsc appends `export {}` to any external module - so
 * this file has no top-level import/export and wraps its body in an IIFE. That also keeps its
 * declarations out of the global scope, where they would collide with `panel.js`.
 *
 * The countdown ticks locally once a second from the last known `resetsAt`; nothing is polled from
 * the renderer. All data arrives via `widgetApi.onState`.
 */

(() => {
  const fmt = window.cuwFormat;

  interface RowRefs {
    row: HTMLElement;
    fill: HTMLElement;
    pct: HTMLElement;
    reset: HTMLElement;
  }

  /** Look up by id only. A miss here is a bug in the markup, so fail loudly rather than render blanks. */
  function required(id: string): HTMLElement {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`bar: missing element #${id}`);
    return found;
  }

  const rows: Record<"session" | "weekly", RowRefs> = {
    session: {
      row: required("row-session"),
      fill: required("fill-session"),
      pct: required("pct-session"),
      reset: required("reset-session"),
    },
    weekly: {
      row: required("row-weekly"),
      fill: required("fill-weekly"),
      pct: required("pct-weekly"),
      reset: required("reset-weekly"),
    },
  };

  const bar = required("bar");
  const critterCanvas = document.getElementById("critter") as HTMLCanvasElement | null;
  const planBadge = required("plan");
  const ageLabel = required("age");
  const throttleBadge = required("throttle");
  const sourceBadge = required("source");

  const critter = critterCanvas === null ? null : window.cuwCreateCritter(critterCanvas);
  critter?.start();

  let latest: WidgetState | null = null;

  /**
   * Pick the critter's mood from the same percentages the bars show.
   *
   * The worse of the two windows wins, and a rate-limited account always looks exhausted - a
   * cheerful animation next to a 95% bar would just make the number harder to notice. `critical`
   * is the "almost out" band: high enough that the next request may well be refused, low enough
   * that the account is not actually throttled yet.
   */
  function moodFor(state: WidgetState, now: number): CritterMood {
    if (state.snapshot.source === "unknown") return "sleep";
    if (state.snapshot.rateLimited) return "spent";

    const percents = [
      fmt.effectivePercent(state.snapshot.session, now),
      fmt.effectivePercent(state.snapshot.weekly, now),
    ].filter((p): p is number => p !== null);
    if (percents.length === 0) return "sleep";

    const worst = Math.max(...percents);
    if (worst >= fmt.CRITICAL) return "critical";
    if (worst > fmt.RED) return "alert";
    if (worst >= fmt.AMBER) return "warn";
    return "ok";
  }

  /** Bars, percentages, countdowns and mood. Re-run every tick so a reset shows up on time. */
  function paintWindows(state: WidgetState, now: number): void {
    const snapshot = state.snapshot;
    for (const kind of ["session", "weekly"] as const) {
      const refs = rows[kind];
      const win = snapshot[kind];
      const percent = fmt.effectivePercent(win, now);
      refs.row.className = `row level-${fmt.level(percent, snapshot.rateLimited)}`;

      if (percent === null) {
        refs.fill.style.width = "0%";
        refs.fill.classList.add("indeterminate");
        refs.pct.textContent = "--";
      } else {
        refs.fill.classList.remove("indeterminate");
        refs.fill.style.width = `${percent}%`;
        refs.pct.textContent = `${Math.round(percent)}%`;
      }
      refs.reset.textContent = fmt.countdown(win?.resetsAt ?? null, now);
    }
    ageLabel.textContent = snapshot.source === "unknown" ? "no data" : fmt.age(snapshot.updatedAt, now);
    critter?.setMood(moodFor(state, now));
  }

  function render(state: WidgetState): void {
    latest = state;
    const now = Date.now();
    const snapshot = state.snapshot;
    paintWindows(state, now);

    planBadge.textContent = state.planLabel;
    ageLabel.title = snapshot.lastError ?? "";

    throttleBadge.hidden = !snapshot.throttled;
    sourceBadge.hidden = snapshot.source === "oauth" || snapshot.source === "unknown";
    if (!sourceBadge.hidden) sourceBadge.textContent = snapshot.stale ? "stale" : snapshot.source;
    sourceBadge.className = snapshot.stale ? "pill warn" : "pill";

    bar.title =
      snapshot.source === "unknown"
        ? "No usage data yet. Click for details."
        : `5h ${rows.session.pct.textContent} - 7d ${rows.weekly.pct.textContent}\n${snapshot.lastError ?? "Click for details"}`;
  }

  /** Local tick: no IPC, just time-dependent text and the rolled-over state. */
  function tick(): void {
    if (latest === null || document.hidden) return;
    paintWindows(latest, Date.now());
  }

  /* ---------------------------------- interaction -------------------------------------------- */

  /** Pointer travel, in screen pixels, past which a press becomes a drag rather than a click. */
  const DRAG_THRESHOLD = 4;

  let pressOrigin: { x: number; y: number } | null = null;
  let didDrag = false;

  /**
   * Release the press state.
   *
   * Bound to more than just `mouseup` on purpose: if the button is released outside the window, or
   * the widget loses focus mid-drag, the `mouseup` never arrives. Without this the widget would
   * stay in a dragging state and follow the pointer around the screen indefinitely.
   */
  function endPress(): void {
    if (pressOrigin === null) return;
    pressOrigin = null;
    bar.classList.remove("dragging");
    void window.widgetApi.dragEnd();
  }

  bar.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.button !== 0) return;
    pressOrigin = { x: event.screenX, y: event.screenY };
    didDrag = false;
    bar.classList.add("dragging");
    void window.widgetApi.dragStart();
  });

  document.addEventListener("mousemove", (event: MouseEvent) => {
    if (pressOrigin === null) return;
    const travelled = Math.hypot(event.screenX - pressOrigin.x, event.screenY - pressOrigin.y);
    if (!didDrag && travelled < DRAG_THRESHOLD) return;
    didDrag = true;
    void window.widgetApi.dragMove(event.screenX, event.screenY);
  });

  document.addEventListener("mouseup", endPress);
  document.addEventListener("mouseleave", endPress);
  window.addEventListener("blur", endPress);

  bar.addEventListener("click", () => {
    // A click that followed real pointer movement is the tail of a drag, not a request to open the
    // panel. Suppressing on any press/mouseup pair instead would make the panel unopenable.
    if (didDrag) {
      didDrag = false;
      return;
    }
    void window.widgetApi.togglePanel();
  });

  bar.addEventListener("dblclick", () => {
    didDrag = false;
    void window.widgetApi.togglePanel();
  });

  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") void window.widgetApi.hidePanel();
  });

  void window.widgetApi.getState().then(render);
  window.widgetApi.onState(render);
  setInterval(tick, 1000);
})();
