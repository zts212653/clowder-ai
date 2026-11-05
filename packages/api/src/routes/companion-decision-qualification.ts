import { isUnifiedAttentionDecision, type UnifiedAttentionItemV1 } from '@cat-cafe/shared';

export function decisionQualifiedItems(items: UnifiedAttentionItemV1[]): UnifiedAttentionItemV1[] {
  return items.filter(decisionQualified);
}

export function decisionQualified(item: UnifiedAttentionItemV1): boolean {
  return isUnifiedAttentionDecision(item);
}
