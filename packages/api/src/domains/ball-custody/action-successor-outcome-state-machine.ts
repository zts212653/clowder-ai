import type { ActionSuccessorHolderOutcome, ActionSuccessorLease } from './action-successor-state-machine.js';

export function recordActionSuccessorOutcome(
  current: ActionSuccessorLease,
  input: {
    generation: number;
    catId: string;
    outcome: ActionSuccessorHolderOutcome;
    evidenceRef: string;
    now: number;
  },
): ActionSuccessorLease {
  if (input.generation !== current.generation) throw new Error('stale action successor generation');
  if (!current.holderCatIds.includes(input.catId))
    throw new Error(`cat is not an action successor holder: ${input.catId}`);
  if (current.status !== 'active') return current;
  // First terminal observation wins. In a parallel lease another holder can
  // keep the lease active while timeout/cleanup races with a completed holder;
  // overwriting that holder would corrupt the proof used for final status.
  if (current.holderOutcomes[input.catId]) return current;
  const holderOutcomes = {
    ...current.holderOutcomes,
    [input.catId]: { outcome: input.outcome, evidenceRef: input.evidenceRef, at: input.now },
  };
  const allTerminal = current.holderCatIds.every((catId) => holderOutcomes[catId] !== undefined);
  const anySucceeded = Object.values(holderOutcomes).some((entry) => entry.outcome === 'succeeded');
  const completionCandidates = { ...current.completionCandidates };
  delete completionCandidates[input.catId];
  return {
    ...current,
    holderOutcomes,
    completionCandidates,
    status: allTerminal ? (anySucceeded ? 'completed' : 'replaceable') : 'active',
    evidenceRefs: [...new Set([...current.evidenceRefs, input.evidenceRef])],
    revision: current.revision + 1,
    updatedAt: input.now,
  };
}
