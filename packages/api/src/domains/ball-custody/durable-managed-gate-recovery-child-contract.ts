import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import type { DurableGateFrozenIdentity } from './durable-managed-gate-recovery.js';

export const DURABLE_GATE_ATTEMPT_TOKEN_ENV = 'CAT_CAFE_MANAGED_GATE_ATTEMPT_TOKEN';
export const DURABLE_GATE_FROZEN_IDENTITY_ENV = 'CAT_CAFE_MANAGED_GATE_FROZEN_IDENTITY_JSON';
export const DURABLE_GATE_RECOVERY_READY_PATH_ENV = 'CAT_CAFE_MANAGED_GATE_RECOVERY_READY_PATH';
export const DURABLE_GATE_RESUME_EPOCH_ENV = 'CAT_CAFE_MANAGED_GATE_RESUME_EPOCH';
export const DURABLE_GATE_RECONCILE_FROM_ENV = 'CAT_CAFE_MANAGED_GATE_RECONCILE_FROM';
export const ALPHA_RECOVERY_JOURNAL_ENV = 'CAT_CAFE_ALPHA_RECOVERY_JOURNAL';

export function alphaRecoveryJournalPath(job: DurableManagedGateJob, attemptToken: string): string {
  return join(dirname(job.recordPath), `${job.jobId}.attempt-${attemptToken}.alpha-observations.jsonl`);
}

interface DurableGateRecoveryReadyReceipt {
  readonly version: 1;
  readonly protocolVersion: 2;
  readonly jobId: string;
  readonly attemptToken: string;
  readonly frozenFingerprint: string;
  readonly consumerKind?: string;
  readonly subscriptionId?: string;
  readonly s3JobId?: string;
  readonly generation?: number;
  readonly executionPlanFingerprint?: string;
}

export function durableGateRecoveryReadyPath(job: DurableManagedGateJob, attemptToken: string): string {
  return join(dirname(job.recordPath), `${job.jobId}.attempt-${attemptToken}.recovery-ready.json`);
}

function parseReadyReceipt(path: string): DurableGateRecoveryReadyReceipt | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.protocolVersion !== 2 ||
      typeof value.jobId !== 'string' ||
      typeof value.attemptToken !== 'string' ||
      typeof value.frozenFingerprint !== 'string'
    ) {
      return null;
    }
    return value as unknown as DurableGateRecoveryReadyReceipt;
  } catch {
    return null;
  }
}

export function hasDurableGateRecoveryReadyReceipt(
  job: DurableManagedGateJob,
  attemptToken: string,
  frozenIdentity: DurableGateFrozenIdentity,
): boolean {
  const receipt = parseReadyReceipt(durableGateRecoveryReadyPath(job, attemptToken));
  if (job.kind === 'alpha_revision_v1') {
    if (
      frozenIdentity.kind !== 'alpha_revision_v1' ||
      receipt?.consumerKind !== 'alpha_revision_v1' ||
      receipt.subscriptionId !== frozenIdentity.subscriptionId ||
      receipt.s3JobId !== frozenIdentity.s3JobId ||
      !Number.isSafeInteger(receipt.generation) ||
      (receipt.generation ?? 0) < 1 ||
      receipt.executionPlanFingerprint !== frozenIdentity.fingerprint
    )
      return false;
  } else if (frozenIdentity.kind === 'alpha_revision_v1') return false;
  return (
    receipt?.jobId === job.jobId &&
    receipt.attemptToken === attemptToken &&
    receipt.frozenFingerprint === frozenIdentity.fingerprint
  );
}
