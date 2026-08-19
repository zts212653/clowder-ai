import { createCatId, type TaskItem } from '@cat-cafe/shared';
import type { ActionSuccessorAdmissionService } from '../../domains/ball-custody/ActionSuccessorAdmissionService.js';
import type { ActionSuccessorLease } from '../../domains/ball-custody/action-successor-state-machine.js';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import { projectReevalCase } from './reeval-case.js';
import { isLaterReevalCycle } from './reeval-case-cycle-order.js';
import type { ReevalCaseResponsibilityContext } from './reeval-case-responsibility.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';
import type { ReevalCaseReconcileSubject } from './reeval-closure-reconciler.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

export interface ReevalCaseReevaluationServiceOptions {
  taskStore: Pick<ITaskStore, 'get' | 'getBySubject' | 'upsertBySubject' | 'update'>;
  eventLog: Pick<IReevalClosureEventLog, 'append'>;
  admissionService: Pick<ActionSuccessorAdmissionService, 'admit'>;
  ownerUserId: string;
  now?: () => string;
}

export type ReevalCaseReevaluationResult =
  | { outcome: 'requested' | 'duplicate'; task: TaskItem; lease: ActionSuccessorLease }
  | { outcome: 'settled'; taskIds: string[] }
  | { outcome: 'not_due' }
  | { outcome: 'conflict'; actualSequence: number };

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
    throw new Error('re-evaluation lease does not match persisted task responsibility');
  }
}

function dueRoot(subject: ReevalCaseReconcileSubject, now: string) {
  if (subject.events.length === 0) return undefined;
  const projection = projectReevalCase(subject.caseRoot, subject.events);
  if (projection.status !== 'live_active' && projection.status !== 'monitoring') return undefined;
  const root = subject.roots.find((candidate) => candidate.verdictId === projection.activeVerdictId);
  if (!root || Date.parse(now) < Date.parse(root.acceptanceReevalPlan.nextEvalAt)) return undefined;
  return { projection, root };
}

function isLaterCycle(
  subject: ReevalCaseReconcileSubject,
  candidateVerdictId: string,
  baselineVerdictId: string,
): boolean {
  const candidate = subject.caseRoot.cycles.find((cycle) => cycle.verdictId === candidateVerdictId);
  const baseline = subject.caseRoot.cycles.find((cycle) => cycle.verdictId === baselineVerdictId);
  return Boolean(candidate && baseline && isLaterReevalCycle(candidate, baseline));
}

function settledTaskIds(subject: ReevalCaseReconcileSubject): string[] {
  const taskIds = new Set<string>();
  for (let index = 0; index < subject.events.length; index += 1) {
    const result = subject.events[index];
    if (result?.type !== 'reeval_passed' && result?.type !== 'reeval_failed') continue;
    const request = findLastBefore(
      subject.events,
      index,
      (event) => event.type === 'reeval_requested' && event.verdictId === result.verdictId,
    );
    if (request?.type === 'reeval_requested' && request.reevalTaskId) {
      taskIds.add(request.reevalTaskId);
    }
    const laterCycleExists = subject.events
      .slice(0, index)
      .some(
        (event) => event.type === 'verdict_cycle_observed' && isLaterCycle(subject, event.verdictId, result.verdictId),
      );
    if (result.type === 'reeval_passed' || laterCycleExists) {
      const responsibility = findLastBefore(
        subject.events,
        index,
        (event) => event.type === 'responsibility_bound' && event.verdictId === result.verdictId,
      );
      if (responsibility?.type === 'responsibility_bound') taskIds.add(responsibility.taskId);
    }
  }
  return [...taskIds];
}

function findLastBefore(
  events: readonly EvalLifecycleEvent[],
  beforeIndex: number,
  predicate: (event: EvalLifecycleEvent) => boolean,
): EvalLifecycleEvent | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) return event;
  }
  return undefined;
}

async function settlePendingTasks(
  taskStore: ReevalCaseReevaluationServiceOptions['taskStore'],
  taskIds: readonly string[],
): Promise<string[]> {
  const taskStates = await Promise.all(taskIds.map((taskId) => taskStore.get(taskId)));
  const unsettled = taskIds.filter((_taskId, index) => taskStates[index]?.status !== 'done');
  for (const taskId of unsettled) {
    const task = await taskStore.update(taskId, { status: 'done' });
    if (!task) throw new Error(`re-evaluation settlement task unavailable: ${taskId}`);
  }
  return unsettled;
}

function requireReevaluationContext(
  subject: ReevalCaseReconcileSubject,
  context: ReevalCaseResponsibilityContext,
): void {
  if (!context.systemThreadId.trim() || !context.evalCatId.trim()) {
    throw new Error('re-evaluation responsibility requires system thread and eval cat');
  }
  if (subject.assignedEvalCatId !== context.evalCatId) {
    throw new Error('re-evaluation task owner does not match the trusted domain assignment');
  }
}

function requireReevaluationSla(subject: ReevalCaseReconcileSubject): number {
  const hours = subject.caseRoot.reevalWithinHours;
  if (!Number.isInteger(hours) || (hours ?? 0) <= 0) {
    throw new Error('re-evaluation SLA must be a positive integer');
  }
  return hours ?? 0;
}

export class ReevalCaseReevaluationService {
  private readonly now: () => string;

  constructor(private readonly options: ReevalCaseReevaluationServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async needsReconcile(subject: ReevalCaseReconcileSubject, now: string): Promise<boolean> {
    if (dueRoot(subject, now) !== undefined) return true;
    for (const taskId of settledTaskIds(subject)) {
      if ((await this.options.taskStore.get(taskId))?.status !== 'done') return true;
    }
    return false;
  }

  async reconcile(
    subject: ReevalCaseReconcileSubject,
    context: ReevalCaseResponsibilityContext,
  ): Promise<ReevalCaseReevaluationResult> {
    const occurredAt = this.now();
    const settled = await settlePendingTasks(this.options.taskStore, settledTaskIds(subject));
    if (settled.length > 0) return { outcome: 'settled', taskIds: settled };
    const due = dueRoot(subject, occurredAt);
    if (!due) return { outcome: 'not_due' };
    requireReevaluationContext(subject, context);
    const subjectKey = `eval-case:${subject.caseRoot.caseId}:cycle:${due.root.verdictId}:reeval`;
    const task = await this.options.taskStore.upsertBySubject({
      threadId: context.systemThreadId,
      title: `Re-evaluate ${due.root.findingKey}: ${due.root.acceptanceReevalPlan.closureCondition}`,
      why: `F266 nextEvalAt reached for stable case ${subject.caseRoot.caseId}`,
      createdBy: createCatId(context.evalCatId),
      kind: 'work',
      subjectKey,
      ownerCatId: createCatId(context.evalCatId),
      userId: this.options.ownerUserId,
      relatedFeatureId: context.featureId,
    });
    if (
      task.ownerCatId !== context.evalCatId ||
      task.threadId !== context.systemThreadId ||
      task.userId !== this.options.ownerUserId
    ) {
      throw new Error('persisted re-evaluation task does not match trusted eval responsibility');
    }
    const admission = await this.options.admissionService.admit({
      tenantScope: this.options.ownerUserId,
      actorCatId: context.evalCatId,
      sourceThreadId: context.systemThreadId,
      targetThreadId: context.systemThreadId,
      holderCatIds: [context.evalCatId],
      dispatchId: `f266:${subject.caseRoot.caseId}:${due.root.verdictId}:reeval`,
      evidenceRef: `eval-verdict:${due.root.verdictId}:nextEvalAt`,
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
    if (!('lease' in admission)) throw new Error(`re-evaluation admission rejected: ${admission.outcome}`);
    const lease = admission.lease;
    requireMatchingLease(lease, task, this.options.ownerUserId);
    const activeTask =
      task.status === 'doing' ? task : await this.options.taskStore.update(task.id, { status: 'doing' });
    if (!activeTask) throw new Error(`failed to activate re-evaluation task ${task.id}`);
    const reevalWithinHours = requireReevaluationSla(subject);
    const dueAt = new Date(Date.parse(occurredAt) + reevalWithinHours * 3_600_000).toISOString();
    const append = await this.options.eventLog.append(
      {
        eventId: `f266:${subject.caseRoot.caseId}:cycle:${due.root.verdictId}:reeval:${due.root.acceptanceReevalPlan.nextEvalAt}`,
        caseId: subject.caseRoot.caseId,
        verdictId: due.root.verdictId,
        domainId: subject.caseRoot.domainId,
        type: 'reeval_requested',
        actor: { kind: 'cat', id: context.evalCatId },
        occurredAt,
        dueAt,
        assignedEvalCatId: context.evalCatId,
        reevalTaskId: activeTask.id,
        reevalLeaseId: lease.leaseId,
        reevalLeaseGeneration: lease.generation,
        reason: 'nextEvalAt produced durable re-evaluation work and active F167 custody',
        refs: [
          { kind: 'task', availability: 'available', value: `task:${activeTask.id}` },
          { kind: 'other', availability: 'available', value: `action-successor:${lease.leaseId}:${lease.generation}` },
        ],
      },
      subject.events.length,
    );
    if (append.outcome === 'conflict') return append;
    return { outcome: append.outcome === 'duplicate' ? 'duplicate' : 'requested', task: activeTask, lease };
  }
}
