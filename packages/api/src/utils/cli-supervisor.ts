/**
 * Unix CLI lifecycle supervisor.
 *
 * The supervisor is a live signal owner, while its atomic owner manifest is the
 * crash-recovery owner. Provider descendants inherit a random token so fork,
 * exec, reparenting, and independent process groups do not depend on polling.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CLI_PROCESS_OWNER_ENV,
  CLI_SUPERVISOR_SOCKET_DIR_ENV,
  type CliProcessOwnerHandle,
  cliExecutionOwnerRefFromEnvironment,
  completeCliProcessOwnerCleanup,
  createCliProcessOwnerManifest,
  findOwnedUnixProcesses,
  readUnixProcessSnapshotSync,
  recordCliProcessOwnerRoot,
  signalOwnedUnixProcesses,
  type UnixProcessIdentity,
  type UnixProcessSnapshotEntry,
} from './cli-process-ownership.js';

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

interface OwnedSnapshot {
  snapshot: Map<number, UnixProcessSnapshotEntry>;
  targets: UnixProcessIdentity[];
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
  let owner: CliProcessOwnerHandle | undefined;
  if (!IS_WINDOWS) {
    try {
      owner = createCliProcessOwnerManifest({
        dataDir: process.env.CAT_CAFE_DATA_DIR,
        socketDirectory: process.env[CLI_SUPERVISOR_SOCKET_DIR_ENV],
        execution: cliExecutionOwnerRefFromEnvironment(process.env),
      });
    } catch (error) {
      console.error(`[cat-cafe-cli-supervisor] owner manifest failed: ${String(error)}`);
      process.exit(1);
    }
  }

  let child: ChildProcessWithoutNullStreams | undefined;
  let childExited = false;
  let terminating = false;
  let ownerCompleted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let parentTimer: ReturnType<typeof setInterval> | undefined;
  let treePollTimer: ReturnType<typeof setTimeout> | undefined;
  let hardExitTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  const clearTimers = (): void => {
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (parentTimer !== undefined) clearInterval(parentTimer);
    if (treePollTimer !== undefined) clearTimeout(treePollTimer);
    if (hardExitTimer !== undefined) clearTimeout(hardExitTimer);
  };

  const readOwnedSnapshot = (): OwnedSnapshot | null => {
    if (!owner) return null;
    const snapshot = readUnixProcessSnapshotSync({ includeEnvironment: true });
    if (!snapshot) return null;
    return { snapshot, targets: findOwnedUnixProcesses(snapshot, owner.manifest.ownerId) };
  };

  const completeOwnerIfEmpty = (state?: OwnedSnapshot | null): boolean => {
    if (!owner || ownerCompleted) return true;
    const current = state ?? readOwnedSnapshot();
    if (!current || current.targets.length > 0) return false;
    try {
      completeCliProcessOwnerCleanup(owner);
      ownerCompleted = true;
      return true;
    } catch (error) {
      console.error(`[cat-cafe-cli-supervisor] owner cleanup failed: ${String(error)}`);
      return false;
    }
  };

  const signalDirectChild = (signal: NodeJS.Signals): void => {
    if (!child) return;
    try {
      if (!IS_WINDOWS && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The child is already gone.
      }
    }
  };

  const signalUnixOwner = (signal: NodeJS.Signals): boolean => {
    const state = readOwnedSnapshot();
    if (!state || state.targets.length === 0) return false;
    return signalOwnedUnixProcesses(state.targets, state.snapshot, signal) > 0;
  };

  const signalChild = (signal: NodeJS.Signals): void => {
    if (child?.pid === undefined) return;
    if (!IS_WINDOWS && owner && signalUnixOwner(signal)) return;
    if (!childExited) signalDirectChild(signal);
  };

  const exitWithChildStatus = (): void => {
    const exit = pendingExit ?? { code: child?.exitCode ?? null, signal: child?.signalCode ?? null };
    completeOwnerIfEmpty();
    clearTimers();
    process.exit(childExitCode(exit.code, exit.signal));
  };

  const waitForOwnedTree = (): void => {
    if (!childExited || !terminating || treePollTimer !== undefined) return;
    const state = readOwnedSnapshot();
    if (state?.targets.length === 0) {
      completeOwnerIfEmpty(state);
      exitWithChildStatus();
      return;
    }
    treePollTimer = setTimeout(() => {
      treePollTimer = undefined;
      waitForOwnedTree();
    }, 50);
  };

  const armKillEscalation = (): void => {
    if (killTimer !== undefined) return;
    killTimer = setTimeout(() => {
      signalChild('SIGKILL');
      if (childExited) {
        hardExitTimer = setTimeout(exitWithChildStatus, 500);
        waitForOwnedTree();
      }
    }, killGraceMs);
    if (childExited) killTimer.ref();
    else killTimer.unref();
  };

  const terminateChild = (): void => {
    if (terminating || childExited) return;
    terminating = true;
    signalChild('SIGTERM');
    armKillEscalation();
  };

  // SIGINT remains a cooperative provider cancellation. A later SIGTERM can
  // still enter the bounded TERM→KILL cleanup state.
  const interruptChild = (): void => {
    if (!childExited) signalChild('SIGINT');
  };

  process.once('SIGINT', interruptChild);
  process.once('SIGTERM', terminateChild);
  process.once('SIGHUP', terminateChild);
  process.once('exit', () => {
    if (!childExited) signalChild('SIGKILL');
  });

  const childEnv = { ...process.env };
  if (owner) childEnv[CLI_PROCESS_OWNER_ENV] = owner.manifest.ownerId;
  delete childEnv[CLI_SUPERVISOR_SOCKET_DIR_ENV];
  child = spawn(command, args, {
    detached: !IS_WINDOWS,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });

  child.stdin.on('error', () => {});
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.once('spawn', () => {
    if (!owner || child?.pid === undefined) return;
    try {
      recordCliProcessOwnerRoot(owner, child.pid);
    } catch (error) {
      console.error(`[cat-cafe-cli-supervisor] root identity update failed: ${String(error)}`);
    }
  });

  child.once('error', (error) => {
    childExited = true;
    pendingExit = { code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1, signal: null };
    completeOwnerIfEmpty();
    clearTimers();
    console.error(`[cat-cafe-cli-supervisor] spawn failed: ${error.message}`);
    process.exit(pendingExit.code ?? 1);
  });

  child.once('exit', (code, signal) => {
    childExited = true;
    pendingExit = { code, signal };
    if (parentTimer !== undefined) clearInterval(parentTimer);

    const state = readOwnedSnapshot();
    if (!terminating && state?.targets.length === 0) {
      completeOwnerIfEmpty(state);
      exitWithChildStatus();
      return;
    }
    if (!terminating) {
      terminating = true;
      signalChild('SIGTERM');
      armKillEscalation();
    }
    killTimer?.ref();
    waitForOwnedTree();
  });

  // The only steady-state poll is the cheap original-parent liveness check.
  // Ownership discovery is event-driven at interrupt/terminate/exit/recovery.
  parentTimer = setInterval(() => {
    if (isOriginalParentGone(parentPid)) terminateChild();
  }, pollMs);
  parentTimer.unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
