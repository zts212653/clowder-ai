import { spawn } from 'node:child_process';

/** Keep the OS helper bounded below ManagedRunner's 5s SIGKILL grace period. */
export const TASKKILL_TIMEOUT_MS = 2_000;

export interface TaskkillChildProcess {
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(): boolean;
}

export interface TaskkillSpawnOptions {
  shell: false;
  stdio: 'ignore';
  windowsHide: true;
}

export interface BoundedTimerHandle {
  unref?(): void;
}

export interface ProcessTreeKillEscalation {
  cancel(): void;
}

export interface ProcessTreeKillEscalationDeps {
  scheduleTimeout(callback: () => void, delayMs: number): BoundedTimerHandle;
  cancelTimeout(handle: BoundedTimerHandle): void;
}

export interface WindowsProcessTreeTerminationDeps {
  spawnTaskkill(command: string, args: string[], options: TaskkillSpawnOptions): TaskkillChildProcess;
  scheduleTimeout(callback: () => void, delayMs: number): BoundedTimerHandle;
  cancelTimeout(handle: BoundedTimerHandle): void;
}

export type WindowsProcessTreeTerminationResult =
  | {
      status: 'completed';
      exitCode: 0;
      signal: null;
    }
  | {
      status: 'failed';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }
  | {
      status: 'timed_out';
      exitCode: null;
      signal: null;
      error?: Error;
    };

const DEFAULT_DEPS: WindowsProcessTreeTerminationDeps = {
  spawnTaskkill: (command, args, options) => spawn(command, args, options),
  scheduleTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  cancelTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_ESCALATION_DEPS: ProcessTreeKillEscalationDeps = {
  scheduleTimeout: DEFAULT_DEPS.scheduleTimeout,
  cancelTimeout: DEFAULT_DEPS.cancelTimeout,
};

export function buildTaskkillArgs(pid: number, signal: NodeJS.Signals): string[] {
  const args = ['/PID', String(pid), '/T'];
  if (signal === 'SIGKILL') args.push('/F');
  return args;
}

/**
 * Arm one force-kill fallback for a graceful process-tree termination attempt.
 *
 * A completed Windows `taskkill /T` authoritatively terminated that PID's tree,
 * so retaining a later `/F /T` would risk targeting a reused PID. Failed or
 * timed-out helpers retain the fallback. Unix callers pass `null` and preserve
 * their existing SIGTERM → grace → SIGKILL behavior.
 */
export function armProcessTreeKillEscalation(
  gracefulTermination: Promise<WindowsProcessTreeTerminationResult> | null,
  forceKill: () => void,
  graceMs: number,
  deps: ProcessTreeKillEscalationDeps = DEFAULT_ESCALATION_DEPS,
): ProcessTreeKillEscalation {
  let active = true;
  let timer: BoundedTimerHandle;

  const cancel = (): void => {
    if (!active) return;
    active = false;
    deps.cancelTimeout(timer);
  };

  timer = deps.scheduleTimeout(() => {
    if (!active) return;
    active = false;
    forceKill();
  }, graceMs);

  if (gracefulTermination) {
    void gracefulTermination.then((result) => {
      if (result.status === 'completed') cancel();
    });
  }

  return { cancel };
}

/**
 * Terminate one Windows process tree without blocking the API event loop.
 *
 * This promise never rejects: spawn errors, non-zero exits, and a bounded helper
 * timeout are returned as observable outcomes for ManagedRunner to log.
 */
export function terminateWindowsProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  deps: WindowsProcessTreeTerminationDeps = DEFAULT_DEPS,
): Promise<WindowsProcessTreeTerminationResult> {
  const args = buildTaskkillArgs(pid, signal);
  let child: TaskkillChildProcess;
  try {
    child = deps.spawnTaskkill('taskkill', args, {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (error) {
    return Promise.resolve({
      status: 'failed',
      exitCode: null,
      signal: null,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: BoundedTimerHandle | null = null;

    const finish = (result: WindowsProcessTreeTerminationResult): void => {
      if (settled) return;
      settled = true;
      if (timer) deps.cancelTimeout(timer);
      resolve(result);
    };

    child.once('error', (error) => {
      finish({ status: 'failed', exitCode: null, signal: null, error });
    });
    child.once('close', (exitCode, closeSignal) => {
      if (exitCode === 0) {
        finish({ status: 'completed', exitCode: 0, signal: null });
        return;
      }
      finish({ status: 'failed', exitCode, signal: closeSignal });
    });

    timer = deps.scheduleTimeout(() => {
      let error: Error | undefined;
      try {
        child.kill();
      } catch (cause) {
        error = cause instanceof Error ? cause : new Error(String(cause));
      }
      finish({ status: 'timed_out', exitCode: null, signal: null, ...(error ? { error } : {}) });
    }, TASKKILL_TIMEOUT_MS);
    timer.unref?.();
  });
}
