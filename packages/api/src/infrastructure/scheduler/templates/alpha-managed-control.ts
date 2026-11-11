import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ManagedJobService } from '../../../domains/managed-job/ManagedJobService.js';
import { validAlphaRevisionConsumer } from '../../../domains/managed-job/managed-job-admission.js';
import { isManagedJobStoreBusy } from '../../../domains/managed-job/managed-job-database.js';
import { managedJobPrincipalKey } from '../../../domains/managed-job/managed-job-ledger.js';
import type {
  AlphaRevisionConsumer,
  DurableManagedGateJob,
  ManagedJobPrincipal,
} from '../../../domains/managed-job/managed-job-types.js';
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
  const preparedPrincipals = new Map<string, ManagedJobPrincipal>();
  // The approved subscription may change guardians while its immutable job
  // still belongs to the previous cat. Only this internal bridge can reconnect
  // that exact user/thread/subscription; ordinary managed-job access is unchanged.
  const authorizeAlphaJob = (job: DurableManagedGateJob | null | undefined, expected?: AlphaRevisionConsumer) => {
    const principal = job?.definition?.principal;
    const consumer = job?.consumer;
    if (
      !job ||
      job.kind !== 'alpha_revision_v1' ||
      !principal ||
      !validAlphaRevisionConsumer(consumer) ||
      principal.userId !== options.principal.userId ||
      principal.threadId !== options.principal.threadId ||
      consumer.subscriptionId !== options.subscriptionId ||
      job.originTaskId !== options.subscriptionId ||
      job.definition?.originScheduleId !== options.subscriptionId ||
      (expected &&
        (consumer.s3JobId !== expected.s3JobId ||
          consumer.headSha !== expected.headSha ||
          consumer.baseSha !== expected.baseSha))
    )
      throw new Error('managed_job_not_found');
    return { job, principal };
  };
  return async (request: Record<string, unknown>) => {
    if (request.action === 'prepare') {
      const consumer = request.consumer;
      if (!validAlphaRevisionConsumer(consumer) || consumer.subscriptionId !== options.subscriptionId) {
        throw new Error('Alpha managed consumer does not match its approved subscription');
      }
      if (request.jobId !== undefined) {
        if (typeof request.jobId !== 'string') throw new Error('Alpha managed control requires a job identity');
        const { job, principal } = authorizeAlphaJob(service.resolve(request.jobId), consumer);
        preparedPrincipals.set(job.jobId, principal);
        return {
          jobId: job.jobId,
          inputPath: join(dirname(job.recordPath), `${job.jobId}.alpha-input.json`),
          gateReceiptPath: job.gateReceiptPath,
          consumer: job.consumer,
        };
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
      preparedPrincipals.set(job.jobId, options.principal);
      return { jobId: job.jobId, inputPath, gateReceiptPath: job.gateReceiptPath, consumer: job.consumer };
    }
    if (typeof request.jobId !== 'string') throw new Error('Alpha managed control requires a job identity');
    // Status polling remains off the API event loop. A cross-guardian access
    // first needs prepare's exact consumer proof; a cold same-owner inspect
    // still uses the ordinary authorization path.
    let snapshot = await service.readStatus(preparedPrincipals.get(request.jobId) ?? options.principal, request.jobId, {
      gateRecovery: true,
    });
    const { job, principal } = authorizeAlphaJob(snapshot.job);
    if (request.action === 'start') {
      const record = snapshot.status;
      if (record.state === 'queued') {
        service.admitSchedule(principal, job.jobId, options.subscriptionId);
        const started = service.start(principal, job.jobId, runner);
        // The durable job owns completion. The Alpha worker only polls its record.
        void started.completion.catch(() => undefined);
        await started.admission;
      }
    } else if (request.action === 'cancel') {
      service.cancel(principal, job.jobId);
    } else if (request.action === 'inspect') {
      if (Date.now() - (reconciledAt.get(job.jobId) ?? 0) >= 5000) {
        try {
          await service.reconcileJob(principal, job.jobId);
          reconciledAt.set(job.jobId, Date.now());
        } catch (error) {
          if (!isManagedJobStoreBusy(error)) throw error;
          // Keep reconciliation due. Observation may continue only if the fresh,
          // bounded status read below succeeds; no stale snapshot is returned.
        }
      }
    } else throw new Error('Unsupported Alpha managed action');
    snapshot = await service.readStatus(principal, job.jobId, { gateRecovery: true });
    const record = snapshot.status;
    return {
      jobId: job.jobId,
      state: record.state,
      cleanupProven: record.cleanupProven,
      result: record.result,
      attemptToken: record.attemptToken,
      recoveryBlockedReason: snapshot.recoveryBlockedReason,
    };
  };
}
