/**
 * F221 Phase B: Redis key patterns for TasteProposal store.
 */
export const TasteProposalKeys = {
  detail: (id: string) => `taste-proposal:${id}`,
  userPending: (userId: string) => `taste-proposal-user-pending:${userId}`,
  userSettled: (userId: string) => `taste-proposal-user-settled:${userId}`,
  dedup: (userId: string, clientRequestId: string) => `taste-proposal-dedup:${userId}::${clientRequestId}`,
} as const;
