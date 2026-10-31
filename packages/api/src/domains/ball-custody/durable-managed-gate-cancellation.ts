import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';

export interface DurableGateCancellationRequest {
  readonly version: 1;
  readonly jobId: string;
  readonly originTaskId: string;
  readonly requestedAt: number;
  readonly cancelledBy: string;
  readonly reason: string;
}

function cancellationRequestPath(job: DurableManagedGateJob): string {
  return `${job.recordPath}.cancel-request`;
}

export function hasDurableGateCancellationRequestArtifact(job: DurableManagedGateJob): boolean {
  return existsSync(cancellationRequestPath(job));
}

function recoverCorruptCancellationRequest(
  job: DurableManagedGateJob,
  requestPath: string,
): DurableGateCancellationRequest | null {
  // Artifact presence is the durable cancellation bit; JSON fields are audit metadata.
  // A torn/corrupt write must therefore fail closed without resetting its grace clock.
  try {
    return {
      version: 1,
      jobId: job.jobId,
      originTaskId: job.originTaskId,
      requestedAt: statSync(requestPath).mtimeMs,
      cancelledBy: 'recovered_corrupt_cancel_artifact',
      reason: 'corrupt_cancel_artifact_fail_closed',
    };
  } catch {
    return null;
  }
}

export function readDurableGateCancellationRequest(job: DurableManagedGateJob): DurableGateCancellationRequest | null {
  const requestPath = cancellationRequestPath(job);
  if (!existsSync(requestPath)) return null;
  try {
    const value = JSON.parse(readFileSync(requestPath, 'utf8')) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.jobId !== job.jobId ||
      value.originTaskId !== job.originTaskId ||
      typeof value.requestedAt !== 'number' ||
      typeof value.cancelledBy !== 'string' ||
      !value.cancelledBy ||
      typeof value.reason !== 'string' ||
      !value.reason
    )
      return recoverCorruptCancellationRequest(job, requestPath);
    return value as unknown as DurableGateCancellationRequest;
  } catch {
    return recoverCorruptCancellationRequest(job, requestPath);
  }
}

export function admitDurableGateCancellationRequest(
  job: DurableManagedGateJob,
  input: { requestedAt: number; cancelledBy: string; reason: string },
): DurableGateCancellationRequest {
  const existing = readDurableGateCancellationRequest(job);
  if (existing) return existing;
  const requestPath = cancellationRequestPath(job);
  mkdirSync(dirname(requestPath), { recursive: true });
  const request: DurableGateCancellationRequest = {
    version: 1,
    jobId: job.jobId,
    originTaskId: job.originTaskId,
    requestedAt: input.requestedAt,
    cancelledBy: input.cancelledBy,
    reason: input.reason,
  };
  try {
    writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { flag: 'wx' });
    return request;
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    const winner = readDurableGateCancellationRequest(job);
    if (!winner) throw new Error(`invalid durable gate cancellation request: ${requestPath}`);
    return winner;
  }
}
