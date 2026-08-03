import type { ActionSuccessorAdmissionService, ActionSuccessorFence } from './ActionSuccessorAdmissionService.js';

export type ActionSuccessorCarrierAdmissionOutcome = 'claimed' | 'replaced' | 'replayed' | 'returned' | 'continued';
export type ActionSuccessorCarrierDisposition = 'successor_dispatch' | 'return';

export function actionSuccessorFencesMatch(
  candidate: ActionSuccessorFence | undefined,
  expected: ActionSuccessorFence,
): boolean {
  return (
    candidate?.leaseId === expected.leaseId &&
    candidate.generation === expected.generation &&
    candidate.dispatchId === expected.dispatchId &&
    candidate.terminalPredicateDigest === expected.terminalPredicateDigest &&
    candidate.invocationLineageRef === expected.invocationLineageRef
  );
}

/**
 * Keep carrier bookkeeping behind one invariant boundary. A returned
 * generation is delivered only after every holder is queued; a failed return
 * stays pending for S.1-c recovery and never loses custody.
 */
export async function reconcileActionSuccessorEnqueue(input: {
  service: Pick<ActionSuccessorAdmissionService, 'markUnavailable' | 'markReturnedDelivered'> | null | undefined;
  fence: ActionSuccessorFence | undefined;
  disposition: ActionSuccessorCarrierDisposition | undefined;
  unavailableCatIds: readonly string[];
  now: number;
}): Promise<void> {
  if (!input.service || !input.fence) return;

  if (input.disposition === 'return') {
    if (input.unavailableCatIds.length === 0) {
      await input.service.markReturnedDelivered({
        fence: input.fence,
        evidenceRef: `queue:${input.fence.dispatchId}:return_enqueued`,
        now: input.now,
      });
    }
    return;
  }

  if (input.unavailableCatIds.length > 0) {
    await input.service.markUnavailable({
      fence: input.fence,
      holderCatIds: [...input.unavailableCatIds],
      evidenceRef: `queue:${input.fence.dispatchId}:not_enqueued`,
      now: input.now,
    });
  }
}
