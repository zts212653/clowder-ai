import type { CatId, CycleEvaluationSubmission, CycleRecord, CycleTracePage } from '@cat-cafe/shared';
import { cycleAcceptsEvaluationWriteback } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { DeliverOpts, ScheduleInvokeTrigger } from '../../scheduler/types.js';
import { ensureEvalDomainThreads } from '../hub/eval-hub-thread-ensure.js';
import { buildCycleAssignment, formatCycleAssignment, MAX_CYCLE_ASSIGNMENT_BYTES } from './CycleEvaluationContent.js';
import {
  CycleEvaluationDelivery,
  cycleEvaluationThreadId,
  resolveCycleWakeReceipt,
} from './CycleEvaluationDelivery.js';
import { CycleEvaluationEvidence } from './CycleEvaluationEvidence.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';

export const CYCLE_WRITEBACK_TIMEOUT_MS = 30 * 60 * 1000;
export const HARNESS_CYCLE_ALERT_THREAD_ID = 'thread_eval_harness_ledger';

export interface CycleEvaluationPrincipal {
  userId: string;
  catId: string;
  threadId: string;
}

export class CycleEvaluationCoordinator {
  private readonly now: () => number;
  private readonly evidence: CycleEvaluationEvidence;
  private readonly delivery: CycleEvaluationDelivery;
  private writtenHandler?: (record: CycleRecord) => void | Promise<void>;

  constructor(
    private readonly deps: {
      runtime: ObjectiveEvaluationRuntime;
      threadStore: IThreadStore;
      /** `getById` reads a wake's durable Queue custody: the only source of its delivery receipt. */
      messageStore: Pick<IMessageStore, 'getByIds' | 'getById'>;
      deliver: (input: DeliverOpts) => Promise<string>;
      getInvokeTrigger: () => ScheduleInvokeTrigger | null;
      getDefaultCatId: () => CatId;
      now?: () => number;
      log?: { warn: (value: unknown, message?: string) => void };
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.evidence = new CycleEvaluationEvidence(deps.runtime, deps.messageStore);
    this.delivery = new CycleEvaluationDelivery(deps);
    deps.runtime.cycleChecker.setRequestedHandler((record) => {
      void this.ensureAssignment(record).catch((error) =>
        this.deps.log?.warn({ err: error, cycleId: record.cycleId }, '[F257] cycle assignment delivery failed'),
      );
    });
  }

  static threadIdFor(objectiveId: string): string {
    return cycleEvaluationThreadId(objectiveId);
  }

  setWrittenHandler(handler: (record: CycleRecord) => void | Promise<void>): void {
    this.writtenHandler = handler;
  }

  async ensureAssignment(record: CycleRecord): Promise<void> {
    if (record.evalStatus !== 'requested' || record.assignedAt !== undefined) return;
    const thread = await this.ensureObjectiveThread(record.objectiveId, record.ownerUserId);
    const history = await this.deps.runtime.cycles.history(
      record.ownerUserId,
      record.objectiveId,
      Math.max(0, record.windows.length - 1),
    );
    const assignment = await buildCycleAssignment(
      { catalog: this.deps.runtime.catalog, annotations: this.deps.runtime.annotations, history },
      record,
    );
    const content = formatCycleAssignment(record, assignment);
    if (Buffer.byteLength(content) > MAX_CYCLE_ASSIGNMENT_BYTES) throw new Error('cycle_assignment_exceeds_limit');
    const messageId = await this.delivery.deliverWake(record, thread.threadId, thread.catId, content, 'assignment');
    const current = await this.deps.runtime.cycles.current(record.ownerUserId, record.objectiveId);
    if (!current || current.cycleId !== record.cycleId || current.evalStatus !== 'requested') return;
    // A caller holding a stale record arrives after the assignment was recorded: it changes nothing.
    if (current.assignedAt !== undefined) return;
    await this.deps.runtime.cycles.transition(current, {
      ...current,
      assignmentThreadId: thread.threadId,
      assignmentMessageId: messageId,
      assignedAt: this.now(),
      pendingWakeMessageId: messageId,
    });
  }

  async reconcileKnownCycles(now: number): Promise<void> {
    for (const ownerUserId of await this.deps.runtime.cycles.ownerUserIds()) {
      for (const objective of this.deps.runtime.catalog.registry.objectives) {
        if (objective.lifecycle === 'retired') continue;
        try {
          await this.reconcileCycle(ownerUserId, objective.id, now);
        } catch (error) {
          this.deps.log?.warn(
            { err: error, ownerUserId, objectiveId: objective.id },
            '[F257] cycle delivery reconciliation failed',
          );
        }
      }
    }
  }

  private async reconcileCycle(ownerUserId: string, objectiveId: string, now: number): Promise<void> {
    let record = await this.deps.runtime.cycles.current(ownerUserId, objectiveId);
    if (!record) return;
    if (record.evalStatus !== 'requested' && record.evalStatus !== 'retriggered') return;
    if (record.evalStatus === 'requested' && record.assignedAt === undefined) {
      await this.ensureAssignment(record);
      record = (await this.deps.runtime.cycles.current(ownerUserId, objectiveId)) ?? record;
    }
    if (record.pendingWakeMessageId !== undefined) {
      await this.settlePendingWake(record, now);
      return;
    }
    if (record.evalStatus === 'requested') {
      if (
        record.evalStatus === 'requested' &&
        record.assignedAt !== undefined &&
        now >= record.assignedAt + CYCLE_WRITEBACK_TIMEOUT_MS
      ) {
        await this.retrigger(record, now);
      }
      return;
    }
    if (
      record.evalStatus === 'retriggered' &&
      record.retriggeredAt !== undefined &&
      now >= record.retriggeredAt + CYCLE_WRITEBACK_TIMEOUT_MS
    ) {
      await this.stall(record, now);
    }
  }

  async readTraces(
    principal: CycleEvaluationPrincipal,
    input: { objectiveId: string; cycleId: string; cursor: number; limit: number },
  ): Promise<CycleTracePage> {
    const record = await this.requireActiveCycle(principal, input.objectiveId, input.cycleId);
    return this.evidence.read(record, input);
  }

  async submitEvaluation(principal: CycleEvaluationPrincipal, input: CycleEvaluationSubmission) {
    const record = await this.findSubmissionCycle(principal, input.objectiveId, input.cycleId);
    if (record.evaluation) {
      if (sameSubmission(record.evaluation, input, principal.catId)) {
        await this.notifyWritten(record);
        return { outcome: 'already_written', cycleId: record.cycleId, evalStatus: 'written' };
      }
      throw new Error(`cycle_evaluation_conflict:${record.cycleId}`);
    }
    // A closed record without an evaluation was terminated by an operator
    // version transition; its cycleId still resolves from history, but the
    // evaluation it never received cannot land on the successor cycle.
    if (record.closedAt !== undefined || !cycleAcceptsEvaluationWriteback(record.evalStatus)) {
      throw new Error(`cycle_evaluation_not_active:${record.cycleId}`);
    }
    await this.evidence.validateSubmission(record, input);
    const evaluation: NonNullable<CycleRecord['evaluation']> = {
      metrics: structuredClone(input.metrics),
      overall: input.overall,
      counterexampleRootCauses: structuredClone(input.counterexampleRootCauses),
      coverageAssessment: structuredClone(input.coverageAssessment),
      writtenAt: this.now(),
      by: principal.catId,
    };
    // A writeback settles the cycle whichever wake produced it; a retrigger
    // that is still queued has nothing left to time.
    const { pendingWakeMessageId: _settledWake, ...settled } = record;
    if (input.overall === 'insufficient_evidence') {
      const completed = { ...settled, evalStatus: 'written' as const, evaluation, closedAt: evaluation.writtenAt };
      const next = await this.deps.runtime.cycles.advance(record, completed, {
        version: record.version,
        versionContentRef: record.versionContentRef,
      });
      if (next)
        return {
          outcome: 'written',
          cycleId: record.cycleId,
          evalStatus: 'written',
          nextCycleId: next.cycleId,
          // The successor is only the container for the next accumulation window. A bare
          // id reads as "an assignment is already pending delivery", which made evaluators
          // hold and escalate a missing delivery that was never due. State it explicitly:
          // the successor is idle, and its assignment is pushed once its own trigger fires.
          nextCycleStatus: next.evalStatus,
          nextAssignmentPending: next.evalStatus === 'requested',
        };
    } else if (await this.deps.runtime.cycles.transition(record, { ...settled, evalStatus: 'written', evaluation })) {
      await this.notifyWritten({ ...settled, evalStatus: 'written', evaluation });
      return { outcome: 'written', cycleId: record.cycleId, evalStatus: 'written' };
    }
    const stored =
      (await this.deps.runtime.cycles.current(record.ownerUserId, record.objectiveId))?.cycleId === record.cycleId
        ? await this.deps.runtime.cycles.current(record.ownerUserId, record.objectiveId)
        : await this.deps.runtime.cycles.historyCycle(record.ownerUserId, record.objectiveId, record.cycleId);
    if (stored?.evaluation && sameSubmission(stored.evaluation, input, principal.catId)) {
      return { outcome: 'already_written', cycleId: record.cycleId, evalStatus: 'written' };
    }
    throw new Error(`cycle_evaluation_conflict:${record.cycleId}`);
  }

  private async retrigger(record: CycleRecord, now: number): Promise<void> {
    const thread = await this.ensureObjectiveThread(record.objectiveId, record.ownerUserId);
    const content = [
      '## F257 Cycle Evaluation Retrigger',
      '',
      `Cycle \`${record.cycleId}\` has no structured evaluation writeback after 30 minutes.`,
      'Read the assignment above and call cat_cafe_submit_cycle_evaluation. This is the only automatic retry.',
    ].join('\n');
    const messageId = await this.delivery.deliverWake(record, thread.threadId, thread.catId, content, 'retrigger');
    const current = await this.deps.runtime.cycles.current(record.ownerUserId, record.objectiveId);
    if (!current || current.cycleId !== record.cycleId || current.evalStatus !== 'requested') return;
    await this.deps.runtime.cycles.transition(current, {
      ...current,
      evalStatus: 'retriggered',
      retriggerMessageId: messageId,
      retriggeredAt: now,
      pendingWakeMessageId: messageId,
    });
  }

  /**
   * A sent wake has given the evaluator no time until its delivery receipt
   * exists, so nothing advances while the receipt is pending. The phase window
   * then starts at the receipt's own time — the same value whichever process
   * observes it, however late. A wake that can never be delivered starts the
   * bounded retry clock now instead of freezing the cycle. The CAS keeps either
   * from overwriting a writeback that landed meanwhile.
   */
  private async settlePendingWake(record: CycleRecord, now: number): Promise<void> {
    const messageId = record.pendingWakeMessageId;
    if (messageId === undefined) return;
    const receipt = resolveCycleWakeReceipt(await this.deps.messageStore.getById(messageId));
    if (receipt.state === 'pending') return;
    const startedAt = receipt.state === 'delivered' ? receipt.deliveredAt : now;
    const { pendingWakeMessageId: _settled, ...rest } = record;
    await this.deps.runtime.cycles.transition(
      record,
      record.evalStatus === 'requested' ? { ...rest, assignedAt: startedAt } : { ...rest, retriggeredAt: startedAt },
    );
  }

  private async stall(record: CycleRecord, now: number): Promise<void> {
    const alertThreadId = HARNESS_CYCLE_ALERT_THREAD_ID;
    await ensureEvalDomainThreads(
      this.deps.threadStore,
      [{ domainId: 'eval:harness-ledger', systemThreadId: alertThreadId, displayName: 'Harness Ledger Alerts' }],
      record.ownerUserId,
    );
    const messageId = await this.deps.deliver({
      threadId: alertThreadId,
      userId: record.ownerUserId,
      idempotencyKey: this.delivery.idempotencyKey(record, 'stalled'),
      content: [
        '## F257 Cycle Evaluation Stalled',
        '',
        `Objective: \`${record.objectiveId}\``,
        `Cycle: \`${record.cycleId}\``,
        `Evaluation thread: \`${CycleEvaluationCoordinator.threadIdFor(record.objectiveId)}\``,
        'The one bounded retrigger also received no structured writeback. Automatic retries have stopped.',
        'A late writeback is still accepted: continue in the evaluation thread (read the pool, submit the evaluation).',
        'Or an operator can end this cycle by switching or creating a segment version; the next cycle starts there.',
      ].join('\n'),
    });
    const current = await this.deps.runtime.cycles.current(record.ownerUserId, record.objectiveId);
    if (!current || current.cycleId !== record.cycleId || current.evalStatus !== 'retriggered') return;
    await this.deps.runtime.cycles.transition(current, {
      ...current,
      evalStatus: 'stalled',
      stalledAlertMessageId: messageId,
      stalledAt: now,
    });
  }

  ensureObjectiveThread(objectiveId: string, ownerUserId: string): Promise<{ threadId: string; catId: CatId }> {
    return this.delivery.ensureObjectiveThread(objectiveId, ownerUserId);
  }

  async deliverAndWake(
    record: CycleRecord,
    threadId: string,
    catId: CatId,
    content: string,
    kind: string,
  ): Promise<string> {
    return this.delivery.deliverWake(record, threadId, catId, content, kind);
  }

  private async notifyWritten(record: CycleRecord): Promise<void> {
    if (!this.writtenHandler) return;
    try {
      await this.writtenHandler(record);
    } catch (error) {
      this.deps.log?.warn({ err: error, cycleId: record.cycleId }, '[F257] governance assignment delivery failed');
    }
  }

  private async requireActiveCycle(
    principal: CycleEvaluationPrincipal,
    objectiveId: string,
    cycleId: string,
  ): Promise<CycleRecord> {
    const threadId = CycleEvaluationCoordinator.threadIdFor(objectiveId);
    if (principal.threadId !== threadId) throw new Error(`cycle_evaluation_principal_mismatch:${cycleId}`);
    const record = await this.deps.runtime.cycles.current(principal.userId, objectiveId);
    if (!record || record.cycleId !== cycleId) throw new Error(`cycle_evaluation_not_found:${cycleId}`);
    if (!cycleAcceptsEvaluationWriteback(record.evalStatus)) throw new Error(`cycle_evaluation_not_active:${cycleId}`);
    return record;
  }

  private async findSubmissionCycle(
    principal: CycleEvaluationPrincipal,
    objectiveId: string,
    cycleId: string,
  ): Promise<CycleRecord> {
    const threadId = CycleEvaluationCoordinator.threadIdFor(objectiveId);
    if (principal.threadId !== threadId) throw new Error(`cycle_evaluation_principal_mismatch:${cycleId}`);
    const current = await this.deps.runtime.cycles.current(principal.userId, objectiveId);
    if (current?.cycleId === cycleId) return current;
    const history = await this.deps.runtime.cycles.historyCycle(principal.userId, objectiveId, cycleId);
    if (history) return history;
    throw new Error(`cycle_evaluation_not_found:${cycleId}`);
  }
}

function sameSubmission(
  evaluation: NonNullable<CycleRecord['evaluation']>,
  input: CycleEvaluationSubmission,
  catId: string,
): boolean {
  return (
    evaluation.by === catId &&
    evaluation.overall === input.overall &&
    JSON.stringify(evaluation.metrics) === JSON.stringify(input.metrics) &&
    JSON.stringify(evaluation.counterexampleRootCauses) === JSON.stringify(input.counterexampleRootCauses) &&
    JSON.stringify(evaluation.coverageAssessment) === JSON.stringify(input.coverageAssessment)
  );
}
