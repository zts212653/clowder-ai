import type { OutputCommitDecision } from '@cat-cafe/shared';

/**
 * DraftStore is the last recoverable copy until a route can prove that the
 * current answer lives in MessageStore or in its exact freshness closure.
 */
export function mayDeleteDraft(decision: OutputCommitDecision | undefined, hasDurableMessage: boolean): boolean {
  if (hasDurableMessage) return true;
  return (
    decision?.draftCustody?.kind === 'message' ||
    decision?.draftCustody?.kind === 'closure' ||
    decision?.draftCustody?.kind === 'supplement'
  );
}
