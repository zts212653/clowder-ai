import type { AutomationState, ThreadProposal } from '@cat-cafe/shared';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import { isSubjectOwnershipConflictError } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';

type TransitionThreadStore = Pick<IThreadStore, 'atomicMergeThreadMetadata' | 'updatePreferredCats'>;
type TransitionTaskStore = Pick<ITaskStore, 'getBySubject' | 'upsertBySubject'>;

export interface ApprovedCommunityPrTransitionDeps {
  threadStore: TransitionThreadStore;
  taskStore?: TransitionTaskStore;
  fetchPrTrackingBoundary?: (repoFullName: string, prNumber: number) => Promise<Pick<AutomationState, 'review' | 'ci'>>;
}

export interface ApprovedCommunityPrTransitionInput extends ApprovedCommunityPrTransitionDeps {
  proposal: ThreadProposal;
  threadId: string;
}

/**
 * Reconcile the F128 approval output into F140's durable owner-bound tracker.
 *
 * The operation is intentionally idempotent: proposal approval retries and
 * stale-claim recovery may call it repeatedly after the thread commit point.
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
    warnings.push('formal PR tracking requires exactly one approved child owner; tracker was not assigned');
    return warnings;
  }
  if (!input.taskStore) {
    warnings.push('formal PR tracking reconciliation unavailable: task store not configured');
    return warnings;
  }

  const ownerCatId = input.proposal.preferredCats[0]!;
  try {
    await input.threadStore.updatePreferredCats(input.threadId, [ownerCatId]);
  } catch (error) {
    warnings.push(`formal PR child owner reconciliation failed: ${errorMessage(error)}`);
    return warnings;
  }
  const repoFullName = context.repoFullName.toLowerCase();
  const subjectKey = `pr:${repoFullName}#${context.prNumber}`;

  try {
    const existing = await input.taskStore.getBySubject(subjectKey);
    const needsBoundary =
      !existing ||
      existing.status === 'done' ||
      !existing.automationState?.review ||
      !existing.automationState?.ci?.headSha;
    let boundary: Pick<AutomationState, 'review' | 'ci'> | undefined;
    if (needsBoundary) {
      if (!input.fetchPrTrackingBoundary) {
        warnings.push('formal PR tracking boundary unavailable: fetcher not configured');
        return warnings;
      }
      try {
        boundary = await input.fetchPrTrackingBoundary(repoFullName, context.prNumber);
      } catch (error) {
        warnings.push(`formal PR tracking boundary unavailable: ${errorMessage(error)}`);
        return warnings;
      }
      if (!boundary.review || !boundary.ci?.headSha) {
        warnings.push('formal PR tracking boundary unavailable: incomplete GitHub state');
        return warnings;
      }
    }

    await input.taskStore.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey,
      threadId: input.threadId,
      ownerCatId,
      title: `PR tracking: ${repoFullName}#${context.prNumber}`,
      why: `F128 approved formal external PR review: owner=${ownerCatId} thread=${input.threadId}`,
      createdBy: 'system',
      userId: input.proposal.createdBy,
      automationState: {
        ...(boundary ?? {}),
        intent: 'review',
        wakePolicy: 'human_participant_activity',
      },
    });
  } catch (error) {
    warnings.push(
      isSubjectOwnershipConflictError(error)
        ? `formal PR tracking ownership conflict: ${subjectKey} belongs to another user`
        : `formal PR tracking reconciliation failed: ${errorMessage(error)}`,
    );
  }

  return warnings;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
