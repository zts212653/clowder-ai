import type { ActionSuccessorLease } from './action-successor-state-machine.js';

interface OwnerRoute {
  ownerCatId: string;
  ownerThreadId: string;
}

interface DelegateRoute extends OwnerRoute {
  childThreadId: string;
}

type OrphanRecoveryTransition = ActionSuccessorLease['orphanCarrierRecoveryTransitions'][number];

type OrphanRecoveryHistory = Pick<
  ActionSuccessorLease,
  'generation' | 'orphanCarrierRecoveryTransitions' | 'subjectRef'
>;

export function orphanCarrierRecoveryMatchesDelegateLineage(
  transition: OrphanRecoveryTransition,
  route: DelegateRoute,
): boolean {
  return (
    transition.predecessorCatId === route.ownerCatId &&
    transition.predecessorThreadId === route.ownerThreadId &&
    transition.holderThreadId === route.childThreadId
  );
}

export function orphanCarrierRecoveryGenerationMatches(input: {
  lease: OrphanRecoveryHistory;
  route: OwnerRoute;
  generation: number;
  holderCatIds: readonly string[];
  holderThreadId: string;
}): boolean {
  const { lease, route, generation, holderCatIds, holderThreadId } = input;
  return (lease.orphanCarrierRecoveryTransitions ?? []).some(
    (transition) =>
      transition.fromGeneration + 1 === generation &&
      transition.toGeneration === generation &&
      transition.holderThreadId === holderThreadId &&
      holderCatIds.length === 1 &&
      holderCatIds[0] === transition.holderCatId &&
      transition.predecessorCatId === route.ownerCatId &&
      transition.predecessorThreadId === route.ownerThreadId,
  );
}

export function orphanCarrierRecoveryHistoryIsValid(lease: OrphanRecoveryHistory, route: OwnerRoute): boolean {
  const transitions = lease.orphanCarrierRecoveryTransitions ?? [];
  if (transitions.length === 0) return true;
  const taskPrefix = 'subject:task:';
  const taskId = lease.subjectRef?.startsWith(taskPrefix) ? lease.subjectRef.slice(taskPrefix.length) : '';
  return transitions.every((transition) => {
    const dispatchPrefix = transition.predecessorThreadId === transition.holderThreadId ? 'post:' : 'cross-post:';
    return (
      transition.kind === 'orphan_carrier_recovery' &&
      Number.isSafeInteger(transition.fromGeneration) &&
      transition.fromGeneration >= 1 &&
      transition.toGeneration === transition.fromGeneration + 1 &&
      transition.toGeneration <= lease.generation &&
      Boolean(taskId) &&
      transition.taskId === taskId &&
      transition.predecessorCatId === route.ownerCatId &&
      transition.predecessorThreadId === route.ownerThreadId &&
      Boolean(transition.holderCatId.trim()) &&
      Boolean(transition.holderThreadId.trim()) &&
      Number.isSafeInteger(transition.taskRevision) &&
      transition.taskRevision > 0 &&
      Boolean(transition.sourceMessageId.trim()) &&
      transition.fromDispatchId.startsWith(dispatchPrefix) &&
      transition.toDispatchId.startsWith(dispatchPrefix) &&
      transition.fromDispatchId !== transition.toDispatchId &&
      Boolean(transition.evidenceRef.trim()) &&
      Number.isFinite(transition.at) &&
      transition.at >= 0
    );
  });
}

export function orphanCarrierRecoverySupersedesGeneration(input: {
  lease: Pick<ActionSuccessorLease, 'orphanCarrierRecoveryTransitions'>;
  route: DelegateRoute;
  generation: number;
  expectedReporterCatIds: readonly string[] | undefined;
}): boolean {
  const { lease, route, generation, expectedReporterCatIds } = input;
  return (lease.orphanCarrierRecoveryTransitions ?? []).some(
    (entry) =>
      entry.fromGeneration === generation &&
      entry.toGeneration === generation + 1 &&
      entry.holderCatId === expectedReporterCatIds?.[0] &&
      expectedReporterCatIds?.length === 1 &&
      orphanCarrierRecoveryMatchesDelegateLineage(entry, route),
  );
}
