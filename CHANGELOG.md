# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-10-01

### Removed

- Hover tooltip on the bar. It only repeated the percentages already shown.

## [1.1.0] - 2026-09-26

### Added

- Refresh interval picker (5, 10, 15, 30 minutes or 1 hour) in the panel and the tray menu. A
  change takes effect immediately instead of after the current wait.

## [1.0.0] - 2026-09-26

First public release.

### Added

- Always-on-top bar showing the 5-hour session and 7-day weekly windows, with live reset countdowns
  and an animated critter whose mood tracks the quota.
- Detail panel with exact reset times, plan, data source, and the per-model weekly limit when the
  account reports one.
- Desktop notifications when a window crosses 85% and 95%, and when a nearly-spent session window
  resets. Can be turned off in the panel.
- Tray icon that turns amber and red with usage, and a tray menu for common actions.
- Optional Claude Code statusline integration as a fallback data source, with exact restore of any
  previous statusline.
- Once-a-day check for new GitHub releases (notify only, can be turned off).
- Diagnostic log in `%APPDATA%\claude-usage-widget\logs`, with tokens masked.
- Windows installer and portable exe.

### Fixed (since the private builds)

- Left-clicking the tray icon and unticking "Show widget" now hide the widget.
- Launch at login and the statusline command work when running from source.
- Claude Code installed through npm (`claude.cmd`) is detected again, so requests carry the right
  `User-Agent` and "Re-check sign-in" can show `claude auth status`.
- A window whose reset time has passed shows as available instead of its old percentage, and the
  widget polls right after a reset.
- The widget refreshes after sleep or unlock and moves back on-screen when a monitor is removed.
- The panel no longer reads `settings.json` every second while open or hidden.
