/**
 * The detail panel: exact reset timestamps, account facts, the statusline consent flow, and the
 * controls that change widget behaviour. Everything here is a thin view over `widgetApi`.
 *
 * Loaded with a classic `<script src>` tag rather than as an ES module, because Chromium refuses
 * module scripts over `file://` without `--allow-file-access-from-files`. A classic script must
 * contain no `import`/`export` statement, and tsc appends `export {}` to any external module - so
 * this file has no top-level import/export and wraps its body in an IIFE. That also keeps its
 * declarations out of the global scope, where they would collide with `bar.js`.
 *
 * The panel window is hidden, not destroyed, when closed. So the once-a-second tick only touches
 * time-dependent text, does nothing while hidden, and never calls into the main process; the
 * statusline status (which reads files in main) is fetched only on real state changes and on show.
 */

(() => {
  const fmt = window.cuwFormat;

  const el = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`panel: missing element ${id}`);
    return found as T;
  };

  interface WindowCard {
    card: HTMLElement;
    pct: HTMLElement;
    fill: HTMLElement;
    reset: HTMLElement;
    countdown: HTMLElement;
  }

  const card = (prefix: string): WindowCard => ({
    card: el(`${prefix}-card`),
    pct: el(`${prefix}-pct`),
    fill: el(`${prefix}-fill`),
    reset: el(`${prefix}-reset`),
    countdown: el(`${prefix}-countdown`),
  });

  const cards = {
    session: card("session"),
    weekly: card("weekly"),
    weeklyScoped: card("scoped"),
  };

  const nodes = {
    plan: el("plan"),
    notice: el("notice"),
    noticeText: el("notice-text"),
    update: el("update"),
    updateText: el("update-text"),
    updateOpen: el<HTMLButtonElement>("update-open"),
    account: el("account"),
    tier: el("tier"),
    source: el("source"),
    updated: el("updated"),
    host: el("host"),
    statuslineSummary: el("statusline-summary"),
    statuslineCommand: el("statusline-command"),
    statuslineToggle: el<HTMLButtonElement>("statusline-toggle"),
    refresh: el<HTMLButtonElement>("refresh"),
    recheck: el<HTMLButtonElement>("recheck"),
    interval: el("interval"),
    clickThrough: el<HTMLInputElement>("click-through"),
    autoLaunch: el<HTMLInputElement>("auto-launch"),
    showWidget: el<HTMLInputElement>("show-widget"),
    notifications: el<HTMLInputElement>("notifications"),
    checkUpdates: el<HTMLInputElement>("check-updates"),
    openSettings: el<HTMLButtonElement>("open-settings"),
    openLogs: el<HTMLButtonElement>("open-logs"),
    quit: el<HTMLButtonElement>("quit"),
    footer: el("footer"),
    toast: el("toast"),
    close: el<HTMLButtonElement>("close"),
  };

  let latest: WidgetState | null = null;

  let toastTimer: number | null = null;

  function toast(message: string): void {
    nodes.toast.textContent = message;
    nodes.toast.hidden = false;
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      nodes.toast.hidden = true;
    }, 6000);
  }

  function paintCard(refs: WindowCard, win: UsageWindow | null, rateLimited: boolean, now: number): void {
    const percent = fmt.effectivePercent(win, now);
    refs.card.className = `card level-${fmt.level(percent, rateLimited)}`;
    refs.fill.style.width = percent === null ? "0%" : `${percent}%`;
    refs.pct.textContent = percent === null ? "--" : `${Math.round(percent)}%`;
    refs.reset.textContent = fmt.stamp(win?.resetsAt ?? null);
    refs.countdown.textContent = fmt.countdown(win?.resetsAt ?? null, now, "long");
  }

  /** Everything that changes with the clock alone. Cheap, and no IPC. */
  function paintTime(state: WidgetState, now: number): void {
    const snapshot = state.snapshot;
    paintCard(cards.session, snapshot.session, snapshot.rateLimited, now);
    paintCard(cards.weekly, snapshot.weekly, snapshot.rateLimited, now);
    cards.weeklyScoped.card.hidden = snapshot.weeklyScoped === null;
    if (snapshot.weeklyScoped !== null) paintCard(cards.weeklyScoped, snapshot.weeklyScoped, snapshot.rateLimited, now);
    nodes.updated.textContent = fmt.age(snapshot.updatedAt, now, "long");
  }

  function render(state: WidgetState): void {
    latest = state;
    const snapshot = state.snapshot;
    paintTime(state, Date.now());
    nodes.plan.textContent = state.planLabel;
    const blocking = state.auth.status !== "ok";
    const notice = blocking ? state.auth.detail : snapshot.lastError;
    nodes.notice.hidden = notice === null || notice === undefined || notice === "";
    if (notice !== null && notice !== undefined && notice !== "") {
      nodes.notice.className = blocking ? "card error" : "card";
      nodes.noticeText.textContent = notice;
    }
    nodes.update.hidden = state.update === null;
    if (state.update !== null) nodes.updateText.textContent = `Version ${state.update.version} is available (you have ${state.appVersion}).`;
    nodes.account.textContent = state.plan.email ?? state.plan.organizationName ?? "unknown";
    nodes.tier.textContent = tierLabel(state);
    nodes.source.textContent = describeSource(snapshot);
    nodes.host.textContent = state.auth.tokenHost ?? (state.auth.status === "ok" ? "not refreshed yet" : "unknown");
    nodes.clickThrough.checked = state.settings.clickThrough;
    nodes.autoLaunch.checked = state.settings.autoLaunch;
    nodes.showWidget.checked = state.settings.widgetVisible;
    nodes.notifications.checked = state.settings.notifications;
    nodes.checkUpdates.checked = state.settings.checkForUpdates;
    nodes.interval.textContent = `every ${state.settings.refreshIntervalMinutes}m`;
    nodes.footer.textContent = `v${state.appVersion} - unofficial. Reads and, only when the token rotates, rewrites your Claude Code login.`;
    if (!document.hidden) void renderStatusline(state);
  }

  /**
   * The tier id from the profile endpoint is an internal name (`default_claude_ai`), so map the
   * common ones to something readable and fall back to the raw value only when unrecognised.
   */
  function tierLabel(state: WidgetState): string {
    if (state.plan.hasClaudeMax === true) return "Max";
    const tier = state.plan.tier;
    if (tier === null) return state.plan.subscription ?? "unknown";
    if (tier.startsWith("default_claude_ai")) return state.plan.subscription ?? "Claude";
    return tier.replace(/^claude_?/i, "").replace(/_/g, " ");
  }

  function describeSource(snapshot: WidgetState["snapshot"]): string {
    const base =
      snapshot.source === "oauth"
        ? "live OAuth API"
        : snapshot.source === "oauth-cached"
          ? "cached OAuth (last fetch failed)"
          : snapshot.source === "statusline"
            ? "Claude Code statusline"
            : "none";
    const flags = [snapshot.throttled ? "throttled" : null, snapshot.stale ? "stale" : null].filter(Boolean);
    return flags.length === 0 ? base : `${base} - ${flags.join(", ")}`;
  }

  async function renderStatusline(state: WidgetState): Promise<void> {
    let status: StatuslineStatus;
    try {
      status = await window.widgetApi.getStatusline();
    } catch {
      return;
    }
    if (latest !== state) return;
    const ours = status.command !== null && status.command.includes("statusline");
    if (status.registered) {
      nodes.statuslineSummary.textContent =
        status.lastSnapshotAt === null
          ? "Registered. No snapshot captured yet - start a new Claude Code session."
          : `Registered. Last snapshot ${fmt.age(status.lastSnapshotAt, Date.now(), "long")}.`;
    } else if (status.command !== null && !ours) {
      nodes.statuslineSummary.textContent = "Not registered. Claude Code currently uses a different statusline.";
    } else {
      nodes.statuslineSummary.textContent =
        "Not registered. Registering lets the widget use Claude Code's own quota numbers as a fallback.";
    }
    nodes.statuslineCommand.textContent =
      status.command === null
        ? `No statusLine key in ${status.settingsPath}`
        : `settings.json: ${status.settingsPath}\ncurrent: ${status.command}`;
    // Overwriting someone else's statusline is destructive, so the button is never a one-click
    // change: the click handler routes it through an explicit confirmation instead.
    nodes.statuslineToggle.textContent = status.registered
      ? "Unregister"
      : status.command !== null && !ours
        ? "Replace statusline"
        : "Register";
    nodes.statuslineToggle.dataset["conflict"] = !status.registered && status.command !== null && !ours ? "true" : "";
  }
  /* ---------------------------------- interaction ---------------------------------------------- */
  nodes.close.addEventListener("click", () => window.widgetApi.hidePanel());
  nodes.refresh.addEventListener("click", async () => {
    nodes.refresh.disabled = true;
    try {
      const state = await window.widgetApi.refresh();
      render(state);
      toast("Refresh requested. The usage endpoint allows one call per few minutes.");
    } finally {
      nodes.refresh.disabled = false;
    }
  });
  nodes.recheck.addEventListener("click", async () => {
    nodes.recheck.disabled = true;
    try {
      const result = await window.widgetApi.resetAuth();
      render(result.state);
      toast(
        result.cliAvailable && result.cliOutput !== ""
          ? `claude auth status: ${result.cliOutput.split(/\r?\n/)[0] ?? ""}`
          : "Re-checked the stored login.",
      );
    } finally {
      nodes.recheck.disabled = false;
    }
  });
  nodes.statuslineToggle.addEventListener("click", async () => {
    nodes.statuslineToggle.disabled = true;
    try {
      if (latest?.settings.statuslineRegistered === true) {
        const result = await window.widgetApi.unregisterStatusline();
        render(result.state);
        toast(result.message);
        return;
      }
      const status = await window.widgetApi.getStatusline();
      if (status.command !== null && !status.command.includes("statusline")) {
        const agreed = window.confirm(
          `Claude Code already uses this statusline:\n\n  ${status.command}\n\nReplacing it will break the existing one. ` +
            `The widget stores the previous value, so Unregister restores it exactly.\n\nContinue?`,
        );
        if (!agreed) return;
      }
      const result = await window.widgetApi.registerStatusline();
      render(result.state);
      toast(result.message);
    } finally {
      nodes.statuslineToggle.disabled = false;
    }
  });
  nodes.clickThrough.addEventListener("change", (event) => {
    void window.widgetApi.setClickThrough((event.target as HTMLInputElement).checked);
  });
  nodes.autoLaunch.addEventListener("change", (event) => {
    void window.widgetApi.setAutoLaunch((event.target as HTMLInputElement).checked);
  });
  nodes.showWidget.addEventListener("change", (event) => {
    void window.widgetApi.setWidgetVisible((event.target as HTMLInputElement).checked);
  });
  nodes.notifications.addEventListener("change", (event) => {
    void window.widgetApi.setNotifications((event.target as HTMLInputElement).checked);
  });
  nodes.checkUpdates.addEventListener("change", (event) => {
    void window.widgetApi.setCheckForUpdates((event.target as HTMLInputElement).checked);
  });
  nodes.updateOpen.addEventListener("click", () => window.widgetApi.openUpdatePage());
  nodes.openSettings.addEventListener("click", () => window.widgetApi.openSettingsFolder());
  nodes.openLogs.addEventListener("click", () => window.widgetApi.openLogFolder());
  nodes.quit.addEventListener("click", () => window.widgetApi.quit());
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") window.widgetApi.hidePanel();
  });
  // The statusline may have been changed by hand while the panel was hidden.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && latest !== null) render(latest);
  });
  void window.widgetApi.getState().then(render);
  window.widgetApi.onState(render);
  setInterval(() => {
    if (latest !== null && !document.hidden) paintTime(latest, Date.now());
  }, 1000);
})();
