import { readFileSync, writeFileSync } from 'node:fs';
import { sameUnixProcess, type UnixProcessIdentity } from '../../utils/cli-process-ownership.js';
import { hasDurableGateCancellationRequestArtifact } from './durable-managed-gate-cancellation.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import { readDurableGateRecovery } from './durable-managed-gate-recovery.js';
import {
  durableGateRecoveryReadyPath,
  hasDurableGateRecoveryReadyReceipt,
} from './durable-managed-gate-recovery-child-contract.js';

// Only the live durable owner publishes this before it signals its attempt.
// A cancelled/legacy/unacknowledged child never receives recovery authority.
function writeDurableGateStopIntent(
  job: DurableManagedGateJob,
  owner: UnixProcessIdentity,
  attemptToken: string,
  intent: 'timed_out',
): boolean {
  if (!job.recovery || hasDurableGateCancellationRequestArtifact(job)) return false;
  const snapshot = readDurableGateRecovery(job);
  const frozen = snapshot?.frozenIdentity;
  if (
    !snapshot ||
    !frozen ||
    snapshot.ownerIdentity.pid !== owner.pid ||
    snapshot.ownerIdentity.pgid !== owner.pgid ||
    !sameUnixProcess(snapshot.ownerIdentity, owner) ||
    !hasDurableGateRecoveryReadyReceipt(job, attemptToken, frozen) ||
    snapshot.terminalIntent !== 'timed_out'
  )
    return false;
  const projection = JSON.parse(readFileSync(job.gateReceiptPath, 'utf8')) as {
    jobId?: string;
    runId?: string;
    frozenIdentity?: { fingerprint?: string };
    executionOwner?: { jobId?: string; originTaskId?: string };
  };
  if (
    projection.jobId !== job.jobId ||
    !projection.runId ||
    projection.frozenIdentity?.fingerprint !== frozen.fingerprint ||
    !projection.executionOwner?.jobId ||
    !projection.executionOwner.originTaskId
  )
    return false;
  const boundary = snapshot.lastObservedAt;
  if (!Number.isSafeInteger(boundary)) return false;
  const receipt = {
    version: 1,
    intent,
    jobId: job.jobId,
    originTaskId: job.originTaskId,
    attemptToken,
    ownerIdentity: owner,
    runId: projection.runId,
    executionOwner: projection.executionOwner,
    frozenIdentity: frozen,
    pauseEpoch: snapshot.pauseEpoch,
    reconcileFrom: boundary,
    issuedAt: Date.now(),
  };
  writeFileSync(`${durableGateRecoveryReadyPath(job, attemptToken)}.stop-intent.json`, `${JSON.stringify(receipt)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return true;
}

export function publishDurableGateStopIntent(
  job: DurableManagedGateJob,
  owner: UnixProcessIdentity,
  attemptToken: string,
  intent: 'timed_out',
): boolean {
  try {
    return writeDurableGateStopIntent(job, owner, attemptToken, intent);
  } catch {
    return false;
  } // Publication failure must not prevent owned descendant cleanup.
}
