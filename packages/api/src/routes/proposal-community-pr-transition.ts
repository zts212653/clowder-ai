import type { ThreadProposal } from '@cat-cafe/shared';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';

type TransitionThreadStore = Pick<IThreadStore, 'atomicMergeThreadMetadata' | 'updatePreferredCats'>;

export interface ApprovedCommunityPrTransitionDeps {
  threadStore: TransitionThreadStore;
}

export interface ApprovedCommunityPrTransitionInput extends ApprovedCommunityPrTransitionDeps {
  proposal: ThreadProposal;
  threadId: string;
}

/**
 * Reconcile formal-review identity into child metadata and preferred ownership.
 *
 * The operation is intentionally idempotent: proposal approval retries and
 * stale-claim recovery may call it repeatedly after the thread commit point.
 * A wait is never inferred here: the child owner must register an explicit
 * typed continuation once it knows what external condition blocks its work.
 */
export async function reconcileApprovedCommunityPrTransition(
  input: ApprovedCommunityPrTransitionInput,
): Promise<string[]> {
  const context = input.proposal.communityPrContext;
  if (!context) return [];

  const warnings: string[] = [];
  try {
    await input.threadStore.atomicMergeThreadMetadata(input.threadId, {
      prs: [{ repo: context.repoFullName, number: context.prNumber }],
    });
  } catch (error) {
    warnings.push(`formal PR metadata reconciliation failed: ${errorMessage(error)}`);
  }

  if (input.proposal.preferredCats.length !== 1) {
    warnings.push('formal PR review requires exactly one approved child owner; owner was not assigned');
    return warnings;
  }

  const [ownerCatId] = input.proposal.preferredCats;
  if (!ownerCatId) {
    warnings.push('formal PR review owner was not assigned');
    return warnings;
  }
  try {
    await input.threadStore.updatePreferredCats(input.threadId, [ownerCatId]);
  } catch (error) {
    warnings.push(`formal PR child owner reconciliation failed: ${errorMessage(error)}`);
    return warnings;
  }
  return warnings;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
