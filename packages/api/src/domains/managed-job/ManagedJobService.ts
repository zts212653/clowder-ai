import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import type { ManagedRunner, ManagedRunnerStartResult } from '../../infrastructure/managed-runner.js';
import { resolveCatCafeDataRoot } from '../../utils/cli-process-ownership.js';
import { findMonorepoRoot } from '../../utils/monorepo-root.js';
import {
  createResumableDurableManagedGateJob,
  DEFAULT_DURABLE_GATE_RECOVERY,
} from '../ball-custody/durable-managed-gate-consumer.js';
import {
  cancelDurableManagedGateJob,
  type DurableManagedGateJob,
  initializeDurableManagedGateJob,
  isDurableManagedGateCommand,
  type ManagedJobPrincipal,
} from './durable-managed-gate-job.js';
import {
  rawDurableGateRecord,
  readDurableGateRecord,
  writeDurableGateRecord,
} from './durable-managed-gate-job-store.js';
import { CURRENT_DURABLE_GATE_SUPERVISOR_EPOCH } from './durable-managed-gate-supervisor.js';
import { isManagedJobAdmitted, validManagedJobSource } from './managed-job-admission.js';
import { withSupervisorStores } from './managed-job-database.js';
import { publishManagedJobRecoveryBatch } from './managed-job-health.js';
import { listManagedJobLedger, managedJobPrincipalKey, readManagedJobTransitions } from './managed-job-ledger.js';
import { readLegacyManagedJobById } from './managed-job-legacy-read.js';
import { readManagedJobLogTail } from './managed-job-log.js';
import { readManagedJobDueDescriptors, reconcileManagedJobOwnerBatch } from './managed-job-owner-recovery.js';
import { reconcileManagedJobDescriptor } from './managed-job-reconcile-descriptor.js';
import {
  type ManagedJobObservation,
  type ManagedJobReconciliationRequest,
  reconcileManagedJobsOffLoop,
} from './managed-job-reconciliation.js';
import { readManagedJobRecovery } from './managed-job-recovery-ledger.js';
import {
  type ManagedJobStatusRequest,
  type ManagedJobStatusSnapshot,
  readManagedJobStatus,
} from './managed-job-status.js';
import type { ManagedJobAccess, ManagedJobSubmission } from './managed-job-types.js';

export type { ManagedJobAccess, ManagedJobSubmission } from './managed-job-types.js';

export class ManagedJobService {
  constructor(
    private readonly dataRoot = resolveCatCafeDataRoot(),
    private readonly maxConcurrent = 4,
    private readonly operatorUserId?: string,
    private readonly supervisorEpoch: string = CURRENT_DURABLE_GATE_SUPERVISOR_EPOCH,
  ) {}

  private locator(jobId: string): DurableManagedGateJob {
    if (!/^(?:managed-job-[a-f0-9]{40}|managed-gate-[a-f0-9-]{36})$/u.test(jobId))
      throw new Error('managed_job_not_found');
    return {
      kind: 'command',
      recordStorage: 'sqlite_v1',
      jobId,
      originTaskId: '',
      supervisorEpoch: CURRENT_DURABLE_GATE_SUPERVISOR_EPOCH,
      recordPath: join(this.dataRoot, 'managed-jobs', `${jobId}.json`),
      gateReceiptPath: join(this.dataRoot, 'managed-jobs', `${jobId}.gate.json`),
      logPath: join(this.dataRoot, 'managed-jobs', `${jobId}.log`),
      executionSlaMs: 0,
      wallSlaMs: 0,
      wakeTarget: { userId: '', threadId: '', catId: '' },
    };
  }

  /** Internal descriptor lookup. External callers must enter through get/start/cancel/tail. */
  resolve(jobId: string): DurableManagedGateJob | null {
    const locator = this.locator(jobId);
    if (!existsSync(join(this.dataRoot, 'managed-jobs', 'supervisor.sqlite'))) return null;
    const record = rawDurableGateRecord(locator);
    if (record?.descriptor) return record.descriptor as DurableManagedGateJob;
    if (jobId.startsWith('managed-gate-')) {
      const read = readLegacyManagedJobById(this.dataRoot, jobId);
      return read.kind === 'record' ? read.job : null;
    }
    return null;
  }

  private authorized(principal: ManagedJobAccess, jobId: string): DurableManagedGateJob {
    const job = this.resolve(jobId);
    const allowed =
      'kind' in principal
        ? principal.userId === this.operatorUserId && principal.threadId === job?.wakeTarget.threadId
        : !!job &&
          managedJobPrincipalKey(job.definition?.principal ?? job.wakeTarget) === managedJobPrincipalKey(principal);
    if (!job || !allowed) {
      throw new Error('managed_job_not_found');
    }
    return job;
  }

  findSubmission(
    principal: ManagedJobPrincipal,
    input: Pick<
      ManagedJobSubmission,
      'command' | 'cwd' | 'idempotencyKey' | 'executionSlaMs' | 'retryOfJobId' | 'consumer' | 'originScheduleId'
    >,
  ) {
    const digest = createHash('sha256')
      .update(JSON.stringify([managedJobPrincipalKey(principal), input.idempotencyKey]))
      .digest('hex')
      .slice(0, 40);
    const existing = this.resolve(`managed-job-${digest}`);
    if (!existing) return null;
    this.authorized(principal, existing.jobId);
    if (
      existing.definition?.command !== input.command ||
      existing.definition.cwd !== realpathSync(input.cwd ?? process.cwd()) ||
      existing.executionSlaMs !== input.executionSlaMs ||
      (existing.definition.retryOfJobId ?? null) !== (input.retryOfJobId ?? null) ||
      (['kind', 'subscriptionId', 's3JobId', 'headSha', 'baseSha'] as const).some(
        (key) => existing.consumer?.[key] !== input.consumer?.[key],
      ) ||
      (existing.definition.originScheduleId ?? null) !== (input.originScheduleId ?? null)
    )
      throw new Error('managed_job_idempotency_conflict');
    return existing;
  }

  async submit(principal: ManagedJobPrincipal, input: ManagedJobSubmission): Promise<DurableManagedGateJob> {
    if (process.env.CAT_CAFE_MANAGED_JOB_ID) throw new Error('nested_managed_job_denied');
    if (
      !principal.userId ||
      !principal.threadId ||
      !principal.catId ||
      !validManagedJobSource(input, input.consumer, input.originTaskId) ||
      !input.idempotencyKey ||
      input.idempotencyKey.length > 256 ||
      !input.command.trim() ||
      !Number.isSafeInteger(input.executionSlaMs) ||
      input.executionSlaMs < 1000 ||
      input.executionSlaMs > 10_800_000
    ) {
      throw new Error('invalid_managed_job_submission');
    }
    const cwd = realpathSync(input.cwd ?? process.cwd());
    if (!statSync(cwd).isDirectory()) throw new Error('invalid_managed_job_cwd');
    const digest = createHash('sha256')
      .update(JSON.stringify([managedJobPrincipalKey(principal), input.idempotencyKey]))
      .digest('hex')
      .slice(0, 40);
    const jobId = `managed-job-${digest}`;
    const existing = this.findSubmission(principal, input);
    if (existing) {
      return existing;
    }
    let retryEpoch = 0;
    if (input.retryOfJobId) {
      const parent = this.authorized(principal, input.retryOfJobId);
      if (readDurableGateRecord(parent)?.state !== 'terminal') throw new Error('managed_job_retry_requires_terminal');
      retryEpoch = (parent.definition?.retryEpoch ?? 0) + 1;
    }
    if (managedJobPrincipalKey(principal) !== managedJobPrincipalKey(input.wakeTarget)) {
      throw new Error('managed_job_wake_principal_mismatch');
    }
    const guardUrl = pathToFileURL(join(findMonorepoRoot(), 'scripts/native-effect-target-guard.mjs')).href;
    const guard = (await import(guardUrl)) as {
      decideNativeHookPayload(payload: unknown): { decision: string; reasonCode?: string };
    };
    const verdict = guard.decideNativeHookPayload({ tool_name: 'Bash', tool_input: { command: input.command }, cwd });
    if (verdict.decision !== 'allow') throw new Error(`managed_job_effect_denied:${verdict.reasonCode ?? 'unknown'}`);
    const gate = isDurableManagedGateCommand(input.command)
      ? createResumableDurableManagedGateJob(input.originTaskId, input.executionSlaMs, input.wakeTarget, this.dataRoot)
      : null;
    const job: DurableManagedGateJob = {
      ...this.locator(jobId),
      ...(gate ? { kind: gate.kind, recovery: gate.recovery } : {}),
      ...(input.consumer
        ? { kind: 'alpha_revision_v1' as const, consumer: input.consumer, recovery: DEFAULT_DURABLE_GATE_RECOVERY }
        : {}),
      originTaskId: input.originTaskId,
      executionSlaMs: input.executionSlaMs,
      wallSlaMs: gate?.wallSlaMs ?? (input.consumer ? 10_800_000 : input.executionSlaMs),
      wakeTarget: input.wakeTarget,
      definition: {
        principal,
        command: input.command,
        cwd,
        ...(input.originInvocationId ? { originInvocationId: input.originInvocationId } : {}),
        ...(input.originScheduleId ? { originScheduleId: input.originScheduleId } : {}),
        idempotencyKey: input.idempotencyKey,
        retryPolicy: 'never',
        retryEpoch,
        ...(input.retryOfJobId ? { retryOfJobId: input.retryOfJobId } : {}),
        maxConcurrent: this.maxConcurrent,
      },
    };
    try {
      initializeDurableManagedGateJob(job);
      return job;
    } catch (error) {
      // Concurrent retries share the same identity; they may observe the first committed submission.
      const winner = this.findSubmission(principal, input);
      if (winner) return winner;
      throw error;
    }
  }

  admit(principal: ManagedJobPrincipal, jobId: string, admissionMessageId: string): void {
    const job = this.authorized(principal, jobId);
    if (job.kind === 'alpha_revision_v1') throw new Error('managed_job_requires_schedule_admission');
    const record = rawDurableGateRecord(job);
    if (!record || record.state !== 'queued' || !admissionMessageId) throw new Error('managed_job_not_queued');
    if (record.admissionMessageId === admissionMessageId) return;
    if (!writeDurableGateRecord(job, { ...record, admissionMessageId, updatedAt: Date.now() })) {
      throw new Error('managed_job_admission_fenced');
    }
  }

  admitSchedule(principal: ManagedJobPrincipal, jobId: string, scheduleId: string): void {
    const job = this.authorized(principal, jobId);
    if (
      job.kind !== 'alpha_revision_v1' ||
      !scheduleId ||
      job.consumer?.subscriptionId !== scheduleId ||
      job.definition?.originScheduleId !== scheduleId
    ) {
      throw new Error('managed_job_invalid_schedule_admission');
    }
    const record = rawDurableGateRecord(job);
    if (!record || record.state !== 'queued') throw new Error('managed_job_not_queued');
    if (isManagedJobAdmitted(job, record)) return;
    if (!writeDurableGateRecord(job, { ...record, scheduleAdmission: { scheduleId }, updatedAt: Date.now() })) {
      throw new Error('managed_job_admission_fenced');
    }
  }

  start(principal: ManagedJobPrincipal, jobId: string, runner: ManagedRunner): ManagedRunnerStartResult {
    const job = this.authorized(principal, jobId);
    const record = readDurableGateRecord(job);
    if (!record || !isManagedJobAdmitted(job, record) || record.state !== 'queued' || !job.definition) {
      throw new Error('managed_job_not_admitted');
    }
    return runner.start(job.definition.command, {
      cwd: job.definition.cwd,
      timeoutMs: job.wallSlaMs,
      maximumTimeoutMs: job.wallSlaMs,
      managedJob: job,
    });
  }

  /** Synchronous worker/internal projection. HTTP/scheduler observations enter through readStatus. */
  get(principal: ManagedJobAccess, jobId: string) {
    const job = this.authorized(principal, jobId);
    const record = readDurableGateRecord(job);
    if (!record) throw new Error('managed_job_not_found');
    const state =
      record.state === 'terminal'
        ? record.terminalStatus === 'green'
          ? 'succeeded'
          : record.terminalStatus === 'partial'
            ? 'failed'
            : record.terminalStatus
        : record.state === 'waiting'
          ? 'running'
          : record.state;
    return {
      ...record,
      recovery: readManagedJobRecovery(job)?.recovery,
      state,
      actionKind:
        job.kind === 'command' ? 'command' : job.kind === 'alpha_revision_v1' ? 'alpha_revision' : 'full_gate',
      command: job.definition?.command,
      cwd: job.definition?.cwd,
      retryPolicy: 'never' as const,
      retryEpoch: job.definition?.retryEpoch ?? 0,
      ...(job.definition?.retryOfJobId ? { retryOfJobId: job.definition.retryOfJobId } : {}),
    };
  }

  /** One authorized status snapshot off the API loop, including any requested output/history. */
  readStatus(
    principal: ManagedJobAccess,
    jobId: string,
    options: Pick<ManagedJobStatusRequest, 'tailBytes' | 'gateRecovery'> = {},
  ): Promise<ManagedJobStatusSnapshot> {
    return reconcileManagedJobsOffLoop<ManagedJobStatusSnapshot>({
      kind: 'status',
      principal,
      jobId,
      ...options,
      now: Date.now(),
      dataRoot: this.dataRoot,
      maxConcurrent: this.maxConcurrent,
      operatorUserId: this.operatorUserId,
      supervisorEpoch: this.supervisorEpoch,
    });
  }

  cancel(principal: ManagedJobAccess, jobId: string) {
    const job = this.authorized(principal, jobId);
    return cancelDurableManagedGateJob(job, {
      cancelledBy: 'kind' in principal ? `operator:${principal.userId}` : principal.catId,
      reason: 'explicit_job_cancel',
    });
  }

  tail(principal: ManagedJobAccess, jobId: string, maxBytes = 16_384): string {
    const job = this.authorized(principal, jobId);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) throw new Error('invalid_job_tail_limit');
    if (!existsSync(job.logPath)) return '';
    return readManagedJobLogTail(job.logPath, maxBytes);
  }

  transitions(principal: ManagedJobAccess, jobId: string) {
    const job = this.authorized(principal, jobId);
    return readManagedJobTransitions(job.recordStorage === 'sqlite_v1' ? job : this.locator(jobId));
  }

  /** Scheduler-independent census includes jobs whose wake carrier was consumed or replaced. */
  list() {
    if (!existsSync(join(this.dataRoot, 'managed-jobs', 'supervisor.sqlite'))) return [];
    return listManagedJobLedger(this.locator(`managed-job-${'0'.repeat(40)}`)).flatMap((record) =>
      record.descriptor ? [record.descriptor as DurableManagedGateJob] : [],
    );
  }

  /** Fixed due owner rows supply production receipts/notices even when the original wait has already settled. */
  recoveryDueJobs(now: number): DurableManagedGateJob[] {
    return readManagedJobDueDescriptors(this.dataRoot, this.locator(`managed-job-${'0'.repeat(40)}`), now);
  }

  activeExecutions() {
    if (!existsSync(join(this.dataRoot, 'managed-jobs', 'supervisor.sqlite'))) return [];
    return listManagedJobLedger(this.locator(`managed-job-${'0'.repeat(40)}`), true).flatMap((record) => {
      const job = record.descriptor as DurableManagedGateJob;
      if (!isManagedJobAdmitted(job, record) || !job.definition || typeof record.createdAt !== 'number') return [];
      return [{ job, startedAt: record.createdAt }];
    });
  }

  /** Reconnect one authorized consumer without scanning unrelated jobs on each poll. */
  async reconcileJob(principal: ManagedJobAccess, jobId: string, now = Date.now()): Promise<ManagedJobObservation> {
    if (!isMainThread)
      return withSupervisorStores(async () =>
        reconcileManagedJobDescriptor(this.authorized(principal, jobId), now, this.supervisorEpoch),
      );
    const row = await reconcileManagedJobsOffLoop<ManagedJobObservation>({
      kind: 'one',
      principal,
      jobId,
      now,
      dataRoot: this.dataRoot,
      maxConcurrent: this.maxConcurrent,
      operatorUserId: this.operatorUserId,
      supervisorEpoch: this.supervisorEpoch,
    });
    return row;
  }

  async reconcile(
    legacyJobs: readonly DurableManagedGateJob[] = [],
    now = Date.now(),
  ): Promise<ManagedJobObservation[]> {
    if (
      !existsSync(join(this.dataRoot, 'managed-jobs', 'supervisor.sqlite')) &&
      !existsSync(join(this.dataRoot, 'managed-gate-jobs'))
    )
      return [];
    if (!isMainThread)
      return reconcileManagedJobOwnerBatch(
        this.dataRoot,
        this.locator(`managed-job-${'0'.repeat(40)}`),
        legacyJobs,
        now,
        this.supervisorEpoch,
      );
    const results = await reconcileManagedJobsOffLoop<ManagedJobObservation[]>({
      kind: 'all',
      legacyJobs,
      now,
      dataRoot: this.dataRoot,
      maxConcurrent: this.maxConcurrent,
      operatorUserId: this.operatorUserId,
      supervisorEpoch: this.supervisorEpoch,
    });
    publishManagedJobRecoveryBatch(results.map(({ health }) => health));
    return results;
  }
}

/** Trusted worker entry: preserve the API's supervisor epoch and process birth identity. */
export function reconcileManagedJobsInWorker(input: ManagedJobReconciliationRequest) {
  const service = new ManagedJobService(
    input.dataRoot,
    input.maxConcurrent,
    input.operatorUserId,
    input.supervisorEpoch,
  );
  if (input.kind === 'status') return readManagedJobStatus(service, input);
  return input.kind === 'one'
    ? service.reconcileJob(input.principal, input.jobId, input.now)
    : service.reconcile(input.legacyJobs, input.now);
}
