export interface ProcessTerminationOptions {
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  shutdownGraceMs?: number;
  shutdownKillGraceMs?: number;
  shutdownPollMs?: number;
}

export type ProcessTerminationResult =
  | { ok: true; pid: number; escalated: boolean; initiallyAbsent: boolean }
  | { ok: false; pid: number; escalated: boolean; initiallyAbsent: false; error: unknown };

const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const DEFAULT_SHUTDOWN_KILL_GRACE_MS = 1_000;
const DEFAULT_SHUTDOWN_POLL_MS = 50;

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return false;
    if (hasErrorCode(error, 'EPERM')) return true;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(input: {
  pid: number;
  timeoutMs: number;
  pollMs: number;
  isAlive: (pid: number) => boolean | Promise<boolean>;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  while (await input.isAlive(input.pid)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await sleep(Math.min(input.pollMs, remainingMs));
  }
  return true;
}

function sendSignal(
  pid: number,
  signal: NodeJS.Signals,
  killPid: (pid: number, signal: NodeJS.Signals) => void,
): { sent: true } | { sent: false; absent: boolean; error: unknown } {
  try {
    killPid(pid, signal);
    return { sent: true };
  } catch (error) {
    return { sent: false, absent: hasErrorCode(error, 'ESRCH'), error };
  }
}

function classifySignalResult(
  result: ReturnType<typeof sendSignal>,
  pid: number,
  escalated: boolean,
  initiallyAbsent: boolean,
): ProcessTerminationResult | null {
  if (result.sent) return null;
  if (result.absent) return { ok: true, pid, escalated, initiallyAbsent };
  return { ok: false, pid, escalated, initiallyAbsent: false, error: result.error };
}

async function observeProcessExit(input: {
  pid: number;
  timeoutMs: number;
  pollMs: number;
  isAlive: (pid: number) => boolean | Promise<boolean>;
}): Promise<{ exited: boolean; error?: unknown }> {
  try {
    return { exited: await waitForProcessExit(input) };
  } catch (error) {
    return { exited: false, error };
  }
}

export function createProcessTerminator(
  options: ProcessTerminationOptions = {},
): (pid: number) => Promise<ProcessTerminationResult> {
  const killPid = options.killPid ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
  const shutdownKillGraceMs = Math.max(0, options.shutdownKillGraceMs ?? DEFAULT_SHUTDOWN_KILL_GRACE_MS);
  const shutdownPollMs = Math.max(1, options.shutdownPollMs ?? DEFAULT_SHUTDOWN_POLL_MS);

  return async (pid: number): Promise<ProcessTerminationResult> => {
    const term = sendSignal(pid, 'SIGTERM', killPid);
    const termResult = classifySignalResult(term, pid, false, true);
    if (termResult) return termResult;

    const termExit = await observeProcessExit({
      pid,
      timeoutMs: shutdownGraceMs,
      pollMs: shutdownPollMs,
      isAlive,
    });
    if (termExit.error) return { ok: false, pid, escalated: false, initiallyAbsent: false, error: termExit.error };
    if (termExit.exited) return { ok: true, pid, escalated: false, initiallyAbsent: false };

    const kill = sendSignal(pid, 'SIGKILL', killPid);
    const killResult = classifySignalResult(kill, pid, true, false);
    if (killResult) return killResult;

    const killExit = await observeProcessExit({
      pid,
      timeoutMs: shutdownKillGraceMs,
      pollMs: shutdownPollMs,
      isAlive,
    });
    if (killExit.error) return { ok: false, pid, escalated: true, initiallyAbsent: false, error: killExit.error };
    if (killExit.exited) return { ok: true, pid, escalated: true, initiallyAbsent: false };
    return {
      ok: false,
      pid,
      escalated: true,
      initiallyAbsent: false,
      error: new Error(`process ${pid} survived SIGKILL grace`),
    };
  };
}
