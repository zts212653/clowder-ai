import type { OutputCommitDecision } from '@cat-cafe/shared';

/**
 * DraftStore is the last recoverable copy until a route can prove the current answer
 * is durable in MessageStore. An output-commit decision is exactly that proof.
 */
export function mayDeleteDraft(decision: OutputCommitDecision | undefined, hasDurableMessage: boolean): boolean {
  return hasDurableMessage || decision !== undefined;
}
