/**
 * CLI supervisor wrapper.
 *
 * macOS does not kill child processes when the API parent is SIGKILLed or
 * force-restarted. This wrapper stays between spawnCli and long-running agent
 * CLIs, then terminates the supervised process group if its original parent
 * disappears.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_KILL_GRACE_MS = 3_000;

const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
  SIGKILL: 137,
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isOriginalParentGone(parentPid: number): boolean {
  if (parentPid <= 0) return false;
  if (process.ppid !== parentPid) return true;
  try {
    process.kill(parentPid, 0);
    return false;
  } catch {
    return true;
  }
}

function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) return SIGNAL_EXIT_CODES[signal] ?? 1;
  return 0;
}

async function main(): Promise<void> {
  const sep = process.argv.indexOf('--');
  const command = sep >= 0 ? process.argv[sep + 1] : undefined;
  const args = sep >= 0 ? process.argv.slice(sep + 2) : [];
  if (!command) {
    console.error('[cat-cafe-cli-supervisor] missing command');
    process.exit(64);
  }

  const parentPid = parsePositiveInt(process.env.CAT_CAFE_SUPERVISOR_PARENT_PID, 0);
  const pollMs = parsePositiveInt(process.env.CAT_CAFE_SUPERVISOR_POLL_MS, DEFAULT_POLL_MS);
  const killGraceMs = parsePositiveInt(process.env.CAT_CAFE_SUPERVISOR_KILL_GRACE_MS, DEFAULT_KILL_GRACE_MS);

  const child = spawn(command, args, {
    detached: !IS_WINDOWS,
    // Incident 2026-05-29 P1 (cloud codex review): stdin must be 'pipe' so the
    // supervisor can forward its own stdin (the prompt written by spawnCli) to the
    // supervised child. Previously 'ignore' → stdin-backed prompts (codex `-- -`)
    // reached the supervisor but never the real CLI → empty prompt in production.
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Forward supervisor stdin → child stdin (prompt delivery). When spawnCli did not
  // provide stdinInput, the supervisor's own stdin is /dev/null → child sees EOF
  // (harmless for argv-prompt CLIs like Claude/Gemini). EPIPE guard: child may exit
  // before consuming all input.
  if (child.stdin) {
    child.stdin.on('error', () => {});
    process.stdin.pipe(child.stdin);
  }
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

  let childExited = false;
  let terminating = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let parentTimer: ReturnType<typeof setInterval> | undefined;

  const clearTimers = (): void => {
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (parentTimer !== undefined) clearInterval(parentTimer);
  };

  const signalChild = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      if (!IS_WINDOWS) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The child is already gone.
      }
    }
  };

  const terminateChild = (): void => {
    if (terminating || childExited) return;
    terminating = true;
    signalChild('SIGTERM');
    killTimer = setTimeout(() => signalChild('SIGKILL'), killGraceMs);
    killTimer.unref();
  };

  child.once('error', (err) => {
    clearTimers();
    console.error(`[cat-cafe-cli-supervisor] spawn failed: ${err.message}`);
    process.exit((err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1);
  });

  child.once('exit', (code, signal) => {
    childExited = true;
    clearTimers();
    process.exit(childExitCode(code, signal));
  });

  parentTimer = setInterval(() => {
    if (isOriginalParentGone(parentPid)) terminateChild();
  }, pollMs);
  parentTimer.unref();

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => terminateChild());
  }

  process.once('exit', () => {
    if (!childExited) signalChild('SIGKILL');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
