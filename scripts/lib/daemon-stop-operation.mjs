import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { probeRecordedApiPort } from './daemon-health-probe.mjs';
import { DaemonStateError, inspectDaemonState, stopDaemon } from './daemon-state.mjs';
import { acquireClaim, releaseClaim } from './daemon-stop-claim.mjs';
import {
  advance,
  fail,
  frozenIdentity,
  IN_PROGRESS,
  identityUnchanged,
  processSetGone,
  RECORD_VERSION,
  readStopOperation,
  requireRecord,
  restartedIncarnation,
  restartedIncarnationFailure,
  writeRecord,
} from './daemon-stop-record.mjs';
import { identityInspectionIsUnreadable } from './process-identity.mjs';
import { descendantPids, isProcessRunning, isSelfOrDescendantOf } from './process-tree.mjs';

/**
 * F300 Task 1.4 -- the record that makes an authorized stop survivable.
 *
 * Stopping a deployment is the one operation where the thing that would report
 * the outcome is the thing being stopped. So the record lives on disk beside the
 * daemon state, every step after `stopped` reads only files, and one opId ties
 * the stop, the restart and the health re-check together.
 *
 * Three properties are load-bearing, and each was missing in the first draft:
 *
 * - **Exclusive claim.** Opening an operation is an exclusive file creation, not
 *   read-then-write. Two executors that both read "no record" would otherwise
 *   both write one and both believe they own the process set.
 * - **Frozen identity.** The record pins *which* daemon incarnation it opened
 *   against, and that identity is re-checked immediately before the signal. A
 *   daemon that was replaced in between is a different process wearing the same
 *   role, and stopping it would be stopping something nobody authorized.
 * - **Executed-signal evidence.** The record notes when it actually delegated a
 *   signal, which is what separates "we stopped it and crashed" from "somebody
 *   killed it behind our back".
 */

/** How long to let a stopped tree finish unwinding before calling survivors a failure. */
const SETTLE_MS = 1_000;

export { readStopOperation };

/**
 * Open an operation.
 *
 * INV-1 is an ancestry question, not a list membership question: the recorded
 * pid is the launcher, and everything the stop takes down is its subtree, so an
 * executor that is a descendant would be killing the branch it is standing on.
 */
export function requestStop({
  paths,
  expectedProjectRoot,
  expectedDeploymentId,
  invocationRef,
  executorPid = process.pid,
}) {
  const inspection = inspectDaemonState({ stateFile: paths.stateFile, expectedProjectRoot, expectedDeploymentId });
  // `missing` and `stale` are different answers and must stay different: no
  // state at all means this shell owns nothing, and reporting that as a
  // successful cleanup would let a generic stop look like it worked.
  if (inspection.kind === 'missing') {
    throw new DaemonStateError('no-state', `No daemon state: ${paths.stateFile}`);
  }

  const claimToken = acquireClaim(paths);
  try {
    if (inspection.kind === 'stale') {
      rmSync(paths.stateFile, { force: true });
      const opId = `op-${randomUUID()}`;
      return writeRecord(paths, {
        v: RECORD_VERSION,
        opId,
        deploymentId: expectedDeploymentId,
        projectRoot: expectedProjectRoot,
        state: 'stale_cleared',
        requestedBy: { invocationRef, executorPid },
        targetProcessSet: inspection.state?.pid ? [inspection.state.pid] : [],
        history: [{ state: 'stale_cleared', opId, at: new Date().toISOString() }],
      });
    }
    if (inspection.kind !== 'running') {
      throw new DaemonStateError(inspection.reason ?? 'unsafe-state', 'Refusing to open a stop operation');
    }

    const existing = readStopOperation(paths);
    if (existing && IN_PROGRESS.has(existing.state) && processSetGone(existing) !== true) {
      throw new DaemonStateError(
        'stop-already-in-progress',
        `Stop operation ${existing.opId} already holds this process set`,
      );
    }

    const launcherPid = inspection.state.pid;
    const descendants = descendantPids(launcherPid);
    if (!descendants.complete) {
      // The record's target set is what every later step reasons about. Freezing
      // an unproven one would make "every recorded process exited" a statement
      // about a list we know is missing entries.
      throw new DaemonStateError(
        'process-set-enumeration-incomplete',
        'Could not enumerate the full process tree this stop would take down',
        { launcherPid, enumerated: descendants.pids.length },
      );
    }
    const targetProcessSet = [launcherPid, ...descendants.pids];
    assertExecutorIsOutside(executorPid, launcherPid, targetProcessSet);

    const opId = `op-${randomUUID()}`;
    return writeRecord(paths, {
      v: RECORD_VERSION,
      opId,
      deploymentId: expectedDeploymentId,
      projectRoot: expectedProjectRoot,
      state: 'requested',
      requestedBy: { invocationRef, executorPid },
      launcherPid,
      targetProcessSet,
      frozenIdentity: frozenIdentity(inspection.state, inspection.identity),
      history: [{ state: 'requested', opId, at: new Date().toISOString() }],
    });
  } finally {
    releaseClaim(paths, claimToken);
  }
}

function assertExecutorIsOutside(executorPid, launcherPid, targetProcessSet) {
  const details = { executorPid, launcherPid, targetProcessSet };
  if (targetProcessSet.includes(executorPid)) {
    throw new DaemonStateError(
      'executor-in-target-set',
      'The process running this stop is inside the set it would stop; it cannot report its own outcome',
      details,
    );
  }
  const related = isSelfOrDescendantOf(executorPid, launcherPid);
  if (related === true) {
    throw new DaemonStateError(
      'executor-in-target-set',
      'The process running this stop descends from the daemon it would stop, so the stop would kill the reporter',
      details,
    );
  }
  if (related === undefined) {
    throw new DaemonStateError(
      'executor-independence-unproven',
      'Could not read this process ancestry, so its independence from the stop target is unproven',
      details,
    );
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait, briefly, for the recorded set to finish unwinding, then report survivors. */
async function survivorsOf(record, settleMs) {
  const deadline = Date.now() + settleMs;
  const notProvenGone = (pid) => isProcessRunning(pid) !== false;
  let survivors = (record.targetProcessSet ?? []).filter(notProvenGone);
  while (survivors.length > 0 && Date.now() < deadline) {
    await delay(25);
    survivors = survivors.filter(notProvenGone);
  }
  // A pid we could not read still counts: `stopped` claims every recorded
  // process is gone, and an unreadable one has not been shown to be.
  return survivors;
}

/**
 * Carry out the stop the record authorized, and record what actually happened.
 *
 * Execution is exclusive, not just opening: two executors replaying the same op
 * would each delegate a signal, and the second one lands on whatever holds the
 * pid by then. And `stopped` is a claim about the whole recorded set -- the
 * primitive only signals the launcher, and its children survive whenever the
 * launcher's shutdown trap did not run, so a success receipt from the launcher
 * is not evidence that the deployment is down.
 */
export async function executeStop({
  paths,
  expectedProjectRoot,
  expectedDeploymentId,
  opId,
  stop = stopDaemon,
  settleMs = SETTLE_MS,
}) {
  const claimToken = acquireClaim(paths);
  try {
    const record = requireRecord(paths, opId);
    if (!IN_PROGRESS.has(record.state)) {
      throw new DaemonStateError('stop-out-of-order', `Cannot execute a stop from state ${record.state}`);
    }

    const stopping = record.state === 'stopping' ? record : advance(paths, record, 'stopping');

    const gone = processSetGone(stopping);
    if (gone === undefined) {
      // We cannot see whether the target set is still running, so we can neither
      // converge nor safely signal. Say so rather than pick the convenient one.
      return fail(paths, stopping, 'process_liveness_unreadable');
    }
    if (gone) {
      // An interrupted stop converges rather than signalling again: re-killing a
      // recycled pid is how a crashed stop becomes someone else's outage.
      const outcome = record.state === 'stopping' ? 'converged-after-interruption' : 'already-gone';
      return advance(paths, stopping, 'stopped', { outcome });
    }

    const current = inspectDaemonState({ stateFile: paths.stateFile, expectedProjectRoot, expectedDeploymentId });
    if (current.kind !== 'running' || !identityUnchanged(stopping.frozenIdentity, current.state, current.identity)) {
      return fail(
        paths,
        stopping,
        identityInspectionIsUnreadable(current) ? 'target_identity_unreadable' : 'target_identity_changed',
      );
    }

    const signalled = writeRecord(paths, { ...stopping, signalledAt: new Date().toISOString() });
    let outcome;
    try {
      const result = await stop({
        paths,
        expectedProjectRoot,
        expectedDeploymentId,
        expectedIdentity: stopping.frozenIdentity,
      });
      outcome = result?.outcome ?? 'terminated';
    } catch (error) {
      return fail(paths, signalled, `stop_failed:${error?.reason ?? error?.code ?? 'unknown'}`);
    }

    const survivors = await survivorsOf(signalled, settleMs);
    if (survivors.length > 0) {
      return advance(paths, signalled, 'failed', {
        outcome,
        failure: { reason: 'process_set_survived', survivors },
      });
    }
    return advance(paths, signalled, 'stopped', { outcome });
  } finally {
    releaseClaim(paths, claimToken);
  }
}

export function authorizeRestart({ paths, opId, authorizedBy }) {
  const record = requireRecord(paths, opId);
  if (record.state === 'failed') {
    throw new DaemonStateError('operation-failed', 'A failed stop operation is terminal; open a new one');
  }
  if (record.state !== 'stopped') {
    throw new DaemonStateError('restart-out-of-order', `Cannot authorize a restart from state ${record.state}`);
  }
  // A restart is a user decision. Without a ref naming who authorized it, there
  // is nothing to hold up later as the thing that made this legitimate.
  if (typeof authorizedBy !== 'string' || authorizedBy.trim() === '') {
    throw new DaemonStateError('restart-authorization-required', 'A restart needs an explicit authorization ref');
  }
  return advance(paths, record, 'restart_authorized', {
    restart: { authorizedBy, at: new Date().toISOString() },
  });
}

/**
 * Record the restart -- of *this deployment*, not of any process that happens to
 * be alive.
 *
 * The proof is the canonical daemon state: the pid offered has to be the daemon
 * this operation was opened against, running now, under the same project root
 * and deployment id. A live pid on its own says nothing; the review that caught
 * this handed in the reviewer's own process and got a clean recovery.
 */
export function recordRestart({ paths, opId, pid }) {
  const record = requireRecord(paths, opId);
  if (record.state !== 'restart_authorized') {
    throw new DaemonStateError('restart-not-authorized', 'A restart needs an explicit user authorization first');
  }
  const inspection = inspectDaemonState({
    stateFile: paths.stateFile,
    expectedProjectRoot: record.projectRoot,
    expectedDeploymentId: record.deploymentId,
  });
  if (inspection.kind !== 'running' || inspection.state.pid !== pid) {
    return fail(paths, record, 'restart_process_unverifiable');
  }
  return advance(paths, record, 'restarted', {
    restart: {
      ...record.restart,
      pid,
      identity: { startedAt: inspection.identity?.startedAt, command: inspection.identity?.command },
    },
  });
}

/**
 * The last step, and the only one that may say "it came back".
 *
 * The health result is produced by probing the incarnation this record is
 * about, never supplied by the caller. And because the probe awaits, nothing
 * read before it is trusted after it: another operation may own the record by
 * then, and the daemon may have exited mid-probe. The result is committed only
 * under the claim, against a fresh read of the record and of the incarnation.
 */
export async function reverifyStop({ paths, opId, probeHealth = probeRecordedApiPort }) {
  const record = requireRecord(paths, opId);
  if (record.state === 'failed') return record;

  if (record.state !== 'restarted') {
    if (IN_PROGRESS.has(record.state) && processSetGone(record) === true && !record.signalledAt) {
      return fail(paths, record, 'bypass_detected');
    }
    return fail(paths, record, 'reverification_failed');
  }
  const before = restartedIncarnation(paths, record);
  if (before.kind !== 'running') return fail(paths, record, restartedIncarnationFailure(before));

  const health = await probeHealth(before.state, { incarnationPid: before.state.pid });

  let claim;
  try {
    claim = acquireClaim(paths);
  } catch {
    // Someone else is acting on this deployment right now; a late result must not write.
    return readStopOperation(paths);
  }
  try {
    const current = readStopOperation(paths);
    // A successor operation, or a terminal state reached while we waited, is not ours to overwrite.
    if (current?.opId !== opId || current.state !== 'restarted') return current;
    const after = restartedIncarnation(paths, current);
    if (after.kind !== 'running') return fail(paths, current, restartedIncarnationFailure(after));
    if (health === undefined) return fail(paths, current, 'health_unreadable');
    if (!health.ok) return fail(paths, current, 'reverification_failed');
    return advance(paths, current, 'reverified', {
      reverification: { ok: true, ref: health.ref, pid: current.restart.pid, at: new Date().toISOString() },
    });
  } finally {
    releaseClaim(paths, claim);
  }
}
