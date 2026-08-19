import { createCatId, type TaskItem } from '@cat-cafe/shared';
import type {
  ActionSuccessorAdmissionResult,
  ActionSuccessorAdmissionService,
} from '../../domains/ball-custody/ActionSuccessorAdmissionService.js';
import type { ActionSuccessorLease } from '../../domains/ball-custody/action-successor-state-machine.js';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import { projectReevalCase } from './reeval-case.js';
import type { IReevalClosureEventLog, ReevalClosureAppendResult } from './reeval-closure-event-log.js';
import type { ReevalCaseReconcileSubject } from './reeval-closure-reconciler.js';

type FeatureThreadBlocker = {
  code: 'feature_thread_not_found' | 'feature_thread_ambiguous';
  featureId: string;
  candidateThreadIds: string[];
};

export interface ReevalCaseResponsibilityContext {
  systemThreadId: string;
  featureId: string;
  ownerCatId?: string;
  evalCatId: string;
}

export interface ReevalCaseResponsibilityServiceOptions {
  taskStore: Pick<ITaskStore, 'getBySubject' | 'upsertBySubject' | 'update'>;
  eventLog: Pick<IReevalClosureEventLog, 'append'>;
  admissionService: Pick<ActionSuccessorAdmissionService, 'admit'>;
  resolveFeatureThreadId: (featureId: string, ownerUserId: string) => Promise<string>;
  ownerUserId: string;
  now?: () => string;
}

export type ReevalCaseResponsibilityResult =
  | {
      outcome: 'bound' | 'duplicate';
      task: TaskItem;
      lease: ActionSuccessorLease;
      append: Exclude<ReevalClosureAppendResult, { outcome: 'conflict' }>;
    }
  | { outcome: 'conflict'; task: TaskItem; lease: ActionSuccessorLease; actualSequence: number }
  | { outcome: 'blocked'; append: ReevalClosureAppendResult }
  | { outcome: 'not_open' };

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
}

function requireMatchingLease(lease: ActionSuccessorLease, task: TaskItem, ownerUserId: string): void {
  if (
    lease.status !== 'active' ||
    lease.subjectRef !== `subject:task:${task.id}` ||
    lease.actionFamily !== 'implement' ||
    lease.successorSlot !== 'implementer' ||
    lease.holderCatIds.length !== 1 ||
    lease.holderCatIds[0] !== task.ownerCatId ||
    lease.holderThreadId !== task.threadId ||
    lease.tenantScope !== ownerUserId ||
    lease.terminalPredicate?.kind !== 'task_done'
  ) {
    throw new Error('lease does not match persisted task responsibility');
  }
}

function leaseFromAdmission(result: ActionSuccessorAdmissionResult): ActionSuccessorLease {
  if (!('lease' in result)) throw new Error(`responsibility admission rejected: ${result.outcome}`);
  return result.lease;
}

function caseAcceptsResponsibility(projection: ReturnType<typeof projectReevalCase>): boolean {
  return (
    projection.status === 'open' ||
    (projection.status === 'escalated' && projection.escalation?.stage === 'acknowledgement')
  );
}

function featureThreadBlocker(error: unknown, expectedFeatureId: string): FeatureThreadBlocker | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as Record<string, unknown>;
  const normalizedFeatureId = expectedFeatureId.trim().toUpperCase();
  if (
    (candidate.code !== 'feature_thread_not_found' && candidate.code !== 'feature_thread_ambiguous') ||
    typeof candidate.featureId !== 'string' ||
    candidate.featureId.trim().toUpperCase() !== normalizedFeatureId ||
    !Array.isArray(candidate.candidateThreadIds) ||
    !candidate.candidateThreadIds.every((value) => typeof value === 'string' && value.length > 0)
  ) {
    return undefined;
  }
  return {
    code: candidate.code,
    featureId: candidate.featureId,
    candidateThreadIds: [...new Set(candidate.candidateThreadIds)].sort(),
  };
}

export class ReevalCaseResponsibilityService {
  private readonly now: () => string;

  constructor(private readonly options: ReevalCaseResponsibilityServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async resolveTargetThread(
    subject: ReevalCaseReconcileSubject,
    projection: ReturnType<typeof projectReevalCase>,
    featureId: string,
    ownerCatId: string,
  ): Promise<string | Extract<ReevalCaseResponsibilityResult, { outcome: 'blocked' }>> {
    try {
      return await this.options.resolveFeatureThreadId(featureId, this.options.ownerUserId);
    } catch (error) {
      const blocker = featureThreadBlocker(error, featureId);
      if (!blocker) throw error;
      const candidates = blocker.candidateThreadIds.join(',') || 'none';
      const append = await this.options.eventLog.append(
        {
          eventId: `f266:${subject.caseRoot.caseId}:cycle:${projection.activeVerdictId}:responsibility-blocked:${blocker.code}:${candidates}`,
          caseId: subject.caseRoot.caseId,
          verdictId: projection.activeVerdictId,
          domainId: subject.caseRoot.domainId,
          type: 'responsibility_blocked',
          actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
          occurredAt: this.now(),
          reason: 'feature-thread truth cannot yet bind durable responsibility; retry when routing truth changes',
          refs: [
            {
              kind: 'other',
              availability: 'available',
              value: `feature-thread-resolution:${blocker.featureId}:${blocker.code}:${candidates}`,
            },
          ],
          reasonCode: blocker.code,
          featureId: blocker.featureId,
          ownerCatId,
          candidateThreadIds: blocker.candidateThreadIds,
        },
        subject.events.length,
      );
      return { outcome: 'blocked', append };
    }
  }

  async reconcile(
    subject: ReevalCaseReconcileSubject,
    context: ReevalCaseResponsibilityContext,
  ): Promise<ReevalCaseResponsibilityResult> {
    requireNonEmpty(context.systemThreadId, 'systemThreadId');
    requireNonEmpty(context.featureId, 'featureId');
    requireNonEmpty(context.evalCatId, 'evalCatId');
    const ownerCatId = context.ownerCatId ?? subject.caseRoot.targetOwnerCatId;
    requireNonEmpty(ownerCatId, 'ownerCatId');
    const projection = projectReevalCase(subject.caseRoot, subject.events);
    if (!caseAcceptsResponsibility(projection)) return { outcome: 'not_open' };
    if (subject.assignedEvalCatId !== context.evalCatId) {
      throw new Error('responsibility binding eval cat does not match the trusted domain assignment');
    }
    const root = subject.roots.find((candidate) => candidate.verdictId === projection.activeVerdictId);
    if (!root) throw new Error(`active verdict root unavailable: ${projection.activeVerdictId}`);
    if (root.ownerAsk.targetFeatureId !== context.featureId || root.harnessUnderEval.featureId !== context.featureId) {
      throw new Error('responsibility binding feature does not match the immutable verdict root');
    }

    const resolution = await this.resolveTargetThread(subject, projection, context.featureId, ownerCatId);
    if (typeof resolution !== 'string') return resolution;
    const targetThreadId = resolution;
    requireNonEmpty(targetThreadId, 'featureThreadId');
    const subjectKey = `eval-case:${subject.caseRoot.caseId}:cycle:${projection.activeVerdictId}`;
    const task = await this.options.taskStore.upsertBySubject({
      threadId: targetThreadId,
      title: `Eval case ${root.findingKey}: ${root.ownerAsk.requestedAction}`,
      why: `F266 stable case ${subject.caseRoot.caseId}; actionable verdict ${projection.activeVerdictId}`,
      createdBy: createCatId(context.evalCatId),
      kind: 'work',
      subjectKey,
      ownerCatId: createCatId(ownerCatId),
      userId: this.options.ownerUserId,
      relatedFeatureId: context.featureId,
    });
    if (task.status === 'done') throw new Error('active eval case cannot bind a completed cycle task');
    if (
      task.ownerCatId !== ownerCatId ||
      task.threadId !== targetThreadId ||
      task.userId !== this.options.ownerUserId
    ) {
      throw new Error('persisted task does not match current feature-owner responsibility');
    }

    const occurredAt = this.now();
    const admission = await this.options.admissionService.admit({
      tenantScope: this.options.ownerUserId,
      actorCatId: context.evalCatId,
      sourceThreadId: context.systemThreadId,
      targetThreadId,
      holderCatIds: [ownerCatId],
      dispatchId: `f266:${subject.caseRoot.caseId}:${projection.activeVerdictId}:responsibility`,
      evidenceRef: `eval-verdict:${projection.activeVerdictId}`,
      now: Date.parse(occurredAt),
      action: {
        subjectRef: `subject:task:${task.id}`,
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        claimOrigin: 'structured_transfer',
        terminalPredicate: { kind: 'task_done' },
      },
    });
    const lease = leaseFromAdmission(admission);
    requireMatchingLease(lease, task, this.options.ownerUserId);
    const activeTask =
      task.status === 'doing' ? task : await this.options.taskStore.update(task.id, { status: 'doing' });
    if (!activeTask) throw new Error(`failed to activate responsibility task ${task.id}`);

    const event = {
      eventId: `f266:${subject.caseRoot.caseId}:cycle:${projection.activeVerdictId}:responsibility`,
      caseId: subject.caseRoot.caseId,
      verdictId: projection.activeVerdictId,
      domainId: subject.caseRoot.domainId,
      type: 'responsibility_bound' as const,
      actor: { kind: 'automation' as const, id: 'eval-verdict-closure-reconciler' },
      occurredAt,
      reason: 'durable task and F167 action-successor lease bind executable responsibility',
      refs: [
        { kind: 'task' as const, availability: 'available' as const, value: `task:${activeTask.id}` },
        {
          kind: 'other' as const,
          availability: 'available' as const,
          value: `action-successor:${lease.leaseId}:${lease.generation}`,
        },
      ],
      taskId: activeTask.id,
      leaseId: lease.leaseId,
      leaseGeneration: lease.generation,
    };
    const append = await this.options.eventLog.append(event, subject.events.length);
    if (append.outcome === 'conflict') {
      return { outcome: 'conflict', task: activeTask, lease, actualSequence: append.actualSequence };
    }
    return { outcome: append.outcome === 'duplicate' ? 'duplicate' : 'bound', task: activeTask, lease, append };
  }
}
