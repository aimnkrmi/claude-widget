import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A small append-only diagnostic log in `<userData>/logs/main.log`, so a bug report can include
 * what happened without the user running from a terminal.
 *
 * Only messages are logged - never request headers, response bodies or credential contents - and
 * anything shaped like an Anthropic token is masked as a second line of defence. The file is capped
 * at `MAX_BYTES` and rotated once to `main.old.log`.
 */

const MAX_BYTES = 1024 * 1024;

const TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

export function redact(text: string): string {
  return text.replace(TOKEN_PATTERN, "sk-ant-***");
}

export type LogLevel = "info" | "warn" | "error";

export class Logger {
  readonly dir: string;
  private readonly file: string;

  constructor(userData: string) {
    this.dir = join(userData, "logs");
    this.file = join(this.dir, "main.log");
  }

  write(level: LogLevel, message: string): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      this.rotateIfLarge();
      appendFileSync(this.file, `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}\n`, "utf8");
    } catch {
      // Logging must never be the thing that breaks the widget.
    }
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : error === undefined ? "" : String(error);
    this.write("error", detail === "" ? message : `${message}: ${detail}`);
  }

  private rotateIfLarge(): void {
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size < MAX_BYTES) return;
    const old = join(this.dir, "main.old.log");
    rmSync(old, { force: true });
    renameSync(this.file, old);
  }
}

/**
 * Log instead of crashing. A tray widget that dies silently is worse than one that keeps showing the
 * last good numbers, and the log tells us what went wrong.
 */
export function installCrashHandlers(logger: Logger): void {
  process.on("uncaughtException", (error) => logger.error("uncaught exception", error));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", reason));
}
