/**
 * The detail panel: exact reset timestamps, account facts, the statusline consent flow, and the
 * controls that change widget behaviour. Everything here is a thin view over `widgetApi`.
 *
 * Loaded with a classic `<script src>` tag rather than as an ES module, because Chromium refuses
 * module scripts over `file://` without `--allow-file-access-from-files`. A classic script must
 * contain no `import`/`export` statement, and tsc appends `export {}` to any external module - so
 * this file has no top-level import/export and wraps its body in an IIFE. That also keeps its
 * declarations out of the global scope, where they would collide with `bar.js`.
 */

(() => {
  const AMBER = 60;

  const RED = 85;

  const el = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`panel: missing element ${id}`);
    return found as T;
  };

  const nodes = {
    plan: el("plan"),
    sessionCard: el("session-card"),
    weeklyCard: el("weekly-card"),
    sessionPct: el("session-pct"),
    sessionFill: el("session-fill"),
    sessionReset: el("session-reset"),
    sessionCountdown: el("session-countdown"),
    weeklyPct: el("weekly-pct"),
    weeklyFill: el("weekly-fill"),
    weeklyReset: el("weekly-reset"),
    weeklyCountdown: el("weekly-countdown"),
    notice: el("notice"),
    noticeText: el("notice-text"),
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
    openSettings: el<HTMLButtonElement>("open-settings"),
    quit: el<HTMLButtonElement>("quit"),
    footer: el("footer"),
    toast: el("toast"),
    close: el<HTMLButtonElement>("close"),
  };

  let latest: WidgetState | null = null;

  let toastTimer: number | null = null;

  function level(percent: number | null, rateLimited: boolean): "ok" | "warn" | "alert" | "unknown" {
    if (percent === null) return "unknown";
    if (rateLimited) return "alert";
    if (percent > RED) return "alert";
    if (percent >= AMBER) return "warn";
    return "ok";
  }

  function countdown(resetsAt: number | null, now: number): string {
    if (resetsAt === null || resetsAt <= 0) return "unknown";
    const remaining = resetsAt - now;
    if (remaining <= 0) return "rolled over - window has reset";
    const minutes = Math.floor(remaining / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
    return `${rest}m`;
  }

  function age(timestamp: number | null, now: number): string {
    if (timestamp === null || timestamp <= 0) return "never";
    const minutes = Math.floor(Math.max(0, now - timestamp) / 60000);
    if (minutes < 1) return `${Math.floor(Math.max(0, now - timestamp) / 1000)}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function stamp(resetsAt: number | null): string {
    if (resetsAt === null || resetsAt <= 0) return "unknown";
    return new Date(resetsAt).toLocaleString();
  }

  function toast(message: string): void {
    nodes.toast.textContent = message;
    nodes.toast.hidden = false;
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      nodes.toast.hidden = true;
    }, 6000);
  }

  function renderWindow(
    card: HTMLElement,
    pct: HTMLElement,
    fill: HTMLElement,
    resetLabel: HTMLElement,
    countdownLabel: HTMLElement,
    win: UsageWindow | null,
    rateLimited: boolean,
    now: number,
  ): void {
    const bucket = level(win?.percentUsed ?? null, rateLimited);
    card.className = `card level-${bucket}`;
    if (win === null || win.percentUsed === null) {
      fill.style.width = "0%";
      pct.textContent = "--";
    } else {
      fill.style.width = `${Math.min(100, Math.max(0, win.percentUsed))}%`;
      pct.textContent = `${Math.round(win.percentUsed)}%`;
    }
    resetLabel.textContent = stamp(win?.resetsAt ?? null);
    countdownLabel.textContent = countdown(win?.resetsAt ?? null, now);
  }

  function render(state: WidgetState): void {
    latest = state;
    const now = Date.now();
    const snapshot = state.snapshot;
    renderWindow(nodes.sessionCard, nodes.sessionPct, nodes.sessionFill, nodes.sessionReset, nodes.sessionCountdown, snapshot.session, snapshot.rateLimited, now);
    renderWindow(nodes.weeklyCard, nodes.weeklyPct, nodes.weeklyFill, nodes.weeklyReset, nodes.weeklyCountdown, snapshot.weekly, snapshot.rateLimited, now);
    nodes.plan.textContent = state.planLabel;
    const blocking = state.auth.status !== "ok";
    const notice = blocking ? state.auth.detail : snapshot.lastError;
    nodes.notice.hidden = notice === null || notice === undefined || notice === "";
    if (notice !== null && notice !== undefined && notice !== "") {
      nodes.notice.className = blocking ? "card error" : "card";
      nodes.noticeText.textContent = notice;
    }
    nodes.account.textContent = state.plan.email ?? state.plan.organizationName ?? "unknown";
    nodes.tier.textContent = tierLabel(state);
    nodes.source.textContent = describeSource(snapshot);
    nodes.updated.textContent = age(snapshot.updatedAt, now);
    nodes.host.textContent = state.auth.tokenHost ?? (state.auth.status === "ok" ? "not refreshed yet" : "unknown");
    nodes.clickThrough.checked = state.settings.clickThrough;
    nodes.autoLaunch.checked = state.settings.autoLaunch;
    nodes.showWidget.checked = state.settings.widgetVisible;
    nodes.interval.textContent = `every ${state.settings.refreshIntervalMinutes}m`;
    nodes.footer.textContent = `v${state.appVersion} - reads and, only when the token rotates, rewrites your Claude Code login.`;
    renderStatusline(state);
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
          : `Registered. Last snapshot ${age(status.lastSnapshotAt, Date.now())}.`;
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
  nodes.openSettings.addEventListener("click", () => window.widgetApi.openSettingsFolder());
  nodes.quit.addEventListener("click", () => window.widgetApi.quit());
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") window.widgetApi.hidePanel();
  });
  void window.widgetApi.getState().then(render);
  window.widgetApi.onState(render);
  setInterval(() => {
    if (latest !== null) render(latest);
  }, 1000);
})();
