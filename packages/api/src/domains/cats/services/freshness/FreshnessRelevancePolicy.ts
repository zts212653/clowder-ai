import type { FreshnessReadableMessage } from './checkFreshnessForPostMessage.js';

export type FreshnessRelevanceReason =
  | 'relevant'
  | 'directed_to_other_cat'
  | 'closure_replacement_for_other_cat'
  | 'same_parallel_batch'
  | 'same_user_wave_sibling_reply';

export interface FreshnessRelevanceDecision {
  relevant: boolean;
  reason: FreshnessRelevanceReason;
}

export interface FreshnessRelevanceContext {
  catId: string;
  parallelBatchId?: string;
  coveredTriggerMessageIds?: ReadonlySet<string>;
}

export function isSameUserWaveSiblingReply(
  message: FreshnessReadableMessage,
  context: Pick<FreshnessRelevanceContext, 'catId' | 'coveredTriggerMessageIds'>,
): boolean {
  const explicitTargets = new Set([...(message.mentions ?? []), ...(message.extra?.targetCats ?? [])]);
  const causal = message.extra?.causal;
  return Boolean(
    causal?.kind === 'invocation_reply' &&
      context.coveredTriggerMessageIds?.has(causal.triggerMessageId) &&
      !explicitTargets.has(context.catId),
  );
}

/**
 * Target-aware relevance shared by callback, stream-output, and closure preflight checks.
 * Visibility answers "may this cat read it?"; this policy answers the narrower question
 * "does this message create new work for this cat?".
 */
export function decideFreshnessRelevance(
  message: FreshnessReadableMessage,
  context: FreshnessRelevanceContext,
): FreshnessRelevanceDecision {
  const freshness = message.extra?.freshness;
  if (freshness?.kind === 'closure_replacement' && freshness.targetCatId !== context.catId) {
    return { relevant: false, reason: 'closure_replacement_for_other_cat' };
  }

  if (context.parallelBatchId && message.extra?.stream?.parallelBatchId === context.parallelBatchId) {
    return { relevant: false, reason: 'same_parallel_batch' };
  }

  const explicitTargets = new Set([...(message.mentions ?? []), ...(message.extra?.targetCats ?? [])]);
  if (isSameUserWaveSiblingReply(message, context)) {
    return { relevant: false, reason: 'same_user_wave_sibling_reply' };
  }

  if (message.catId === null) {
    if (explicitTargets.size > 0 && !explicitTargets.has(context.catId)) {
      return { relevant: false, reason: 'directed_to_other_cat' };
    }
  }

  return { relevant: true, reason: 'relevant' };
}
