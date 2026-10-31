import { execFileSync } from 'node:child_process';

/**
 * F300 -- who actually goes down when a deployment stops.
 *
 * The daemon state records exactly one pid: the launcher shell
 * (`start-dev.sh:1745-1758`). The API, the web server and the proxy are started
 * as its children and are never written anywhere durable, so a list of "our
 * pids" cannot be read from disk. They die because the launcher's TERM trap runs
 * `terminate_managed_pids`, which walks the process tree with a recursive
 * `pgrep -P` (`start-dev.sh:820-861, 1401-1414`).
 *
 * So the honest question about any pid is an ancestry question, not a membership
 * question: is it the launcher, or something the launcher's shutdown would take
 * with it.
 *
 * Every observation here is three-valued. "I could not look" is not "it is
 * gone": an earlier draft returned false when `ps` failed, which let a single
 * failed observation report a deployment as stopped without a signal ever being
 * sent. Absence has to be proven -- by ESRCH, or by reading the zombie state --
 * and every caller handles the third answer explicitly.
 */

const MAX_DEPTH = 32;

function psField(pid, field) {
  return execFileSync('ps', ['-p', String(pid), '-o', `${field}=`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Is this pid a running process?
 *
 * @returns {true} it exists and has not exited
 * @returns {false} proven absent: no such process, or exited awaiting reaping
 * @returns {undefined} could not be determined -- never treat as absent
 */
export function isProcessRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // ESRCH is the one error that proves absence. EPERM means it exists and
    // belongs to somebody else; anything else means the probe itself failed.
    if (error?.code === 'ESRCH') return false;
    if (error?.code !== 'EPERM') return undefined;
  }

  let state;
  try {
    state = psField(pid, 'state');
  } catch {
    // `ps` refused or could not run. The pid answered a signal probe a moment
    // ago, so the honest answer is that we cannot tell whether it has since
    // become a zombie -- not that it is gone.
    return undefined;
  }
  if (state.length === 0) return false; // ps knows the process table and it is not in it.
  // 'Z' is a zombie: exited, awaiting reaping by its parent. The executor of a
  // stop is usually not the parent of what it stopped, so it is exactly the
  // party that sees these.
  return !state.startsWith('Z');
}

/** @returns {true} every pid is proven gone, {false} at least one runs, {undefined} unknown */
export function allProcessesGone(pids) {
  let sawUnknown = false;
  for (const pid of pids) {
    const running = isProcessRunning(pid);
    if (running === true) return false;
    if (running === undefined) sawUnknown = true;
  }
  return sawUnknown ? undefined : true;
}

/**
 * The parent pid `ps` reports, or `undefined` when it could not be read.
 *
 * A printed `0` is an observation, not a failure to observe: it is the boundary
 * that tops the tree (launchd and pid 1 both report it). Folding it into
 * `undefined` made every fully-read chain that reached the root come back
 * "cannot tell", so an ancestry question that has a definite answer -- no, this
 * pid is not ours -- was reported as unknown instead.
 *
 * @returns {number | undefined}
 */
export function parentOf(pid, readField = psField) {
  let printed;
  try {
    printed = readField(pid, 'ppid');
  } catch {
    return undefined; // `ps` refused or could not run.
  }
  const parent = Number.parseInt(printed, 10);
  return Number.isSafeInteger(parent) && parent >= 0 ? parent : undefined;
}

/**
 * Is `pid` the same as `ancestorPid`, or a descendant of it?
 *
 * @returns {boolean | undefined} undefined when the chain cannot be read to a
 * conclusion -- callers about to stop something must not fold that into `false`.
 */
export function isSelfOrDescendantOf(pid, ancestorPid, { readParent, readField } = {}) {
  const readParentPid = readParent ?? ((candidate) => parentOf(candidate, readField));
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ancestorPid)) return undefined;
  if (pid === ancestorPid) return true;

  let cursor = pid;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const parent = readParentPid(cursor);
    if (parent === undefined) return undefined;
    if (parent === ancestorPid) return true;
    // 0 and 1 both top the tree, so a chain that reaches either has been read
    // to a conclusion: this pid is not the one we asked about.
    if (parent <= 1) return false;
    cursor = parent;
  }
  return undefined;
}

const MAX_ENUMERATED = 1024;

/**
 * The pids a stop would currently take down, as of this moment.
 *
 * Reports whether the enumeration is *complete*, because an incomplete one is
 * indistinguishable from a small deployment: a failed `pgrep` used to look like
 * "no children", and a truncated walk used to look like the whole tree. Both
 * then went into the record as the full target set, and everything downstream
 * reasoned about processes it had never heard of.
 *
 * It is explicitly a snapshot; the ancestry check stays the authority at signal
 * time.
 *
 * @returns {{pids: number[], complete: boolean}}
 */
export function descendantPids(rootPid, { readChildren = childrenOf } = {}) {
  const found = [];
  const queue = [rootPid];
  let complete = true;

  while (queue.length > 0) {
    if (found.length >= MAX_ENUMERATED) return { pids: found, complete: false };
    const children = readChildren(queue.shift());
    if (children === undefined) {
      complete = false; // We could not read this branch; the set is not proven.
      continue;
    }
    for (const child of children) {
      if (found.includes(child) || child === rootPid) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return { pids: found, complete };
}

/** @returns {number[] | undefined} undefined when the enumeration itself failed. */
function childrenOf(pid) {
  try {
    return parsePgrepOutput(
      execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  } catch (error) {
    // `pgrep` exits 1 to say "nothing matched", which is a real, empty answer.
    // Any other failure means we did not get to look.
    return error?.status === 1 ? [] : undefined;
  }
}

function parsePgrepOutput(output) {
  return output
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((child) => Number.isSafeInteger(child) && child > 1);
}
