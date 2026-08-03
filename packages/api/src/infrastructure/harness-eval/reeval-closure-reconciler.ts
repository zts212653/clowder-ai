import { type LifecycleRootArtifact, LifecycleRootArtifactSchema } from './publish-verdict/lifecycle-root-artifact.js';
import { projectReevalCase, type ReevalCaseRoot } from './reeval-case.js';
import { projectReevalClosure, type ReevalClosureProjection, type ReevalClosureRoot } from './reeval-closure.js';
import { assertLifecycleBootstrapPrefix, buildLifecycleOpenedEvent } from './reeval-closure-bootstrap.js';
import type { EvalLifecycleEvent, EvalLifecycleRef } from './reeval-closure-schema.js';

const RECONCILER_ACTOR = { kind: 'automation', id: 'eval-verdict-closure-reconciler' } as const;

export interface ReevalClosureReconcileSubject {
  root: LifecycleRootArtifact;
  assignedEvalCatId?: string;
  acknowledgeHours: number;
  events: readonly EvalLifecycleEvent[];
  openRefs: readonly EvalLifecycleRef[];
  bootstrapEvents?: readonly EvalLifecycleEvent[];
}

export interface ReevalCaseReconcileSubject {
  caseRoot: ReevalCaseRoot;
  roots: readonly Extract<LifecycleRootArtifact, { schemaVersion: 2 }>[];
  assignedEvalCatId?: string;
  acknowledgeHours: number;
  events: readonly EvalLifecycleEvent[];
  openRefsByVerdictId: ReadonlyMap<string, readonly EvalLifecycleRef[]>;
  responsibilityContext: {
    systemThreadId: string;
    featureId: string;
    evalCatId: string;
  };
}

export type ReevalLifecycleReconcileSubject = ReevalClosureReconcileSubject | ReevalCaseReconcileSubject;

export interface PlannedReevalClosureAppend {
  event: EvalLifecycleEvent;
  expectedSequence: number;
}

function projectorRoot(subject: ReevalClosureReconcileSubject): ReevalClosureRoot {
  return {
    verdictId: subject.root.verdictId,
    domainId: subject.root.domainId,
    targetOwnerCatId: subject.root.ownerAsk.targetOwnerCatId,
    ...(subject.assignedEvalCatId ? { assignedEvalCatId: subject.assignedEvalCatId } : {}),
  };
}

function dueAtAfterHours(createdAt: string, hours: number): string {
  if (!Number.isSafeInteger(hours) || hours <= 0) throw new Error('acknowledgeHours must be a positive integer');
  return new Date(Date.parse(createdAt) + hours * 3_600_000).toISOString();
}

function makeEscalationEvent(
  root: LifecycleRootArtifact,
  stage: 'acknowledgement' | 'reevaluation',
  dueAt: string,
  occurredAt: string,
): EvalLifecycleEvent {
  return {
    eventId: `f266:${root.verdictId}:sla:${stage}:${dueAt}`,
    verdictId: root.verdictId,
    domainId: root.domainId,
    type: 'sla_escalated',
    actor: RECONCILER_ACTOR,
    occurredAt,
    dueAt,
    stage,
    reason: `${stage} SLA elapsed without the required lifecycle evidence`,
    refs: [
      {
        kind: 'sla',
        availability: 'available',
        value: `sla:${root.verdictId}:${stage}:${dueAt}`,
      },
    ],
  };
}

function findDueEscalation(
  root: LifecycleRootArtifact,
  projection: ReevalClosureProjection,
  acknowledgeHours: number,
  now: string,
  nowMs: number,
): EvalLifecycleEvent | undefined {
  if (projection.status === 'open') {
    const dueAt = dueAtAfterHours(root.createdAt, acknowledgeHours);
    return nowMs >= Date.parse(dueAt) ? makeEscalationEvent(root, 'acknowledgement', dueAt, now) : undefined;
  }
  if (projection.status !== 'reeval_pending' || !projection.reevalDueAt) return undefined;
  return nowMs >= Date.parse(projection.reevalDueAt)
    ? makeEscalationEvent(root, 'reevaluation', projection.reevalDueAt, now)
    : undefined;
}

export function planReevalClosureEvents(
  rawSubject: ReevalLifecycleReconcileSubject,
  now: string,
): PlannedReevalClosureAppend[] {
  if ('caseRoot' in rawSubject) return planReevalCaseEvents(rawSubject, now);
  const root = LifecycleRootArtifactSchema.parse(rawSubject.root);
  const subject = { ...rawSubject, root };
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`invalid reconciliation time: ${now}`);

  const planned: PlannedReevalClosureAppend[] = [];
  let workingEvents = [...subject.events];

  if (subject.bootstrapEvents) {
    assertLifecycleBootstrapPrefix(root.verdictId, workingEvents, subject.bootstrapEvents);
    for (let index = workingEvents.length; index < subject.bootstrapEvents.length; index += 1) {
      const event = subject.bootstrapEvents[index];
      planned.push({ event, expectedSequence: index });
      workingEvents.push(event);
    }
  } else if (workingEvents.length === 0) {
    if (root.verdict === 'keep_observe') return [];
    const opened = buildLifecycleOpenedEvent(root, subject.openRefs);
    planned.push({ event: opened, expectedSequence: 0 });
    workingEvents = [opened];
  }

  if (workingEvents.length === 0) return planned;
  const projection = projectReevalClosure(projectorRoot(subject), workingEvents);
  const escalation = findDueEscalation(root, projection, subject.acknowledgeHours, now, nowMs);
  if (escalation) planned.push({ event: escalation, expectedSequence: workingEvents.length });
  return planned;
}

function makeCycleObservedEvent(
  subject: ReevalCaseReconcileSubject,
  root: Extract<LifecycleRootArtifact, { schemaVersion: 2 }>,
  occurredAt: string,
): EvalLifecycleEvent {
  return {
    eventId: `f266:${subject.caseRoot.caseId}:cycle:${root.verdictId}`,
    caseId: subject.caseRoot.caseId,
    verdictId: root.verdictId,
    domainId: root.domainId,
    type: 'verdict_cycle_observed',
    actor: RECONCILER_ACTOR,
    occurredAt,
    cycleCreatedAt: root.createdAt,
    reason: 'immutable verdict cycle attached to its stable finding case',
    refs: [...(subject.openRefsByVerdictId.get(root.verdictId) ?? [])],
  };
}

function makeCaseEscalationEvent(
  subject: ReevalCaseReconcileSubject,
  verdictId: string,
  stage: 'acknowledgement' | 'reevaluation',
  dueAt: string,
  occurredAt: string,
): EvalLifecycleEvent {
  return {
    eventId: `f266:${subject.caseRoot.caseId}:cycle:${verdictId}:sla:${stage}:${dueAt}`,
    caseId: subject.caseRoot.caseId,
    verdictId,
    domainId: subject.caseRoot.domainId,
    type: 'sla_escalated',
    actor: RECONCILER_ACTOR,
    occurredAt,
    dueAt,
    stage,
    reason: `${stage} SLA elapsed without the required stable-case evidence`,
    refs: [
      {
        kind: 'sla',
        availability: 'available',
        value: `sla:${subject.caseRoot.caseId}:${verdictId}:${stage}:${dueAt}`,
      },
    ],
  };
}

function planReevalCaseEvents(subject: ReevalCaseReconcileSubject, now: string): PlannedReevalClosureAppend[] {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`invalid reconciliation time: ${now}`);
  const working = [...subject.events];
  const observed = new Set(
    working.filter((event) => event.type === 'verdict_cycle_observed').map((event) => event.verdictId),
  );
  const planned: PlannedReevalClosureAppend[] = [];
  for (const root of subject.roots) {
    if (observed.has(root.verdictId)) continue;
    if (root.verdict === 'keep_observe') {
      if (working.length === 0) continue;
      const projection = projectReevalCase(subject.caseRoot, working);
      if (projection.status === 'resolved' || projection.status === 'suppressed_with_reason') continue;
    }
    const event = makeCycleObservedEvent(subject, root, now);
    planned.push({ event, expectedSequence: working.length });
    working.push(event);
    observed.add(root.verdictId);
  }
  if (working.length > 0) {
    const projection = projectReevalCase(subject.caseRoot, working);
    const activeRoot = subject.roots.find((root) => root.verdictId === projection.activeVerdictId);
    if (!activeRoot) throw new Error(`active verdict root unavailable: ${projection.activeVerdictId}`);
    const due =
      projection.status === 'open'
        ? { stage: 'acknowledgement' as const, dueAt: dueAtAfterHours(activeRoot.createdAt, subject.acknowledgeHours) }
        : projection.status === 'reeval_pending' && projection.reevalDueAt
          ? { stage: 'reevaluation' as const, dueAt: projection.reevalDueAt }
          : undefined;
    if (due && nowMs >= Date.parse(due.dueAt)) {
      planned.push({
        event: makeCaseEscalationEvent(subject, projection.activeVerdictId, due.stage, due.dueAt, now),
        expectedSequence: working.length,
      });
    }
  }
  return planned;
}
