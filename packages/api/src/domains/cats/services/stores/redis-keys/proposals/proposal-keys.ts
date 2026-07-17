/**
 * Redis key patterns for F128 thread proposal storage.
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const ProposalKeys = {
  /** Hash with proposal fields: proposal:{proposalId} */
  detail: (id: string) => `proposal:${id}`,

  /** Sorted set of all proposal IDs for a user (score = createdAt): proposals:user:{userId} */
  userList: (userId: string) => `proposals:user:${userId}`,

  /** Sorted set of pending-only proposal IDs for a user: proposals:pending:{userId} */
  userPending: (userId: string) => `proposals:pending:${userId}`,

  /** Sorted set of proposal IDs proposed in a given source thread: proposals:thread:{threadId} */
  threadList: (threadId: string) => `proposals:thread:${threadId}`,

  /**
   * Idempotency cache for cat propose calls: dedup:propose:{userId}:{clientRequestId} → proposalId
   * Short TTL (minutes), strictly per-user.
   */
  dedup: (userId: string, clientRequestId: string) => `dedup:propose:${userId}:${clientRequestId}`,
} as const;
