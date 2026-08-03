import { ReevalClosureProjectionError } from './reeval-closure.js';
import {
  type EvalLifecycleEvent,
  EvalLifecycleEventSchema,
  type EvalLifecycleRef,
  type EvalVerdictLifecycleStatus,
} from './reeval-closure-schema.js';

export interface ReevalCaseCycleRoot {
  verdictId: string;
  createdAt: string;
  verdict: 'delete_sunset' | 'build' | 'fix' | 'keep_observe';
}

export interface ReevalCaseRoot {
  caseId: string;
  domainId: string;
  targetOwnerCatId: string;
  assignedEvalCatId?: string;
  reevalWithinHours?: number;
  cycles: readonly ReevalCaseCycleRoot[];
}

export interface ReevalCaseProjection {
  caseId: string;
  domainId: string;
  status: EvalVerdictLifecycleStatus;
  sequence: number;
  targetOwnerCatId: string;
  lifecycleOwnerCatId?: string;
  activeVerdictId: string;
  observedVerdictIds: readonly string[];
  taskId?: string;
  leaseId?: string;
  leaseGeneration?: number;
  mainCommitSha?: string;
  liveCommitSha?: string;
  reevalDueAt?: string;
  reevalAssignedCatId?: string;
  closureReason?: string;
  escalation?: { eventId: string; stage: 'acknowledgement' | 'reevaluation'; dueAt: string };
  refs: readonly EvalLifecycleRef[];
  planRefs: readonly EvalLifecycleRef[];
  actionRefs: readonly EvalLifecycleRef[];
  reevalRefs: readonly EvalLifecycleRef[];
  history: readonly EvalLifecycleEvent[];
}

const TERMINAL = new Set<EvalVerdictLifecycleStatus>(['resolved', 'suppressed_with_reason']);

function requireNonEmpty(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new ReevalClosureProjectionError('invalid_root', `case root ${field} must be non-empty`);
  return value;
}

function requireOwner(event: EvalLifecycleEvent, ownerCatId: string | undefined): void {
  if (!ownerCatId || event.actor.kind !== 'cat' || event.actor.id !== ownerCatId) {
    throw new ReevalClosureProjectionError(
      'authority_mismatch',
      `${event.type} actor must match active lifecycle owner ${ownerCatId ?? 'unavailable'}`,
    );
  }
}

function illegal(status: EvalVerdictLifecycleStatus, event: EvalLifecycleEvent): never {
  throw new ReevalClosureProjectionError(
    'illegal_transition',
    `illegal transition: ${event.type} cannot follow ${status}`,
  );
}

function requireAutomation(event: EvalLifecycleEvent): void {
  if (event.actor.kind !== 'automation' && event.actor.kind !== 'migration') {
    throw new ReevalClosureProjectionError('authority_mismatch', `${event.type} requires automation or migration`);
  }
}

export function projectReevalCase(root: ReevalCaseRoot, rawEvents: readonly unknown[]): ReevalCaseProjection {
  requireNonEmpty(root.caseId, 'caseId');
  requireNonEmpty(root.domainId, 'domainId');
  requireNonEmpty(root.targetOwnerCatId, 'targetOwnerCatId');
  if (root.assignedEvalCatId !== undefined) requireNonEmpty(root.assignedEvalCatId, 'assignedEvalCatId');
  if (root.cycles.length === 0)
    throw new ReevalClosureProjectionError('invalid_root', 'case root cycles must be non-empty');
  const cycles = new Map(root.cycles.map((cycle) => [cycle.verdictId, cycle]));
  if (cycles.size !== root.cycles.length) {
    throw new ReevalClosureProjectionError('invalid_root', 'case root verdict cycles must be unique');
  }

  const history = rawEvents.map((rawEvent, index) => {
    const parsed = EvalLifecycleEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
      throw new ReevalClosureProjectionError(
        'invalid_event',
        `invalid case lifecycle event ${index}: ${parsed.error.message}`,
      );
    }
    const event = parsed.data;
    if (event.caseId !== root.caseId || event.domainId !== root.domainId) {
      throw new ReevalClosureProjectionError(
        'identity_mismatch',
        `event ${index} does not belong to case ${root.caseId}`,
      );
    }
    if (!cycles.has(event.verdictId)) {
      throw new ReevalClosureProjectionError(
        'identity_mismatch',
        `event ${index} uses unregistered cycle ${event.verdictId}`,
      );
    }
    return event;
  });
  if (history[0]?.type !== 'verdict_cycle_observed') {
    throw new ReevalClosureProjectionError('invalid_history', 'first case event must be verdict_cycle_observed');
  }

  let status: EvalVerdictLifecycleStatus = 'open';
  let targetOwnerCatId = root.targetOwnerCatId;
  let lifecycleOwnerCatId: string | undefined;
  let activeVerdictId = history[0].verdictId;
  let taskId: string | undefined;
  let leaseId: string | undefined;
  let leaseGeneration: number | undefined;
  let mainCommitSha: string | undefined;
  let liveCommitSha: string | undefined;
  let reevalDueAt: string | undefined;
  let reevalAssignedCatId: string | undefined;
  let closureReason: string | undefined;
  let escalation: ReevalCaseProjection['escalation'];
  const observedVerdictIds: string[] = [];
  const refs: EvalLifecycleRef[] = [];
  const planRefs: EvalLifecycleRef[] = [];
  const actionRefs: EvalLifecycleRef[] = [];
  const reevalRefs: EvalLifecycleRef[] = [];

  const resetCycle = (verdictId: string): void => {
    activeVerdictId = verdictId;
    status = 'open';
    lifecycleOwnerCatId = undefined;
    taskId = undefined;
    leaseId = undefined;
    leaseGeneration = undefined;
    mainCommitSha = undefined;
    liveCommitSha = undefined;
    reevalDueAt = undefined;
    reevalAssignedCatId = undefined;
    closureReason = undefined;
    escalation = undefined;
    planRefs.length = 0;
    actionRefs.length = 0;
    reevalRefs.length = 0;
  };

  const promoteQueuedCycle = (): void => {
    if (!TERMINAL.has(status)) return;
    const activeCycle = cycles.get(activeVerdictId);
    if (!activeCycle) return;
    const nextCycle = observedVerdictIds
      .filter((verdictId) => verdictId !== activeVerdictId)
      .map((verdictId) => cycles.get(verdictId))
      .filter((cycle): cycle is ReevalCaseCycleRoot => cycle !== undefined && cycle.verdict !== 'keep_observe')
      .filter(
        (cycle) =>
          cycle.createdAt > activeCycle.createdAt ||
          (cycle.createdAt === activeCycle.createdAt && cycle.verdictId > activeCycle.verdictId),
      )
      .sort(
        (left, right) => left.createdAt.localeCompare(right.createdAt) || left.verdictId.localeCompare(right.verdictId),
      )[0];
    if (nextCycle) resetCycle(nextCycle.verdictId);
  };

  for (const event of history) {
    if (event.type === 'verdict_cycle_observed') {
      requireAutomation(event);
      if (cycles.get(event.verdictId)?.createdAt !== event.cycleCreatedAt) {
        throw new ReevalClosureProjectionError(
          'identity_mismatch',
          'cycle observation does not match immutable root time',
        );
      }
      if (observedVerdictIds.includes(event.verdictId)) {
        throw new ReevalClosureProjectionError('invalid_history', `cycle ${event.verdictId} was observed twice`);
      }
      observedVerdictIds.push(event.verdictId);
      refs.push(...event.refs);
      if (observedVerdictIds.length === 1) {
        activeVerdictId = event.verdictId;
      } else {
        promoteQueuedCycle();
      }
      continue;
    }

    if (event.verdictId !== activeVerdictId) {
      throw new ReevalClosureProjectionError(
        'identity_mismatch',
        `${event.type} targets ${event.verdictId}, but active cycle is ${activeVerdictId}`,
      );
    }
    if (TERMINAL.has(status)) {
      throw new ReevalClosureProjectionError(
        'terminal_history',
        `${event.type} cannot follow terminal status ${status}`,
      );
    }
    refs.push(...event.refs);

    switch (event.type) {
      case 'responsibility_bound':
        if (status !== 'open' && !(status === 'escalated' && escalation?.stage === 'acknowledgement'))
          illegal(status, event);
        requireAutomation(event);
        taskId = event.taskId;
        leaseId = event.leaseId;
        leaseGeneration = event.leaseGeneration;
        lifecycleOwnerCatId = targetOwnerCatId;
        status = 'acknowledged';
        break;
      case 'owner_reassigned': {
        const currentOwner = lifecycleOwnerCatId ?? targetOwnerCatId;
        if (event.actor.kind !== 'cvo' && !(event.actor.kind === 'cat' && event.actor.id === currentOwner)) {
          throw new ReevalClosureProjectionError(
            'authority_mismatch',
            'owner reassignment requires current owner or operator',
          );
        }
        if (leaseId)
          throw new ReevalClosureProjectionError(
            'illegal_transition',
            'active custody must be released before reassignment',
          );
        targetOwnerCatId = event.targetOwnerCatId;
        break;
      }
      case 'action_planned':
        if (status !== 'acknowledged' && status !== 'action_planned') illegal(status, event);
        requireOwner(event, lifecycleOwnerCatId);
        planRefs.push(...event.refs);
        status = 'action_planned';
        break;
      case 'main_landed':
        if (status !== 'action_planned') illegal(status, event);
        requireOwner(event, lifecycleOwnerCatId);
        mainCommitSha = event.commitSha;
        actionRefs.push(...event.refs);
        status = 'main_landed';
        break;
      case 'live_active':
        if (status !== 'main_landed') illegal(status, event);
        requireOwner(event, lifecycleOwnerCatId);
        if (event.commitSha !== mainCommitSha) {
          throw new ReevalClosureProjectionError('identity_mismatch', 'live_active must verify the same main commit');
        }
        liveCommitSha = event.commitSha;
        actionRefs.push(...event.refs);
        status = 'live_active';
        break;
      case 'reeval_requested': {
        if (status !== 'live_active') illegal(status, event);
        const allowed = new Set([lifecycleOwnerCatId, event.assignedEvalCatId].filter(Boolean));
        if (event.actor.kind !== 'cat' || !allowed.has(event.actor.id)) {
          throw new ReevalClosureProjectionError(
            'authority_mismatch',
            'reevaluation requires owner or pinned eval cat',
          );
        }
        reevalDueAt = event.dueAt;
        reevalAssignedCatId = event.assignedEvalCatId;
        reevalRefs.push(...event.refs);
        status = 'reeval_pending';
        break;
      }
      case 'reeval_passed':
      case 'reeval_failed': {
        if (status !== 'reeval_pending' && !(status === 'escalated' && escalation?.stage === 'reevaluation')) {
          illegal(status, event);
        }
        const assigned = reevalAssignedCatId ?? event.assignedEvalCatId ?? root.assignedEvalCatId;
        if (event.assignedEvalCatId !== assigned || event.actor.kind !== 'cat' || event.actor.id !== assigned) {
          throw new ReevalClosureProjectionError(
            'authority_mismatch',
            'reevaluation result requires the pinned eval cat',
          );
        }
        reevalRefs.push(...event.refs);
        reevalDueAt = undefined;
        escalation = undefined;
        if (event.type === 'reeval_passed') {
          closureReason = event.reason;
          status = 'resolved';
        } else {
          status = 'action_planned';
        }
        break;
      }
      case 'cvo_suppressed':
        if (event.actor.kind !== 'cvo') {
          throw new ReevalClosureProjectionError('authority_mismatch', 'suppression requires operator');
        }
        closureReason = event.reason;
        status = 'suppressed_with_reason';
        break;
      case 'sla_escalated':
        requireAutomation(event);
        if (
          (status === 'open' && event.stage !== 'acknowledgement') ||
          (status === 'reeval_pending' && event.stage !== 'reevaluation') ||
          (status !== 'open' && status !== 'reeval_pending')
        ) {
          illegal(status, event);
        }
        escalation = { eventId: event.eventId, stage: event.stage, dueAt: event.dueAt };
        status = 'escalated';
        break;
      default:
        illegal(status, event);
    }
    promoteQueuedCycle();
  }

  const activeReeval = status === 'reeval_pending' || (status === 'escalated' && escalation?.stage === 'reevaluation');
  return {
    caseId: root.caseId,
    domainId: root.domainId,
    status,
    sequence: history.length,
    targetOwnerCatId,
    ...(lifecycleOwnerCatId ? { lifecycleOwnerCatId } : {}),
    activeVerdictId,
    observedVerdictIds,
    ...(taskId ? { taskId } : {}),
    ...(leaseId ? { leaseId } : {}),
    ...(leaseGeneration ? { leaseGeneration } : {}),
    ...(mainCommitSha ? { mainCommitSha } : {}),
    ...(liveCommitSha ? { liveCommitSha } : {}),
    ...(activeReeval && reevalDueAt ? { reevalDueAt } : {}),
    ...(reevalAssignedCatId ? { reevalAssignedCatId } : {}),
    ...(closureReason ? { closureReason } : {}),
    ...(status === 'escalated' && escalation ? { escalation } : {}),
    refs,
    planRefs,
    actionRefs,
    reevalRefs,
    history,
  };
}
