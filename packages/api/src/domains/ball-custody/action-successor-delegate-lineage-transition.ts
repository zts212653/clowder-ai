import type {
  ActionSuccessorHolderOutcome,
  ActionSuccessorReplacementTransition,
} from './action-successor-state-machine.js';

const terminalDelegateLineageOutcomes: ReadonlySet<ActionSuccessorHolderOutcome> = new Set([
  'failed',
  'canceled',
  'unavailable',
]);

export function sameSingleActionSuccessorHolder(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return left?.length === 1 && right?.length === 1 && left[0] === right[0];
}

export function isTerminalDelegateLineageOutcome(outcome: ActionSuccessorHolderOutcome | undefined): boolean {
  return outcome !== undefined && terminalDelegateLineageOutcomes.has(outcome);
}

function replacementTransitionHasTerminalProof(transition: ActionSuccessorReplacementTransition): boolean {
  const terminalOutcomes = Object.values(transition.holderOutcomes);
  return transition.reason === 'interrupted'
    ? terminalOutcomes.length === 0
    : sameSingleActionSuccessorHolder(Object.keys(transition.holderOutcomes), transition.fromHolderCatIds) &&
        terminalOutcomes.every(
          (entry) =>
            isTerminalDelegateLineageOutcome(entry.outcome) &&
            entry.evidenceRef.trim().length > 0 &&
            Number.isFinite(entry.at),
        );
}

export function replacementTransitionMatchesCanonicalOwnerRoute(
  transition: ActionSuccessorReplacementTransition,
  route: { ownerCatId: string; ownerThreadId: string },
): boolean {
  return (
    transition.fromGeneration >= 1 &&
    transition.toGeneration === transition.fromGeneration + 1 &&
    transition.fromHolderCatIds.length === 1 &&
    Boolean(transition.fromHolderCatIds[0]?.trim()) &&
    Boolean(transition.fromHolderThreadId.trim()) &&
    transition.toHolderCatIds.length === 1 &&
    Boolean(transition.toHolderCatIds[0]?.trim()) &&
    Boolean(transition.toHolderThreadId.trim()) &&
    transition.issuerCatId === route.ownerCatId &&
    transition.issuerThreadId === route.ownerThreadId &&
    transition.evidenceRefs.length > 0 &&
    transition.evidenceRefs.every((ref) => ref.trim().length > 0) &&
    Number.isFinite(transition.at) &&
    replacementTransitionHasTerminalProof(transition)
  );
}

export function replacementTransitionMatchesDelegateLineage(
  transition: ActionSuccessorReplacementTransition,
  route: { ownerCatId: string; ownerThreadId: string; childThreadId: string },
): boolean {
  return (
    replacementTransitionMatchesCanonicalOwnerRoute(transition, route) &&
    transition.fromHolderThreadId === route.childThreadId &&
    transition.toHolderThreadId === route.childThreadId
  );
}
