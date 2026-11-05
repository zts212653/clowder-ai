import { isUnifiedAttentionDecision, type UnifiedAttentionItemV1 } from '@cat-cafe/shared';

/** Presentation membership follows the released F310 source contract. Counts and writer authority remain server-owned. */
export function isMailboxDecision(item: UnifiedAttentionItemV1): boolean {
  return isUnifiedAttentionDecision(item);
}
