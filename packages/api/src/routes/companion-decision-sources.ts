import type { UnifiedAttentionApproval, UnifiedAttentionWork } from '@cat-cafe/shared';

export type {
  UnifiedAttentionApproval as DecisionApproval,
  UnifiedAttentionReceipt as DecisionReceipt,
  UnifiedAttentionSourceRead as DecisionSourceRead,
  UnifiedAttentionSourceStatus as DecisionSourceStatus,
  UnifiedAttentionWork as DecisionWork,
} from '@cat-cafe/shared';
export {
  unifiedAttentionApprovalsSourceSchema as approvalsSourceSchema,
  unifiedAttentionWorkSourceSchema as needsMeSourceSchema,
} from '@cat-cafe/shared';

export function assertDecisionOwner(
  approvals: UnifiedAttentionApproval[],
  work: UnifiedAttentionWork[],
  userId: string,
): void {
  if (
    approvals.some((item) => item.ownerUserId !== userId) ||
    work.some((item) => item.envelope.visibility.ownerUserId !== userId)
  )
    throw new Error('Decision owner identity mismatch');
}
