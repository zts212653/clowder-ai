import { compareReevalCycles, isLaterReevalCycle } from './reeval-case-cycle-order.js';
import {
  assertLegacyCaseMigration,
  illegalCaseTransition as illegal,
  projectResponsibilityBlocker,
  requireCaseAutomation as requireAutomation,
  requireCaseRootValue as requireNonEmpty,
  requireCaseOwner as requireOwner,
  TERMINAL_CASE_STATUSES as TERMINAL,
} from './reeval-case-guards.js';
import type { ReevalCaseCycleRoot, ReevalCaseProjection, ReevalCaseRoot } from './reeval-case-types.js';
import { ReevalClosureProjectionError } from './reeval-closure.js';
import {
  EvalLifecycleEventSchema,
  type EvalLifecycleRef,
  type EvalVerdictLifecycleStatus,
} from './reeval-closure-schema.js';

export type { ReevalCaseCycleRoot, ReevalCaseProjection, ReevalCaseRoot } from './reeval-case-types.js';

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
  if (history[0]?.type !== 'verdict_cycle_observed' && history[0]?.type !== 'legacy_case_migrated') {
    throw new ReevalClosureProjectionError(
      'invalid_history',
      'first case event must establish a verdict cycle or legacy migration',
    );
  }

  let status: EvalVerdictLifecycleStatus = 'open';
  let targetOwnerCatId = root.targetOwnerCatId;
  let lifecycleOwnerCatId: string | undefined;
  let activeVerdictId = history[0].verdictId;
  let taskId: string | undefined;
  let leaseId: string | undefined;
  let leaseGeneration: number | undefined;
  let responsibilityBlocker: ReevalCaseProjection['responsibilityBlocker'];
  let mainCommitSha: string | undefined;
  let liveCommitSha: string | undefined;
  let reevalDueAt: string | undefined;
  let reevalAssignedCatId: string | undefined;
  let reevalTaskId: string | undefined;
  let reevalLeaseId: string | undefined;
  let reevalLeaseGeneration: number | undefined;
  let closureReason: string | undefined;
  let escalation: ReevalCaseProjection['escalation'];
  const observedVerdictIds: string[] = [];
  const refs: EvalLifecycleRef[] = [];
  const ownerResponseRefs: EvalLifecycleRef[] = [];
  const planRefs: EvalLifecycleRef[] = [];
  const actionRefs: EvalLifecycleRef[] = [];
  const reevalRefs: EvalLifecycleRef[] = [];

  const resetCycle = (verdictId: string): void => {
    activeVerdictId = verdictId;
    status = cycles.get(verdictId)?.verdict === 'keep_observe' ? 'monitoring' : 'open';
    lifecycleOwnerCatId = undefined;
    taskId = undefined;
    leaseId = undefined;
    leaseGeneration = undefined;
    responsibilityBlocker = undefined;
    mainCommitSha = undefined;
    liveCommitSha = undefined;
    reevalDueAt = undefined;
    reevalAssignedCatId = undefined;
    reevalTaskId = undefined;
    reevalLeaseId = undefined;
    reevalLeaseGeneration = undefined;
    closureReason = undefined;
    escalation = undefined;
    ownerResponseRefs.length = 0;
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
      .filter((cycle): cycle is ReevalCaseCycleRoot => cycle !== undefined)
      .filter((cycle) => isLaterReevalCycle(cycle, activeCycle))
      .sort(compareReevalCycles)[0];
    if (nextCycle) resetCycle(nextCycle.verdictId);
  };
  const isMonitoring = (): boolean => status === 'monitoring';

  for (const event of history) {
    if (event.type === 'legacy_case_migrated') {
      assertLegacyCaseMigration(event, cycles, observedVerdictIds.length > 0);
      observedVerdictIds.push(...event.legacyVerdictIds);
      resetCycle(event.verdictId);
      refs.push(...event.refs);
      if (event.legacyContinuity) {
        ownerResponseRefs.push(...event.legacyContinuity.ownerResponseRefs);
        planRefs.push(...event.legacyContinuity.planRefs);
        actionRefs.push(...event.legacyContinuity.actionRefs);
        reevalRefs.push(...event.legacyContinuity.reevalRefs);
      }
      continue;
    }
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
        resetCycle(event.verdictId);
      } else {
        const activeCycle = cycles.get(activeVerdictId);
        const observedCycle = cycles.get(event.verdictId);
        if (isMonitoring() && activeCycle && observedCycle && isLaterReevalCycle(observedCycle, activeCycle)) {
          resetCycle(event.verdictId);
        } else promoteQueuedCycle();
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
      case 'responsibility_blocked':
        if (status !== 'open' && !(status === 'escalated' && escalation?.stage === 'acknowledgement'))
          illegal(status, event);
        requireAutomation(event);
        if (event.ownerCatId !== targetOwnerCatId) {
          throw new ReevalClosureProjectionError('identity_mismatch', 'responsibility blocker owner is stale');
        }
        responsibilityBlocker = projectResponsibilityBlocker(event);
        break;
      case 'responsibility_bound':
        if (status !== 'open' && !(status === 'escalated' && escalation?.stage === 'acknowledgement'))
          illegal(status, event);
        requireAutomation(event);
        taskId = event.taskId;
        leaseId = event.leaseId;
        leaseGeneration = event.leaseGeneration;
        responsibilityBlocker = undefined;
        lifecycleOwnerCatId = targetOwnerCatId;
        ownerResponseRefs.push(...event.refs);
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
        responsibilityBlocker = undefined;
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
        if (status !== 'live_active' && !isMonitoring()) illegal(status, event);
        const allowed = new Set([lifecycleOwnerCatId, event.assignedEvalCatId].filter(Boolean));
        if (event.actor.kind !== 'cat' || !allowed.has(event.actor.id)) {
          throw new ReevalClosureProjectionError(
            'authority_mismatch',
            'reevaluation requires owner or pinned eval cat',
          );
        }
        reevalDueAt = event.dueAt;
        reevalAssignedCatId = event.assignedEvalCatId;
        reevalTaskId = event.reevalTaskId;
        reevalLeaseId = event.reevalLeaseId;
        reevalLeaseGeneration = event.reevalLeaseGeneration;
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
          const activeCycle = cycles.get(activeVerdictId);
          const hasNewerObservedCycle = observedVerdictIds
            .filter((verdictId) => verdictId !== activeVerdictId)
            .map((verdictId) => cycles.get(verdictId))
            .some(
              (cycle) => cycle !== undefined && activeCycle !== undefined && isLaterReevalCycle(cycle, activeCycle),
            );
          status = hasNewerObservedCycle
            ? 'resolved'
            : activeCycle?.verdict === 'keep_observe'
              ? 'open'
              : 'action_planned';
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
    ...(responsibilityBlocker ? { responsibilityBlocker } : {}),
    ...(mainCommitSha ? { mainCommitSha } : {}),
    ...(liveCommitSha ? { liveCommitSha } : {}),
    ...(activeReeval && reevalDueAt ? { reevalDueAt } : {}),
    ...(reevalAssignedCatId ? { reevalAssignedCatId } : {}),
    ...(reevalTaskId ? { reevalTaskId } : {}),
    ...(reevalLeaseId ? { reevalLeaseId } : {}),
    ...(reevalLeaseGeneration ? { reevalLeaseGeneration } : {}),
    ...(closureReason ? { closureReason } : {}),
    ...(status === 'escalated' && escalation ? { escalation } : {}),
    refs,
    ownerResponseRefs,
    planRefs,
    actionRefs,
    reevalRefs,
    history,
  };
}
