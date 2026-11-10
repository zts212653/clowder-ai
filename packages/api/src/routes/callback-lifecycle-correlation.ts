import type { LifecycleAppendBoundary, LifecycleDispatchRef } from '@cat-cafe/shared';
import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';

/**
 * Member-readable correlation for the fixed response body. The body stays whole;
 * these fields only explain which canonical inputs the response adopted and where
 * the Host observed display ranges. They are not a claim that later text answers a
 * specific input sentence-by-sentence or that the work completed.
 */
export interface CallbackLifecycleCorrelation {
  readonly inputMessageIds?: readonly string[];
  readonly appendBoundaries?: readonly LifecycleAppendBoundary[];
  readonly appendBoundarySemantics?: 'host_observed_display_range';
  readonly dispatchRefs?: readonly LifecycleDispatchRef[];
}

export function projectCallbackLifecycleCorrelation(
  message: StoredMessage,
  principalCatId: string,
): CallbackLifecycleCorrelation {
  const lifecycle = message.lifecycle;
  if (lifecycle?.kind === 'response') {
    const appendBoundaries = lifecycle.appendBoundaries ?? [];
    return {
      inputMessageIds: lifecycle.inputMessageIds,
      ...(appendBoundaries.length > 0
        ? { appendBoundaries, appendBoundarySemantics: 'host_observed_display_range' as const }
        : {}),
    };
  }
  if (lifecycle?.kind === 'input') {
    const dispatchRefs = (lifecycle.dispatchRefs ?? []).filter((ref) => ref.targetId === principalCatId);
    return dispatchRefs.length > 0 ? { dispatchRefs } : {};
  }
  return {};
}
