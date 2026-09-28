import { execFileSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isProcessRunning } from './process-tree.mjs';

export const PROCESS_START_TIME_FORMAT = 'ps-lstart-utc-c-v1';
export const TOKEN_ARG = '--cat-cafe-daemon-token=';
export const LEGACY_START_BUCKET_MS = 1_000;

const ARGV_READ_ATTEMPTS = 10;
const ARGV_READ_DELAY_MS = 20;

function canonicalPath(path) {
  return realpathSync(resolve(path));
}

/**
 * One ps field for one pid. `-ww` so a narrow COLUMNS can never truncate the
 * argv and cut off the trailing launch token.
 */
export function readPsField(pid, field, env = process.env) {
  return execFileSync('ps', ['-ww', '-p', String(pid), '-o', `${field}=`], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function stableProcessStart(pid, runPs) {
  const startedAt = runPs(pid, 'lstart', { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }).replace(/\s+/g, ' ');
  const startedAtEpochMs = Date.parse(`${startedAt} UTC`);
  if (!Number.isSafeInteger(startedAtEpochMs)) throw new Error(`Cannot parse process start time for PID ${pid}`);
  return { startedAt, startedAtEpochMs };
}

function processCwd(pid) {
  const procCwd = `/proc/${pid}/cwd`;
  try {
    return canonicalPath(readlinkSync(procCwd));
  } catch {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const cwd = output
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1);
    if (!cwd) throw new Error(`Cannot resolve cwd for PID ${pid}`);
    return canonicalPath(cwd);
  }
}

/**
 * ps(1): when a process's arguments are unavailable it prints the accounting
 * name in parentheses, and arguments that cannot be located in square brackets.
 * Neither is a command line, so neither proves or disproves anything about the
 * argv - in particular not the launch token.
 */
function isArgvUnavailable(command) {
  return /^\(.*\)$/.test(command) || /^\[.*\]$/.test(command);
}

export function captureProcessIdentity(pid, { runPs = readPsField } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid PID: ${pid}`);
  process.kill(pid, 0);
  const { startedAt, startedAtEpochMs } = stableProcessStart(pid, runPs);
  const commandEnv = { ...process.env, LC_ALL: 'C' };
  const command = runPs(pid, 'command', commandEnv);
  if (!startedAt || !command) throw new Error(`Cannot inspect PID ${pid}`);
  return {
    startedAt,
    startedAtEpochMs,
    startedAtFormat: PROCESS_START_TIME_FORMAT,
    command,
    ucomm: runPs(pid, 'ucomm', commandEnv),
    argvAvailable: !isArgvUnavailable(command),
    cwd: processCwd(pid),
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Failed identity reads use the existing ESRCH/zombie/unknown liveness authority. */
export function observeProcessIdentity(pid, capture = captureProcessIdentity) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { status: 'unknown', error: new Error(`Invalid PID: ${pid}`) };
  try {
    const identity = capture(pid);
    if (identity.argvAvailable === false && isProcessRunning(pid) === false) return { status: 'absent' };
    return { status: 'live', identity };
  } catch (error) {
    if (isProcessRunning(pid) === false) return { status: 'absent' };
    return { status: 'unknown', error };
  }
}

export function identityInspectionIsUnreadable(inspection) {
  return inspection.reason === 'process-argv-unavailable' || inspection.reason === 'process-identity-unreadable';
}

/**
 * For the moment right after spawn: re-read a bounded number of times while ps
 * cannot show the argv, and return whatever the last read was. The caller must
 * still check `argvAvailable` - a read that never becomes readable is reported,
 * not guessed.
 */
export function captureReadableIdentity(
  pid,
  { capture = captureProcessIdentity, attempts = ARGV_READ_ATTEMPTS, delayMs = ARGV_READ_DELAY_MS } = {},
) {
  let observed;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) sleepSync(delayMs);
    observed = observeProcessIdentity(pid, capture);
    if (observed.status === 'absent') {
      throw Object.assign(new Error(`PID ${pid} exited before its identity could be recorded`), {
        reason: 'spawned-process-not-running',
      });
    }
    if (observed.status === 'live' && observed.identity.argvAvailable !== false) return observed.identity;
  }
  if (observed?.status === 'live') return observed.identity;
  throw Object.assign(new Error(`Cannot inspect identity for PID ${pid}`), {
    reason: 'spawned-process-identity-unreadable',
    details: { pid, cause: observed?.error?.message },
  });
}

/**
 * Why a freshly spawned process cannot be recorded as this daemon, or undefined
 * when it can. An unreadable argv is its own reason: it neither proves nor
 * disproves the launch token, so it must not be reported as a mismatch.
 */
export function spawnedIdentityRefusal(pid, identity, expectedRoot, launchToken) {
  if (identity.argvAvailable === false) {
    return {
      reason: 'spawned-process-argv-unavailable',
      message: `Cannot read the argv of PID ${pid}; ps shows ${identity.command}`,
      details: { pid, shown: identity.command, ucomm: identity.ucomm },
    };
  }
  const tokenPresent = identity.command.includes(`${TOKEN_ARG}${launchToken}`);
  if (identity.cwd === expectedRoot && tokenPresent) return undefined;
  return {
    reason: 'spawned-process-identity-mismatch',
    message: `PID ${pid} is not the daemon spawned for ${expectedRoot}`,
    details: { observedCwd: identity.cwd, expectedRoot, tokenPresent },
  };
}

function identityMatches(state, identity) {
  const stored = state.process;
  if (!stored || !stored.startedAt || stored.cwd !== identity.cwd) return false;
  if (stored.command !== identity.command) return false;
  const hasLaunchToken = typeof stored.launchToken === 'string' && stored.launchToken.length > 0;
  if (stored.launchToken != null && !hasLaunchToken) return false;
  if (hasLaunchToken && !identity.command.includes(`${TOKEN_ARG}${stored.launchToken}`)) return false;

  if (stored.startedAtFormat !== undefined) {
    const stableBirthMatches =
      stored.startedAtFormat === PROCESS_START_TIME_FORMAT &&
      identity.startedAtFormat === PROCESS_START_TIME_FORMAT &&
      stored.startedAt === identity.startedAt &&
      stored.startedAtEpochMs === identity.startedAtEpochMs;
    if (!stableBirthMatches) return false;
    if (hasLaunchToken) return true;
  }

  // A pre-format token-bound v1 state still has an exact-incarnation launch token.
  if (hasLaunchToken) return true;

  // Tokenless migration is safe only when its whole start-time bucket predates the state.
  const stateWrittenAt = Date.parse(state.launchedAt);
  return (
    state.legacyMigrated === true &&
    Number.isFinite(stateWrittenAt) &&
    Number.isSafeInteger(identity.startedAtEpochMs) &&
    identity.startedAtEpochMs + LEGACY_START_BUCKET_MS <= stateWrittenAt
  );
}

/**
 * Three answers, kept apart. With a readable argv this is exactly the
 * exact-incarnation check. With an unreadable one, what is still readable can
 * prove a *different* process (another cwd, another birth time), but nothing can
 * prove it is the same one - so the answer is 'unknown', which callers must
 * treat neither as a match nor as a process that is gone.
 */
export function compareStoredIdentity(state, identity) {
  if (identity?.argvAvailable !== false) return identityMatches(state, identity) ? 'match' : 'mismatch';
  const stored = state.process;
  if (!stored || stored.cwd !== identity.cwd) return 'mismatch';
  const bothStable = Number.isSafeInteger(stored.startedAtEpochMs) && Number.isSafeInteger(identity.startedAtEpochMs);
  if (bothStable && stored.startedAtEpochMs !== identity.startedAtEpochMs) return 'mismatch';
  return 'unknown';
}

/** Wait for evidence of absence; an inspection failure leaves the outcome open. */
export async function waitUntilIdentityGone(state, graceMs, captureIdentity = captureProcessIdentity) {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const observed = observeProcessIdentity(state.pid, captureIdentity);
    if (observed.status === 'absent') return true;
    if (observed.status === 'live' && compareStoredIdentity(state, observed.identity) === 'mismatch') return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  return false;
}
