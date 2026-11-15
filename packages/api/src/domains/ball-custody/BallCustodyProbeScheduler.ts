import type { BallCustodyProjection, TaskItem } from '@cat-cafe/shared';
import { recoveryGuarded } from '../../infrastructure/recovery/recovery-deadline.js';
import { runDueBatch } from '../../infrastructure/recovery/run-due-batch.js';
import { matchesTaskProbeSource, taskProbeSource } from '../cats/services/stores/ports/TaskProbeSource.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { IBallCustodyIngest } from './BallCustodyIngest.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import { buildTaskIdleLongEvent, buildWakeSentEvent } from './ball-custody-events.js';
import { BallProbeRecoveryCensusPending, BallProbeRecoveryConflict } from './ball-probe-recovery-backend.js';
import type { BallRecoveryCandidate, BallRecoveryOutcome, BallRecoveryOwner } from './ball-probe-recovery-state.js';

export interface BallCustodyProbeResult {
  readonly satisfied: boolean;
  readonly reason?: string;
}

export interface BallCustodyProbeEvaluator {
  evaluate(input: { task: TaskItem; projection: BallCustodyProjection }): Promise<BallCustodyProbeResult>;
}

export interface BallCustodyWakeSender {
  send(input: {
    task: TaskItem;
    projection: BallCustodyProjection;
    at: number;
  }): Promise<BallCustodyWakeAdmissionReceipt>;
}

export type BallCustodyWakeAdmissionReceipt =
  | { readonly kind: 'admitted'; readonly messageId: string; readonly outcome: 'enqueued' }
  | {
      readonly kind: 'not_admitted';
      readonly messageId: string;
      readonly reason: 'persisted_message_unavailable' | 'trigger_unavailable' | 'queue_full' | 'invoke_failed';
    };

export interface BallCustodyProbeSchedulerOptions {
  readonly projectionStore: IBallCustodyProjectionStore;
  readonly taskStore: Pick<ITaskStore, 'get' | 'completeProbeIfCurrent'>;
  readonly ballCustody: IBallCustodyIngest;
  readonly probeEvaluator: BallCustodyProbeEvaluator;
  readonly wakeSender: BallCustodyWakeSender;
  readonly now?: () => number;
  readonly wakeCooldownMs?: number;
  readonly idleLongMs?: number;
  readonly logger?: {
    warn?: (obj: unknown, msg?: string) => void;
    error?: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
  };
}

export interface BallCustodyProbeTickResult {
  initializing?: boolean;
  checked: number;
  completed: number;
  woken: number;
  idleMarked: number;
  cooldownSkipped: number;
  skipped: number;
  failed: number;
}

const DEFAULT_IDLE_LONG_MS = 30 * 24 * 60 * 60 * 1000;
const IDLE_LONG_STATES = new Set(['active', 'blocked', 'parked', 'void']);

interface ProbeContext {
  candidate: BallRecoveryCandidate;
  owner?: BallRecoveryOwner;
}

export class BallCustodyProbeScheduler {
  private readonly now: () => number;
  private readonly idleLongMs: number;
  constructor(private readonly opts: BallCustodyProbeSchedulerOptions) {
    this.opts = recoveryGuarded(opts);
    this.now = opts.now ?? Date.now;
    this.idleLongMs = opts.idleLongMs ?? DEFAULT_IDLE_LONG_MS;
  }
  async tick(): Promise<BallCustodyProbeTickResult> {
    const result: BallCustodyProbeTickResult = {
      checked: 0,
      completed: 0,
      woken: 0,
      idleMarked: 0,
      cooldownSkipped: 0,
      skipped: 0,
      failed: 0,
    };
    try {
      await this.tickReady(result, this.now());
    } catch (error) {
      if (!(error instanceof BallProbeRecoveryCensusPending)) throw error;
      result.initializing = true;
    }
    return result;
  }

  private async tickReady(result: BallCustodyProbeTickResult, now: number): Promise<void> {
    const contexts = new Map<BallRecoveryCandidate, ProbeContext>();
    await runDueBatch({
      limit: 200,
      budgetMs: 5_000,
      selectDue: async () => {
        const idle = await this.opts.projectionStore.listIdleRecoveryCandidates(100, now - this.idleLongMs, now);
        const probe = await this.opts.projectionStore.listProbeRecoveryCandidates(100, now);
        const bySubject = new Map(idle.map((candidate) => [candidate.subjectKey, candidate]));
        for (const candidate of probe)
          if (!bySubject.has(candidate.subjectKey)) bySubject.set(candidate.subjectKey, candidate);
        return [...bySubject.values()];
      },
      process: async (candidate) => {
        const context: ProbeContext = { candidate };
        contexts.set(candidate, context);
        const outcome = await this.processSubject(context, result, now);
        await this.opts.projectionStore.finishRecovery(context.candidate, outcome, now, context.owner);
      },
      onItemError: async (candidate, err) => {
        if (err instanceof BallProbeRecoveryConflict) {
          result.skipped++;
          return;
        }
        result.failed++;
        const context = contexts.get(candidate) ?? { candidate };
        await this.opts.projectionStore.finishRecovery(context.candidate, 'retryable_error', now, context.owner);
        this.opts.logger?.warn?.({ err, subjectKey: candidate.subjectKey }, 'ball-custody recovery item failed');
      },
    });
    await runDueBatch({
      limit: 100,
      budgetMs: 5_000,
      selectDue: (limit) => this.opts.projectionStore.listWakeAudits(limit, now),
      process: async ({ subjectKey, audit }) => {
        if (!(await this.opts.ballCustody.recordConfirmed?.(structuredClone(audit.event))))
          throw new Error('wake_event_exact_confirmation_unavailable');
        await this.opts.projectionStore.finishWakeAudit(subjectKey, audit, true, now);
      },
      onItemError: async ({ subjectKey, audit }, err) => {
        result.failed++;
        await this.opts.projectionStore.finishWakeAudit(subjectKey, audit, false, now);
        this.opts.logger?.warn?.({ err, subjectKey, eventId: audit.key }, 'ball-custody exact wake audit deferred');
      },
    });
  }

  private async processSubject(
    context: ProbeContext,
    result: BallCustodyProbeTickResult,
    at: number,
  ): Promise<BallRecoveryOutcome> {
    const { candidate } = context;
    const taskId = candidate.subjectKey.startsWith('ball:task:') ? candidate.subjectKey.slice('ball:task:'.length) : '';
    const projection = await this.opts.projectionStore.get(candidate.subjectKey);
    if (!taskId || !projection || projection.subjectKey !== candidate.subjectKey) {
      result.skipped++;
      return 'permanent_error';
    }
    const task = await this.opts.taskStore.get(taskId);
    if (task && task.id !== taskId) {
      result.skipped++;
      return 'permanent_error';
    }
    if (task?.userId && task.threadId) context.owner = { taskId, userId: task.userId, threadId: task.threadId };
    if (candidate.lane === 'idle') {
      if (!this.shouldMarkIdleLong(projection, at)) return 'stale';
      const claimed = await this.opts.projectionStore.claimIdleIntent(candidate, at);
      if (!claimed || claimed.intentAt === undefined) return 'stale';
      context.candidate = claimed;
      if (!(await this.opts.ballCustody.recordConfirmed?.(buildTaskIdleLongEvent({ taskId, at: claimed.intentAt }))))
        throw new Error('idle_event_exact_confirmation_unavailable');
      result.idleMarked++;
      return 'settled';
    }
    if (projection.state !== 'blocked') return 'stale';
    // Idle-long is an independent, higher-priority duty. Its retry/park cannot start a business probe.
    if (this.shouldMarkIdleLong(projection, at)) return 'waiting';
    if (!task) {
      result.skipped++;
      return 'permanent_error';
    }
    if (task.status !== 'blocked') {
      result.skipped++;
      return 'settled';
    }
    if (!task.probe || (task.resolveMode !== 'bounces_back' && task.resolveMode !== 'completes')) {
      result.skipped++;
      return 'waiting';
    }
    if (typeof projection.lastWakeAt === 'number') {
      result.cooldownSkipped++;
      return 'settled';
    }
    const source = taskProbeSource(task);
    result.checked++;
    const probe = await this.opts.probeEvaluator.evaluate({ task, projection });
    if (!probe.satisfied) return 'waiting';
    if (task.resolveMode === 'completes') {
      if (!(await this.opts.taskStore.completeProbeIfCurrent(task.id, source))) return 'stale';
      result.completed++;
      return 'settled';
    }
    const current = await this.opts.taskStore.get(task.id);
    if (!current || !matchesTaskProbeSource(current, source)) return 'stale';
    const admission = await this.opts.wakeSender.send({ task: current, projection, at });
    if (admission.kind !== 'admitted') {
      if (admission.reason === 'queue_full') return 'waiting';
      throw new Error(`ball_wake_admission_${admission.reason}`);
    }
    result.woken++;
    const event = buildWakeSentEvent({
      taskId: current.id,
      threadId: current.threadId,
      ownerCatId: current.ownerCatId,
      blockedSinceAt: projection.blockedSinceAt ?? projection.lastStateChangeAt,
      at,
    });
    if (!(await this.opts.projectionStore.recordWakeReceipt(candidate, { messageId: admission.messageId, event })))
      return 'stale';
    return 'settled';
  }

  private shouldMarkIdleLong(projection: BallCustodyProjection, at: number): boolean {
    return IDLE_LONG_STATES.has(projection.state) && at - projection.lastEventAt >= this.idleLongMs;
  }
}
