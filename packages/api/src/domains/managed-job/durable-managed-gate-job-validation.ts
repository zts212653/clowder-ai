import { resolve, sep } from 'node:path';
import { resolveCatCafeDataRoot } from '../../utils/cli-process-ownership.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import { validManagedJobSource } from './managed-job-admission.js';

function validRecoveryConfig(job: DurableManagedGateJob, dataRoot: string): boolean {
  if (job.kind === 'full_gate' || job.kind === 'command') return job.recovery === undefined;
  const recovery = job.recovery;
  if (
    !recovery ||
    recovery.protocolVersion !== 2 ||
    !Number.isSafeInteger(recovery.eventLoopGapMs) ||
    recovery.eventLoopGapMs <= 0 ||
    !Number.isSafeInteger(recovery.reconciliationBudgetMs) ||
    recovery.reconciliationBudgetMs <= 0 ||
    !Number.isSafeInteger(recovery.pollMs) ||
    recovery.pollMs <= 0 ||
    !recovery.powerEvidenceSource ||
    typeof recovery.powerEvidenceSource !== 'object'
  ) {
    return false;
  }
  if (recovery.powerEvidenceSource.kind === 'mac_pmset') return true;
  return (
    recovery.powerEvidenceSource.kind === 'json_file' &&
    typeof recovery.powerEvidenceSource.path === 'string' &&
    resolve(recovery.powerEvidenceSource.path).startsWith(`${resolve(dataRoot)}${sep}`)
  );
}

export function validateDurableManagedGateJob(
  job: DurableManagedGateJob,
  expectedJobId: string,
  dataRoot = resolveCatCafeDataRoot(),
): boolean {
  if (
    !job ||
    !['command', 'full_gate', 'resumable_full_gate_v2', 'alpha_revision_v1'].includes(job.kind) ||
    (job.kind === 'alpha_revision_v1') !== (job.consumer?.kind === 'alpha_revision_v1') ||
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
  const collection = job.recordStorage === 'sqlite_v1' ? 'managed-jobs' : 'managed-gate-jobs';
  if (job.kind === 'command' && job.recordStorage !== 'sqlite_v1') return false;
  if (
    job.recordStorage === 'sqlite_v1' &&
    (!job.definition ||
      job.definition.retryPolicy !== 'never' ||
      !job.definition.command ||
      !job.definition.cwd ||
      !job.definition.idempotencyKey ||
      !validManagedJobSource(job.definition, job.consumer, job.originTaskId) ||
      job.definition.principal.userId !== job.wakeTarget.userId ||
      job.definition.principal.threadId !== job.wakeTarget.threadId ||
      job.definition.principal.catId !== job.wakeTarget.catId)
  )
    return false;
  const expectedPath = resolve(dataRoot, collection, `${job.jobId}.json`);
  const expectedGateReceiptPath = resolve(dataRoot, collection, `${job.jobId}.gate.json`);
  const expectedLogPath = resolve(dataRoot, collection, `${job.jobId}.log`);
  const allowedRoot = `${resolve(dataRoot, collection)}${sep}`;
  return (
    validRecoveryConfig(job, dataRoot) &&
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
