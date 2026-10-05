import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { normalizedGateEnvironment } from './gate-environment.mjs';

export const GATE_JOB_TOKEN_ENV = 'CAT_CAFE_GATE_JOB_TOKEN';
export const GATE_STAGE_ROOT_TOKEN_ENV = 'CAT_CAFE_GATE_STAGE_ROOT_TOKEN';
export const GATE_STAGE_LOCAL_TOKEN_ENV = 'CAT_CAFE_GATE_STAGE_LOCAL_TOKEN';
export const REDIS_TEST_COMMAND_TOKEN_ENV = 'CAT_CAFE_REDIS_TEST_COMMAND_TOKEN';
export const REDIS_TEST_ROOT_TOKEN_ENV = 'CAT_CAFE_REDIS_TEST_ROOT_TOKEN';
const SCANNABLE_TOKEN_ENV_KEYS = new Set([
  GATE_JOB_TOKEN_ENV,
  GATE_STAGE_ROOT_TOKEN_ENV,
  GATE_STAGE_LOCAL_TOKEN_ENV,
  REDIS_TEST_COMMAND_TOKEN_ENV,
  REDIS_TEST_ROOT_TOKEN_ENV,
]);
const OUTPUT_TAIL_BYTES = 64 * 1024;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function parseMacGateJobProcesses(snapshot, jobToken, tokenEnvironmentKey = GATE_JOB_TOKEN_ENV) {
  if (!SCANNABLE_TOKEN_ENV_KEYS.has(tokenEnvironmentKey)) throw new Error('Invalid gate process token key');
  const marker = new RegExp(`(?:^|\\s)${tokenEnvironmentKey}=${escapeRegExp(jobToken)}(?:\\s|$)`, 'u');
  return snapshot
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u))
    .filter((match) => match && marker.test(match[3]))
    .map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]) }))
    .filter((processRow) => processRow.pid !== process.pid);
}

function scanMac(jobToken, tokenEnvironmentKey, execFileSyncImpl) {
  const snapshot = execFileSyncImpl('ps', ['eww', '-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseMacGateJobProcesses(snapshot, jobToken, tokenEnvironmentKey);
}

function decodeEnvironment(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function scanLinux(jobToken, tokenEnvironmentKey, { execFileSyncImpl, readFileSyncImpl }) {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid)) throw new Error('current uid unavailable');
  const pids = execFileSyncImpl('ps', ['-u', String(uid), '-o', 'pid='], { encoding: 'utf8' })
    .split('\n')
    .map((value) => Number(value.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  const processes = [];
  for (const pid of pids) {
    try {
      const environment = decodeEnvironment(readFileSyncImpl(`/proc/${pid}/environ`));
      if (environment.includes(`${tokenEnvironmentKey}=${jobToken}`)) processes.push({ pid, parentPid: null });
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error;
    }
  }
  return processes;
}

export function scanGateJobProcesses(
  jobToken,
  {
    platform = process.platform,
    tokenEnvironmentKey = GATE_JOB_TOKEN_ENV,
    execFileSyncImpl = execFileSync,
    readFileSyncImpl = readFileSync,
    readdirSyncImpl = readdirSync,
  } = {},
) {
  if (typeof jobToken !== 'string' || jobToken.length < 8 || jobToken.includes('\0')) {
    throw new Error('Invalid gate job token');
  }
  if (!SCANNABLE_TOKEN_ENV_KEYS.has(tokenEnvironmentKey)) throw new Error('Invalid gate process token key');
  try {
    if (platform === 'darwin')
      return { status: 'ok', scanner: 'ps-env', processes: scanMac(jobToken, tokenEnvironmentKey, execFileSyncImpl) };
    if (platform === 'linux') {
      // Touch procfs first so a missing or hidden mount is reported as unknown,
      // not silently treated as an empty process set.
      readdirSyncImpl('/proc');
      return {
        status: 'ok',
        scanner: 'procfs-env',
        processes: scanLinux(jobToken, tokenEnvironmentKey, { execFileSyncImpl, readFileSyncImpl }),
      };
    }
    return { status: 'unknown', scanner: 'unsupported', processes: [] };
  } catch (error) {
    return {
      status: 'unknown',
      scanner: platform,
      processes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sleep(delayMs) {
  return new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}

function monotonicNowMs() {
  return Math.floor(performance.now());
}

function signalProcesses(processes, signal, killImpl, killedPids) {
  for (const processRow of processes) {
    try {
      killImpl(processRow.pid, signal);
      killedPids.add(processRow.pid);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

export async function cleanupGateJobProcesses({
  cleanupBudgetMs,
  isCommandClosed = () => true,
  jobToken,
  killGraceMs = 5_000,
  killImpl = process.kill,
  now = monotonicNowMs,
  pollMs = 50,
  scan = scanGateJobProcesses,
  settleGraceMs = 0,
  sleepImpl = sleep,
  tokenEnvironmentKey = GATE_JOB_TOKEN_ENV,
}) {
  const startedAt = now();
  const deadlineAt = startedAt + cleanupBudgetMs;
  const settleDeadlineAt = Math.min(deadlineAt, startedAt + settleGraceMs);
  const killedPids = new Set();
  let scanCount = 0;
  let consecutiveEmptyScans = 0;
  let emptySince = null;
  const observations = [];
  let signal = 'SIGTERM';
  while (true) {
    const snapshot = scan(jobToken, { tokenEnvironmentKey });
    const observedAt = now();
    const commandClosed = isCommandClosed();
    scanCount += 1;
    if (snapshot.status === 'ok' && snapshot.processes.length === 0 && commandClosed) {
      emptySince ??= observedAt;
      consecutiveEmptyScans += 1;
    } else {
      emptySince = null;
      consecutiveEmptyScans = 0;
    }
    observations.push({
      elapsedMs: observedAt - startedAt,
      status: snapshot.status,
      processCount: snapshot.processes.length,
      matchedPids: snapshot.processes.slice(0, 64).map((entry) => entry.pid),
      commandClosed,
    });
    if (observations.length > 8) observations.shift();
    const evidence = {
      scanCount,
      consecutiveEmptyScans,
      emptySpanMs: emptySince === null ? 0 : observedAt - emptySince,
      requiredEmptySpanMs: settleGraceMs,
      observations,
    };
    if (snapshot.status !== 'ok') {
      return {
        ...evidence,
        tokenZeroMatches: false,
        scanner: snapshot.scanner,
        status: 'unknown',
        cleanupDurationMs: observedAt - startedAt,
        killedPids: [...killedPids].sort((a, b) => a - b),
      };
    }
    // One transient empty ps snapshot is not settled absence. Require at least
    // two empty/closed observations spanning the entire settle window; a later
    // positive or open-pipe observation resets that window. Stay within budget.
    if (consecutiveEmptyScans >= 2 && evidence.emptySpanMs >= settleGraceMs && observedAt <= deadlineAt) {
      return {
        ...evidence,
        tokenZeroMatches: true,
        scanner: snapshot.scanner,
        status: 'proven',
        cleanupDurationMs: observedAt - startedAt,
        killedPids: [...killedPids].sort((a, b) => a - b),
      };
    }
    if (observedAt >= deadlineAt) {
      return {
        ...evidence,
        tokenZeroMatches: false,
        scanner: snapshot.scanner,
        status: 'budget_exhausted',
        cleanupDurationMs: observedAt - startedAt,
        pendingCommandClose: !commandClosed,
        remainingPids: snapshot.processes.map((entry) => entry.pid),
        killedPids: [...killedPids].sort((a, b) => a - b),
      };
    }
    if (observedAt < settleDeadlineAt) {
      await sleepImpl(Math.min(pollMs, Math.max(1, settleDeadlineAt - observedAt)));
      continue;
    }
    signalProcesses(snapshot.processes, signal, killImpl, killedPids);
    if (observedAt - startedAt >= killGraceMs) signal = 'SIGKILL';
    await sleepImpl(Math.min(pollMs, Math.max(1, deadlineAt - now())));
  }
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') child.kill(signal);
  }
}

function appendTail(current, chunk) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= OUTPUT_TAIL_BYTES ? combined : combined.subarray(combined.length - OUTPUT_TAIL_BYTES);
}

export async function runGateCommandWithCleanup({
  cancelRequested = () => false,
  cleanupBudgetMs,
  command,
  cwd = process.cwd(),
  env = {},
  executionBudgetMs,
  jobToken,
  killGraceMs = 5_000,
  cleanupSettleGraceMs = 0,
  now = monotonicNowMs,
  onStderr = null,
  onStdout = null,
  pollMs = 50,
}) {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    detached: process.platform !== 'win32',
    env: normalizedGateEnvironment(process.env, { ...env, [GATE_JOB_TOKEN_ENV]: jobToken }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutTail = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    stdoutTail = appendTail(stdoutTail, chunk);
    onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = appendTail(stderrTail, chunk);
    onStderr?.(chunk);
  });
  const executionStartedAt = now();
  let settled = false;
  let childResult;
  let commandClosed = false;
  child.once('close', () => {
    commandClosed = true;
  });
  const childDone = new Promise((resolveChild) => {
    child.on('error', (error) => {
      settled = true;
      childResult = { code: 1, signal: null, error: error.message };
      resolveChild(childResult);
    });
    child.on('exit', (code, signal) => {
      settled = true;
      childResult = { code, signal, error: null };
      resolveChild(childResult);
    });
  });
  let timedOut = false;
  let cancelled = false;
  while (!settled) {
    if (now() - executionStartedAt >= executionBudgetMs) {
      timedOut = true;
      break;
    }
    if (cancelRequested()) {
      cancelled = true;
      break;
    }
    await Promise.race([childDone, sleep(pollMs)]);
  }
  const executionEndedAt = now();
  if (!settled) signalProcessGroup(child, 'SIGTERM');
  const cleanupProof = await cleanupGateJobProcesses({
    cleanupBudgetMs,
    isCommandClosed: () => commandClosed,
    jobToken,
    killGraceMs,
    now,
    pollMs,
    settleGraceMs: settled && !timedOut && !cancelled ? cleanupSettleGraceMs : 0,
  });
  if (!commandClosed) {
    // Unproven descendants may retain the write ends. Release our local read
    // handles without turning that failure into proof of process cleanup.
    child.stdout.destroy();
    child.stderr.destroy();
  }
  const completedAt = now();
  return {
    exitCode: childResult?.code ?? null,
    signal: childResult?.signal ?? null,
    error: childResult?.error ?? null,
    timedOut,
    cancelled,
    executionDurationMs: executionEndedAt - executionStartedAt,
    cleanupDurationMs: cleanupProof.cleanupDurationMs,
    totalDurationMs: completedAt - executionStartedAt,
    cleanupProof,
    stdoutTail: stdoutTail.toString('utf8'),
    stderrTail: stderrTail.toString('utf8'),
  };
}
