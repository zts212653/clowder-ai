import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readDurableGateRecovery } from '../../../domains/ball-custody/durable-managed-gate-recovery.js';
import { ManagedJobService } from '../../../domains/managed-job/ManagedJobService.js';
import { validAlphaRevisionConsumer } from '../../../domains/managed-job/managed-job-admission.js';
import { managedJobPrincipalKey } from '../../../domains/managed-job/managed-job-ledger.js';
import type { ManagedJobPrincipal } from '../../../domains/managed-job/managed-job-types.js';
import { resolveCatCafeDataRoot } from '../../../utils/cli-process-ownership.js';
import { ManagedRunner } from '../../managed-runner.js';

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Internal schedule adapter. IPC data cannot choose a principal, command or timeout. */
export function createAlphaManagedControl(options: {
  readonly repoRoot: string;
  readonly principal: ManagedJobPrincipal;
  readonly subscriptionId: string;
  readonly dataRoot?: string;
}) {
  const dataRoot = options.dataRoot ?? resolveCatCafeDataRoot();
  const service = new ManagedJobService(dataRoot);
  const runner = new ManagedRunner();
  const reconciledAt = new Map<string, number>();
  return async (request: Record<string, unknown>) => {
    if (request.action === 'prepare') {
      const consumer = request.consumer;
      if (!validAlphaRevisionConsumer(consumer) || consumer.subscriptionId !== options.subscriptionId) {
        throw new Error('Alpha managed consumer does not match its approved subscription');
      }
      const idempotencyKey = `alpha:${consumer.subscriptionId}:${consumer.s3JobId}`;
      const digest = createHash('sha256')
        .update(JSON.stringify([managedJobPrincipalKey(options.principal), idempotencyKey]))
        .digest('hex')
        .slice(0, 40);
      const inputPath = join(dataRoot, 'managed-jobs', `managed-job-${digest}.alpha-input.json`);
      const command = `exec ${[
        process.execPath,
        join(options.repoRoot, 'scripts/lib/alpha-browser-managed-worker.mjs'),
        inputPath,
      ]
        .map(quote)
        .join(' ')}`;
      const job = await service.submit(options.principal, {
        command,
        cwd: options.repoRoot,
        originTaskId: options.subscriptionId,
        originScheduleId: options.subscriptionId,
        idempotencyKey,
        consumer,
        executionSlaMs: 60 * 60_000,
        wakeTarget: options.principal,
      });
      return { jobId: job.jobId, inputPath, gateReceiptPath: job.gateReceiptPath, consumer: job.consumer };
    }
    if (typeof request.jobId !== 'string') throw new Error('Alpha managed control requires a job identity');
    // A valid principal may own other jobs; this adapter is restricted to this subscription.
    service.get(options.principal, request.jobId);
    const job = service.resolve(request.jobId);
    if (job?.kind !== 'alpha_revision_v1' || job.consumer?.subscriptionId !== options.subscriptionId) {
      throw new Error('Alpha managed control cannot access an unrelated job');
    }
    if (request.action === 'start') {
      const record = service.get(options.principal, job.jobId);
      if (record.state === 'queued') {
        service.admitSchedule(options.principal, job.jobId, options.subscriptionId);
        const started = service.start(options.principal, job.jobId, runner);
        // The durable job owns completion. The Alpha worker only polls its record.
        void started.completion.catch(() => undefined);
        await started.admission;
      }
    } else if (request.action === 'cancel') {
      service.cancel(options.principal, job.jobId);
    } else if (request.action === 'inspect') {
      if (Date.now() - (reconciledAt.get(job.jobId) ?? 0) >= 5000) {
        await service.reconcileJob(options.principal, job.jobId);
        reconciledAt.set(job.jobId, Date.now());
      }
    } else throw new Error('Unsupported Alpha managed action');
    const record = service.get(options.principal, job.jobId);
    return {
      jobId: job.jobId,
      state: record.state,
      cleanupProven: record.cleanupProven,
      result: record.result,
      attemptToken: record.attemptToken,
      recoveryBlockedReason: readDurableGateRecovery(job)?.blockReason,
    };
  };
}
