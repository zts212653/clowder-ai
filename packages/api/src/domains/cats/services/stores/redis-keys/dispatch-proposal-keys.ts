/**
 * Redis key patterns for F246 Phase B dispatch proposal storage.
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const DispatchProposalKeys = {
  /** Hash with proposal fields: dispatch-proposal:{proposalId} */
  detail: (id: string) => `dispatch-proposal:${id}`,

  /** Sorted set of pending proposal IDs for a user (score=createdAt): dispatch-proposal-user-pending:{userId} */
  userPending: (userId: string) => `dispatch-proposal-user-pending:${userId}`,

  /** Idempotency lookup: dispatch-proposal-clientmsg:{sourceThreadId}:{clientMessageId} → proposalId */
  clientMsg: (sourceThreadId: string, clientMessageId: string) =>
    `dispatch-proposal-clientmsg:${sourceThreadId}:${clientMessageId}`,
} as const;
