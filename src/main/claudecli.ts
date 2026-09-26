import { execFile } from "node:child_process";

/**
 * Run the locally installed `claude` CLI with fixed arguments. Never throws.
 *
 * Claude Code installs as `claude.exe` (native installer) or as an npm `claude.cmd` shim. Since the
 * CVE-2024-27980 fix, Node refuses to spawn `.cmd`/`.bat` files without a shell (`EINVAL`), so the
 * shim is run with `shell: true`. That is safe here only because every caller passes constant
 * arguments - never interpolate user or network data into `args`.
 */

export interface ClaudeRun {
  /** A `claude` binary was found and started. */
  found: boolean;
  /** Exit code 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface Candidate {
  bin: string;
  shell: boolean;
}

function candidates(): Candidate[] {
  if (process.platform !== "win32") return [{ bin: "claude", shell: false }];
  return [
    { bin: "claude.exe", shell: false },
    { bin: "claude.cmd", shell: true },
  ];
}

/** cmd.exe reports a missing command as a normal exit 1 with this text rather than a spawn error. */
const CMD_NOT_FOUND = /is not recognized as an internal or external command/i;

export function runClaude(args: readonly string[], timeoutMs: number): Promise<ClaudeRun> {
  const list = candidates();
  return new Promise((resolve) => {
    const tryAt = (index: number): void => {
      const candidate = list[index];
      if (candidate === undefined) {
        resolve({ found: false, ok: false, stdout: "", stderr: "" });
        return;
      }
      try {
        // With a shell, Node concatenates arguments anyway and warns (DEP0190) if they are passed
        // separately; the arguments are constants, so build the command line explicitly.
        execFile(
          candidate.shell ? [candidate.bin, ...args].join(" ") : candidate.bin,
          candidate.shell ? [] : [...args],
          { timeout: timeoutMs, windowsHide: true, shell: candidate.shell },
          (error, stdout, stderr) => {
            const out = String(stdout);
            const err = String(stderr);
            // A string `code` (ENOENT, EINVAL, ...) means the process never started.
            const spawnFailed = error !== null && typeof (error as NodeJS.ErrnoException).code === "string";
            if (spawnFailed || CMD_NOT_FOUND.test(err)) {
              tryAt(index + 1);
              return;
            }
            resolve({ found: true, ok: error === null, stdout: out, stderr: err });
          },
        );
      } catch {
        tryAt(index + 1);
      }
    };
    tryAt(0);
  });
}
