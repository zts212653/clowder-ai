import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DaemonStateError, inspectDaemonState } from './daemon-state.mjs';
import { identityInspectionIsUnreadable } from './process-identity.mjs';
import { allProcessesGone } from './process-tree.mjs';

/**
 * F300 -- the StopOperationRecord on disk, and the pure checks over it.
 *
 * This module owns reading, writing and advancing the record, plus the
 * questions that can be answered from a record alone: is the recorded process
 * set gone, and is the daemon we froze still the same daemon. The lifecycle --
 * who may advance which state, and in what order -- stays with its one owner in
 * `daemon-stop-operation.mjs`.
 */

export const RECORD_VERSION = 1;
/** States an operation can be resumed from: it was opened and has not converged. */
export const IN_PROGRESS = new Set(['requested', 'stopping']);

export function recordFile(paths) {
  return join(paths.namespaceDir, 'stop-operation.json');
}

export function readStopOperation(paths) {
  const file = recordFile(paths);
  if (!existsSync(file)) return undefined;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return record?.v === RECORD_VERSION ? record : undefined;
  } catch {
    return undefined;
  }
}

export function writeRecord(paths, record) {
  const file = recordFile(paths);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return record;
}

export function advance(paths, record, state, extra = {}) {
  return writeRecord(paths, {
    ...record,
    ...extra,
    state,
    history: [...record.history, { state, opId: record.opId, at: new Date().toISOString() }],
  });
}

export function fail(paths, record, reason) {
  return advance(paths, record, 'failed', { failure: { reason } });
}

export function requireRecord(paths, opId) {
  const record = readStopOperation(paths);
  if (!record) throw new DaemonStateError('no-stop-operation', 'No stop operation record to advance');
  // INV-3: one opId spans stop, restart and re-verification.
  if (record.opId !== opId) {
    throw new DaemonStateError('op-id-mismatch', `Stop operation ${opId} does not own this record`);
  }
  return record;
}

/** @returns {true|false|undefined} -- undefined means we could not establish it. */
export function processSetGone(record) {
  return allProcessesGone(record.targetProcessSet ?? []);
}

/** The identity we opened against, so a replacement daemon cannot inherit this operation. */
export function frozenIdentity(state, identity) {
  return { pid: state.pid, startedAt: identity?.startedAt, command: identity?.command };
}

export function identityUnchanged(frozen, state, identity) {
  if (!frozen) return false;
  if (frozen.pid !== state.pid) return false;
  if (frozen.startedAt && identity?.startedAt && frozen.startedAt !== identity.startedAt) return false;
  return !(frozen.command && identity?.command && frozen.command !== identity.command);
}

/**
 * An inspection bound to the incarnation this record restarted. An unreadable
 * identity remains a non-running inspection, never absence. Read fresh every time it is
 * asked: an answer from before an await says nothing about after it.
 */
export function restartedIncarnation(paths, record) {
  const pid = record.restart?.pid;
  const inspection = inspectDaemonState({
    stateFile: paths.stateFile,
    expectedProjectRoot: record.projectRoot,
    expectedDeploymentId: record.deploymentId,
  });
  const same =
    inspection.kind === 'running' &&
    inspection.state.pid === pid &&
    identityUnchanged({ pid, ...(record.restart?.identity ?? {}) }, inspection.state, inspection.identity);
  if (inspection.kind !== 'running' || same) return inspection;
  return { ...inspection, kind: 'mismatch', reason: 'restarted-incarnation-mismatch' };
}

export function restartedIncarnationFailure(inspection) {
  return identityInspectionIsUnreadable(inspection) ? 'restarted_identity_unreadable' : 'restarted_process_absent';
}
