import type { CatId, CycleEvaluationSubmission, CycleRecord, CycleTracePage } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { DeliverOpts, ScheduleInvokeTrigger } from '../../scheduler/types.js';
import { ensureEvalDomainThreads } from '../hub/eval-hub-thread-ensure.js';
import { buildCycleAssignment, formatCycleAssignment, MAX_CYCLE_ASSIGNMENT_BYTES } from './CycleEvaluationContent.js';
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
  private writtenHandler?: (record: CycleRecord) => void | Promise<void>;

  constructor(
    private readonly deps: {
      runtime: ObjectiveEvaluationRuntime;
      threadStore: IThreadStore;
      messageStore: Pick<IMessageStore, 'getByIds'>;
      deliver: (input: DeliverOpts) => Promise<string>;
      getInvokeTrigger: () => ScheduleInvokeTrigger | null;
      getDefaultCatId: () => CatId;
      now?: () => number;
      log?: { warn: (value: unknown, message?: string) => void };
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.evidence = new CycleEvaluationEvidence(deps.runtime, deps.messageStore);
    deps.runtime.cycleChecker.setRequestedHandler((record) => {
      void this.ensureAssignment(record).catch((error) =>
        this.deps.log?.warn({ err: error, cycleId: record.cycleId }, '[F257] cycle assignment delivery failed'),
      );
    });
  }

  static threadIdFor(objectiveId: string): string {
    return `thread_eval_f257_${objectiveId}`;
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
    const messageId = await this.deliverAndWake(record, thread.threadId, thread.catId, content, 'assignment');
    const current = await this.deps.runtime.cycles.current(record.ownerUserId, record.objectiveId);
    if (!current || current.cycleId !== record.cycleId || current.evalStatus !== 'requested') return;
    await this.deps.runtime.cycles.transition(current, {
      ...current,
      assignmentThreadId: thread.threadId,
      assignmentMessageId: messageId,
      assignedAt: this.now(),
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
    if (record.evalStatus === 'requested') {
      if (record.assignedAt === undefined) await this.ensureAssignment(record);
      record = (await this.deps.runtime.cycles.current(ownerUserId, objectiveId)) ?? record;
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
    if (record.evalStatus !== 'requested' && record.evalStatus !== 'retriggered') {
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
    if (input.overall === 'insufficient_evidence') {
      const completed = { ...record, evalStatus: 'written' as const, evaluation, closedAt: evaluation.writtenAt };
      const next = await this.deps.runtime.cycles.advance(record, completed, {
        version: record.version,
        versionContentRef: record.versionContentRef,
      });
      if (next)
        return { outcome: 'written', cycleId: record.cycleId, evalStatus: 'written', nextCycleId: next.cycleId };
    } else if (await this.deps.runtime.cycles.transition(record, { ...record, evalStatus: 'written', evaluation })) {
      await this.notifyWritten({ ...record, evalStatus: 'written', evaluation });
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
    const messageId = await this.deliverAndWake(record, thread.threadId, thread.catId, content, 'retrigger');
    const current = await this.deps.runtime.cycles.current(record.ownerUserId, record.objectiveId);
    if (!current || current.cycleId !== record.cycleId || current.evalStatus !== 'requested') return;
    await this.deps.runtime.cycles.transition(current, {
      ...current,
      evalStatus: 'retriggered',
      retriggerMessageId: messageId,
      retriggeredAt: now,
    });
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
      idempotencyKey: this.idempotencyKey(record, 'stalled'),
      content: [
        '## F257 Cycle Evaluation Stalled',
        '',
        `Objective: \`${record.objectiveId}\``,
        `Cycle: \`${record.cycleId}\``,
        `Evaluation thread: \`${CycleEvaluationCoordinator.threadIdFor(record.objectiveId)}\``,
        'The one bounded retrigger also received no structured writeback. Automatic retries have stopped.',
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

  async ensureObjectiveThread(objectiveId: string, ownerUserId: string): Promise<{ threadId: string; catId: CatId }> {
    const objective = this.deps.runtime.catalog.registry.objectives.find((item) => item.id === objectiveId);
    if (!objective) throw new Error(`cycle_objective_not_found:${objectiveId}`);
    if (objective.lifecycle === 'retired') throw new Error(`cycle_objective_retired:${objectiveId}`);
    const threadId = CycleEvaluationCoordinator.threadIdFor(objectiveId);
    await ensureEvalDomainThreads(
      this.deps.threadStore,
      [
        {
          domainId: `f257:${objectiveId}`,
          systemThreadId: threadId,
          displayName: `Harness Objective · ${objective.label}`,
        },
      ],
      ownerUserId,
    );
    const existing = await this.deps.threadStore.get(threadId);
    if (!existing) throw new Error(`cycle_evaluation_thread_missing:${threadId}`);
    const catId = existing.preferredCats?.[0] ?? this.deps.getDefaultCatId();
    if (!existing.preferredCats?.length) await this.deps.threadStore.updatePreferredCats(threadId, [catId]);
    await this.deps.threadStore.addParticipants(threadId, [catId]);
    return { threadId, catId };
  }

  async deliverAndWake(
    record: CycleRecord,
    threadId: string,
    catId: CatId,
    content: string,
    kind: string,
  ): Promise<string> {
    const messageId = await this.deps.deliver({
      threadId,
      userId: record.ownerUserId,
      content,
      idempotencyKey: this.idempotencyKey(record, kind),
    });
    const trigger = this.deps.getInvokeTrigger();
    if (!trigger) throw new Error('cycle_invoke_trigger_unavailable');
    const outcome = await trigger.trigger(
      threadId,
      catId,
      record.ownerUserId,
      `F257 cycle ${kind}: ${record.cycleId}`,
      messageId,
    );
    if (outcome === 'full') throw new Error('cycle_invocation_queue_full');
    return messageId;
  }

  private idempotencyKey(record: CycleRecord, kind: string): string {
    // Reject deliberately re-evaluates the same frozen window under the same
    // cycleId. The rejection count is therefore the delivery generation: it
    // deduplicates retries within one attempt without hiding the next
    // assignment (and its operator-provided rejection reason).
    const generation = record.approval?.rejectCount ?? 0;
    return `f257-cycle:${record.ownerUserId}:${record.cycleId}:${kind}:g${generation}`;
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
    if (record.evalStatus !== 'requested' && record.evalStatus !== 'retriggered') {
      throw new Error(`cycle_evaluation_not_active:${cycleId}`);
    }
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
