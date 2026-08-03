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

export interface ReevalCaseResponsibilityContext {
  systemThreadId: string;
  featureId: string;
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

export class ReevalCaseResponsibilityService {
  private readonly now: () => string;

  constructor(private readonly options: ReevalCaseResponsibilityServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async reconcile(
    subject: ReevalCaseReconcileSubject,
    context: ReevalCaseResponsibilityContext,
  ): Promise<ReevalCaseResponsibilityResult> {
    requireNonEmpty(context.systemThreadId, 'systemThreadId');
    requireNonEmpty(context.featureId, 'featureId');
    requireNonEmpty(context.evalCatId, 'evalCatId');
    const projection = projectReevalCase(subject.caseRoot, subject.events);
    if (
      projection.status !== 'open' &&
      !(projection.status === 'escalated' && projection.escalation?.stage === 'acknowledgement')
    ) {
      return { outcome: 'not_open' };
    }
    if (subject.assignedEvalCatId !== context.evalCatId) {
      throw new Error('responsibility binding eval cat does not match the trusted domain assignment');
    }
    const root = subject.roots.find((candidate) => candidate.verdictId === projection.activeVerdictId);
    if (!root) throw new Error(`active verdict root unavailable: ${projection.activeVerdictId}`);
    if (root.ownerAsk.targetFeatureId !== context.featureId || root.harnessUnderEval.featureId !== context.featureId) {
      throw new Error('responsibility binding feature does not match the immutable verdict root');
    }

    const targetThreadId = await this.options.resolveFeatureThreadId(context.featureId, this.options.ownerUserId);
    requireNonEmpty(targetThreadId, 'featureThreadId');
    const subjectKey = `eval-case:${subject.caseRoot.caseId}:cycle:${projection.activeVerdictId}`;
    const task = await this.options.taskStore.upsertBySubject({
      threadId: targetThreadId,
      title: `Eval case ${root.findingKey}: ${root.ownerAsk.requestedAction}`,
      why: `F266 stable case ${subject.caseRoot.caseId}; actionable verdict ${projection.activeVerdictId}`,
      createdBy: createCatId(context.evalCatId),
      kind: 'work',
      subjectKey,
      ownerCatId: createCatId(root.ownerAsk.targetOwnerCatId),
      userId: this.options.ownerUserId,
      relatedFeatureId: context.featureId,
    });
    if (task.status === 'done') throw new Error('active eval case cannot bind a completed cycle task');
    if (
      task.ownerCatId !== root.ownerAsk.targetOwnerCatId ||
      task.threadId !== targetThreadId ||
      task.userId !== this.options.ownerUserId
    ) {
      throw new Error('persisted task does not match immutable verdict responsibility');
    }

    const occurredAt = this.now();
    const admission = await this.options.admissionService.admit({
      tenantScope: this.options.ownerUserId,
      actorCatId: context.evalCatId,
      sourceThreadId: context.systemThreadId,
      targetThreadId,
      holderCatIds: [root.ownerAsk.targetOwnerCatId],
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
