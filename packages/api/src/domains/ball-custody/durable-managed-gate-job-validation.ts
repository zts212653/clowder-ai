import { resolve, sep } from 'node:path';
import { resolveCatCafeDataRoot } from '../../utils/cli-process-ownership.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';

export function validateDurableManagedGateJob(
  job: DurableManagedGateJob,
  expectedJobId: string,
  dataRoot = resolveCatCafeDataRoot(),
): boolean {
  if (
    !job ||
    job.kind !== 'full_gate' ||
    typeof job.jobId !== 'string' ||
    !job.jobId ||
    typeof job.originTaskId !== 'string' ||
    !job.originTaskId ||
    typeof job.supervisorEpoch !== 'string' ||
    !job.supervisorEpoch ||
    !Number.isSafeInteger(job.executionSlaMs) ||
    job.executionSlaMs <= 0 ||
    !Number.isSafeInteger(job.wallSlaMs) ||
    job.wallSlaMs <= 0 ||
    !job.wakeTarget ||
    typeof job.wakeTarget.threadId !== 'string' ||
    !job.wakeTarget.threadId ||
    typeof job.wakeTarget.catId !== 'string' ||
    !job.wakeTarget.catId ||
    typeof job.wakeTarget.userId !== 'string' ||
    !job.wakeTarget.userId
  )
    return false;
  const expectedPath = resolve(dataRoot, 'managed-gate-jobs', `${job.jobId}.json`);
  const expectedGateReceiptPath = resolve(dataRoot, 'managed-gate-jobs', `${job.jobId}.gate.json`);
  const expectedLogPath = resolve(dataRoot, 'managed-gate-jobs', `${job.jobId}.log`);
  const allowedRoot = `${resolve(dataRoot, 'managed-gate-jobs')}${sep}`;
  return (
    job.originTaskId === expectedJobId &&
    typeof job.recordPath === 'string' &&
    resolve(job.recordPath) === expectedPath &&
    typeof job.gateReceiptPath === 'string' &&
    resolve(job.gateReceiptPath) === expectedGateReceiptPath &&
    typeof job.logPath === 'string' &&
    resolve(job.logPath) === expectedLogPath &&
    expectedPath.startsWith(allowedRoot) &&
    expectedGateReceiptPath.startsWith(allowedRoot) &&
    expectedLogPath.startsWith(allowedRoot)
  );
}
