import type { HumanDispositionFeedbackInput } from '@cat-cafe/shared';
import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import { findPendingHoldBallTask } from '../../routes/hold-ball-cancel.js';
import { buildWaitCancellationDispositionLedgerEntry } from '../human-disposition/human-disposition-adapters.js';
import type { WaitTerminationRecord, WaitTerminationStore } from './WaitTerminationStore.js';

export interface WaitTerminationServiceDeps {
  store: WaitTerminationStore;
  dynamicTaskStore: {
    getById(id: string): DynamicTaskDef | null;
    remove(id: string): boolean;
  };
  taskRunner: {
    reserveOnceCancellation(
      id: string,
    ): { outcome: 'reserved'; token: number } | { outcome: 'execution_started' | 'cancellation_pending' | 'not_found' };
    releaseOnceCancellation(id: string, token: number): boolean;
    unregister(id: string): void;
  };
  managedWakeCancellation: {
    reserve(
      waitId: string,
      threadId: string,
      catId: string,
    ): { outcome: 'reserved'; token: number } | { outcome: 'execution_started' | 'cancellation_pending' | 'not_found' };
    commit(waitId: string, threadId: string, catId: string, token: number): boolean;
    release(waitId: string, threadId: string, catId: string, token: number): boolean;
    cancelIfTaskMatches(waitId: string, threadId: string, catId: string): boolean;
  };
  threadStore: {
    get(threadId: string): { createdBy: string } | null | Promise<{ createdBy: string } | null>;
  };
  now?: () => number;
}

interface CancellationReservation {
  onceToken: number;
  managedToken?: number;
}

type CancellationReservationAttempt =
  | { outcome: 'reserved'; reservation: CancellationReservation }
  | { outcome: 'conflict' | 'execution_started' };

export type UserCancelWaitOutcome = 'applied' | 'replay' | 'conflict' | 'execution_started' | 'forbidden' | 'not_found';

export interface UserCancelWaitResult {
  outcome: UserCancelWaitOutcome;
  record?: WaitTerminationRecord;
  projectionPending?: boolean;
}

function ownerCatId(task: DynamicTaskDef): string | null {
  const prefix = 'hold-ball:';
  return task.createdBy.startsWith(prefix) ? task.createdBy.slice(prefix.length) || null : null;
}

export class WaitTerminationService {
  private readonly now: () => number;

  constructor(private readonly deps: WaitTerminationServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async cancelByUser(input: {
    waitId: string;
    ownerUserId: string;
    feedback?: HumanDispositionFeedbackInput;
  }): Promise<UserCancelWaitResult> {
    const existing = await this.deps.store.getByWaitId(input.waitId);
    if (existing) return this.cancelExisting(input, existing);

    const task = findPendingHoldBallTask(input.waitId, this.deps.dynamicTaskStore);
    const threadId = task?.deliveryThreadId;
    const catId = task ? ownerCatId(task) : null;
    if (!task || !threadId || !catId) return { outcome: 'not_found' };
    const thread = await this.deps.threadStore.get(threadId);
    if (!thread || thread.createdBy !== input.ownerUserId) return { outcome: 'forbidden' };

    const attempt = this.reserveCancellation(task.id, threadId, catId);
    if (attempt.outcome !== 'reserved') return { outcome: attempt.outcome };

    try {
      return await this.commitCancellation(task, threadId, catId, input, attempt.reservation);
    } catch (error) {
      await this.reconcileFailedCommitReservation(task.id, threadId, catId, attempt.reservation);
      throw error;
    }
  }

  private reserveCancellation(waitId: string, threadId: string, catId: string): CancellationReservationAttempt {
    const onceReservation = this.deps.taskRunner.reserveOnceCancellation(waitId);
    if (onceReservation.outcome === 'execution_started') return { outcome: 'execution_started' };
    if (onceReservation.outcome !== 'reserved') return { outcome: 'conflict' };

    const managedReservation = this.deps.managedWakeCancellation.reserve(waitId, threadId, catId);
    if (managedReservation.outcome === 'execution_started') {
      this.deps.taskRunner.releaseOnceCancellation(waitId, onceReservation.token);
      return { outcome: 'execution_started' };
    }
    if (managedReservation.outcome === 'cancellation_pending') {
      this.deps.taskRunner.releaseOnceCancellation(waitId, onceReservation.token);
      return { outcome: 'conflict' };
    }
    return {
      outcome: 'reserved',
      reservation: {
        onceToken: onceReservation.token,
        ...(managedReservation.outcome === 'reserved' ? { managedToken: managedReservation.token } : {}),
      },
    };
  }

  private async commitCancellation(
    task: DynamicTaskDef,
    threadId: string,
    catId: string,
    input: {
      waitId: string;
      ownerUserId: string;
      feedback?: HumanDispositionFeedbackInput;
    },
    reservation: CancellationReservation,
  ): Promise<UserCancelWaitResult> {
    const record = this.newRecord(task.id, threadId, catId, input.ownerUserId, input.feedback);
    let outcome = await this.deps.store.commit(record);
    let canonical = record;
    if (outcome === 'conflict') {
      const concurrent = await this.deps.store.getByWaitId(input.waitId);
      if (!concurrent) {
        this.releaseReservation(task.id, threadId, catId, reservation);
        return { outcome };
      }
      if (concurrent.event.ownerUserId !== input.ownerUserId) {
        this.cleanupProjection(task.id, threadId, catId, reservation.managedToken);
        return { outcome };
      }
      canonical = concurrent;
      outcome = await this.deps.store.commit(this.withFeedback(concurrent, input.feedback));
    }
    if (outcome === 'conflict') {
      this.cleanupProjection(task.id, threadId, catId, reservation.managedToken);
      return { outcome, record: canonical };
    }
    return {
      outcome,
      record: canonical,
      ...(this.cleanupProjection(task.id, threadId, catId, reservation.managedToken)
        ? {}
        : { projectionPending: true }),
    };
  }

  private async cancelExisting(
    input: {
      waitId: string;
      ownerUserId: string;
      feedback?: HumanDispositionFeedbackInput;
    },
    existing: WaitTerminationRecord,
  ): Promise<UserCancelWaitResult> {
    if (existing.event.ownerUserId !== input.ownerUserId) return { outcome: 'forbidden' };
    const outcome = await this.deps.store.commit(this.withFeedback(existing, input.feedback));
    return {
      outcome,
      record: existing,
      ...(this.cleanupProjection(input.waitId, existing.event.threadId, existing.event.ownerCatId)
        ? {}
        : { projectionPending: true }),
    };
  }

  async recoverExecutionProjections(): Promise<number> {
    let recovered = 0;
    for (const record of await this.deps.store.listRecords()) {
      if (!findPendingHoldBallTask(record.event.waitId, this.deps.dynamicTaskStore)) continue;
      if (this.cleanupProjection(record.event.waitId, record.event.threadId, record.event.ownerCatId)) {
        recovered += 1;
      }
    }
    return recovered;
  }

  private newRecord(
    waitId: string,
    threadId: string,
    catId: string,
    ownerUserId: string,
    feedback: HumanDispositionFeedbackInput | undefined,
  ): WaitTerminationRecord {
    const at = this.now();
    const event = {
      v: 1 as const,
      eventId: `wait-termination:hold_ball:${waitId}:user_cancel`,
      kind: 'wait.terminated' as const,
      waitId,
      waitKind: 'hold_ball' as const,
      generation: 1,
      subjectRef: `wait:hold_ball:${waitId}`,
      threadId,
      ownerUserId,
      ownerCatId: catId,
      reason: 'user_cancel' as const,
      actor: { kind: 'user' as const, userId: ownerUserId },
      at,
    };
    return {
      event,
      entry: buildWaitCancellationDispositionLedgerEntry({ event, ...(feedback ? { feedback } : {}) }),
    };
  }

  private withFeedback(
    existing: WaitTerminationRecord,
    feedback: HumanDispositionFeedbackInput | undefined,
  ): WaitTerminationRecord {
    return {
      event: existing.event,
      entry: buildWaitCancellationDispositionLedgerEntry({
        event: existing.event,
        ...(feedback ? { feedback } : {}),
      }),
    };
  }

  private cleanupProjection(waitId: string, threadId: string, catId: string, managedToken?: number): boolean {
    const task = findPendingHoldBallTask(waitId, this.deps.dynamicTaskStore);
    if (!task) return true;
    try {
      if (managedToken === undefined) {
        this.deps.managedWakeCancellation.cancelIfTaskMatches(waitId, threadId, catId);
      } else {
        this.deps.managedWakeCancellation.commit(waitId, threadId, catId, managedToken);
      }
      this.deps.taskRunner.unregister(waitId);
      return this.deps.dynamicTaskStore.remove(waitId);
    } catch {
      return false;
    }
  }

  private releaseReservation(
    waitId: string,
    threadId: string,
    catId: string,
    reservation: CancellationReservation,
  ): void {
    this.deps.taskRunner.releaseOnceCancellation(waitId, reservation.onceToken);
    if (reservation.managedToken !== undefined) {
      this.deps.managedWakeCancellation.release(waitId, threadId, catId, reservation.managedToken);
    }
  }

  private async reconcileFailedCommitReservation(
    waitId: string,
    threadId: string,
    catId: string,
    reservation: CancellationReservation,
  ): Promise<void> {
    let durable: WaitTerminationRecord | null;
    try {
      durable = await this.deps.store.getByWaitId(waitId);
    } catch {
      // Ambiguous storage failure: keep the transient fence until restart rather
      // than risk waking after a commit that may actually have succeeded.
      return;
    }
    if (durable) {
      this.cleanupProjection(waitId, durable.event.threadId, durable.event.ownerCatId, reservation.managedToken);
      return;
    }
    this.releaseReservation(waitId, threadId, catId, reservation);
  }
}
