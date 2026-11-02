import { execFileSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareStableBirth, readProcBirth } from './process-birth-identity.mjs';
import { isProcessRunning } from './process-tree.mjs';

export { compareStableBirth } from './process-birth-identity.mjs';

export const PROCESS_START_TIME_FORMAT = 'ps-lstart-utc-c-v1';
export const TOKEN_ARG = '--cat-cafe-daemon-token=';
export const LEGACY_START_BUCKET_MS = 1_000;

const ARGV_READ_ATTEMPTS = 10;
const ARGV_READ_DELAY_MS = 20;
const SPAWN_SETTLE_MS = 2_000;
/**
 * start-dev.sh launches the daemon through nohup (launch_daemon_child). That
 * stage already carries the token and the cwd, but it is about to exec the daemon
 * script, and later inspections compare the whole command: recording it would
 * leave a live daemon that no status, stop or start could recognise.
 */
const LAUNCH_WRAPPER = /^(?:\S*\/)?nohup\s/;

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
  const procBirth = readProcBirth(pid);
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
    ...(procBirth ?? {}),
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

/** Re-observe unknown evidence within the existing spawn-read budget; never retry a conclusive mismatch. */
export function inspectProcessIdentity(state, capture = captureProcessIdentity) {
  let inspection;
  for (let attempt = 0; attempt < ARGV_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) sleepSync(ARGV_READ_DELAY_MS);
    const observed = observeProcessIdentity(state.pid, capture);
    if (observed.status === 'absent') return { kind: 'stale', reason: 'process-not-running', state };
    if (observed.status === 'unknown') {
      inspection = { kind: 'mismatch', reason: 'process-identity-unreadable', state, error: observed.error };
      continue;
    }
    const identity = observed.identity;
    const comparison = compareStoredIdentity(state, identity);
    if (comparison === 'match') return { kind: 'running', state, identity };
    if (comparison === 'mismatch') return { kind: 'mismatch', reason: 'process-identity-mismatch', state, identity };
    inspection = { kind: 'mismatch', reason: 'process-argv-unavailable', state, identity };
  }
  return inspection;
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
function spawnedIdentityRefusal(pid, identity, expectedRoot, launchToken) {
  if (identity.argvAvailable === false) {
    return {
      reason: 'spawned-process-argv-unavailable',
      message: `Cannot read the argv of PID ${pid}; ps shows ${identity.command}`,
      details: { pid, shown: identity.command, ucomm: identity.ucomm },
    };
  }
  const tokenPresent = identity.command.includes(`${TOKEN_ARG}${launchToken}`);
  if (identity.cwd === expectedRoot && tokenPresent) {
    if (!LAUNCH_WRAPPER.test(identity.command)) return undefined;
    return {
      reason: 'spawned-process-exec-unsettled',
      message: `PID ${pid} is still its nohup launch wrapper, not yet the daemon spawned for ${expectedRoot}`,
      details: { observedCwd: identity.cwd, expectedRoot, tokenPresent },
    };
  }
  const observed = tokenPresent
    ? `cwd ${identity.cwd}, launch token present`
    : `cwd ${identity.cwd}, launch token absent; ps shows ${identity.command}`;
  return {
    reason: 'spawned-process-identity-mismatch',
    message: `PID ${pid} is not the daemon spawned for ${expectedRoot} (${observed})`,
    details: { observedCwd: identity.cwd, expectedRoot, tokenPresent },
  };
}

/**
 * The two stages of a just-launched child that are not yet the daemon: the fork
 * before its exec (launcher argv, no token) and the nohup wrapper. A process in
 * the expected cwd whose argv just lacks the token reads the same as the first;
 * only the settle deadline tells them apart. Everything else is conclusive.
 */
function mayStillExec(refusal) {
  if (refusal.reason === 'spawned-process-exec-unsettled') return true;
  const { details } = refusal;
  return (
    refusal.reason === 'spawned-process-identity-mismatch' &&
    details.observedCwd === details.expectedRoot &&
    !details.tokenPresent
  );
}

/**
 * The identity of a process this caller just launched with `nohup ... &`. Until
 * the forked child execs it is a copy of the launching shell, so ps shows that
 * shell's own argv: readable, in the expected cwd, without the launch token. Then
 * it is nohup, token and all, for as long as nohup takes to exec the daemon.
 * Neither is the daemon yet, so it is re-read until the daemon's own argv appears
 * or the settle budget runs out. An exit, an argv that stays unreadable and a
 * different cwd keep their own refusals; nothing is recorded without the token.
 */
export function captureSpawnedIdentity(
  pid,
  expectedRoot,
  launchToken,
  { capture = captureProcessIdentity, settleMs = SPAWN_SETTLE_MS, delayMs = ARGV_READ_DELAY_MS } = {},
) {
  const deadline = Date.now() + settleMs;
  for (;;) {
    const identity = captureReadableIdentity(pid, { capture });
    const refusal = spawnedIdentityRefusal(pid, identity, expectedRoot, launchToken);
    if (!refusal) return identity;
    if (!mayStillExec(refusal) || Date.now() >= deadline) {
      throw Object.assign(new Error(refusal.message), { reason: refusal.reason, details: refusal.details });
    }
    sleepSync(delayMs);
  }
}

function identityMatches(state, identity) {
  const stored = state.process;
  if (!stored || !stored.startedAt || stored.cwd !== identity.cwd) return false;
  if (stored.command !== identity.command) return false;
  const hasLaunchToken = typeof stored.launchToken === 'string' && stored.launchToken.length > 0;
  if (stored.launchToken != null && !hasLaunchToken) return false;
  if (hasLaunchToken && !identity.command.includes(`${TOKEN_ARG}${stored.launchToken}`)) return false;

  const stableBirth = compareStableBirth(stored, identity);
  if (stableBirth === false) return false;

  // A launch token is generated per launch and is an exact-incarnation proof
  // on its own; lstart is not, because it follows the wall clock and can move
  // after suspend/resume. Pre-format states already relied on this token.
  if (hasLaunchToken) return true;

  if (stored.startedAtFormat !== undefined) {
    const legacyBirthMatches =
      stored.startedAtFormat === PROCESS_START_TIME_FORMAT &&
      identity.startedAtFormat === PROCESS_START_TIME_FORMAT &&
      stored.startedAt === identity.startedAt &&
      stored.startedAtEpochMs === identity.startedAtEpochMs;
    if (!legacyBirthMatches) return false;
  }

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
  const stableBirth = compareStableBirth(stored, identity);
  if (stableBirth === false) return 'mismatch';
  if (stableBirth === true) return 'unknown';
  // lstart follows the wall clock. Without conclusive birth evidence, an
  // unreadable argv cannot establish replacement or authorize stop cleanup.
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
