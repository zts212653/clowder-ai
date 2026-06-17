/**
 * Redis key patterns for F231 Phase C profile-update proposal storage.
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const ProfileUpdateProposalKeys = {
  /** Hash with proposal fields: profile-update:{proposalId} */
  detail: (id: string) => `profile-update:${id}`,

  /** Sorted set of pending-only proposal IDs for a user: profile-update:pending:{userId} */
  userPending: (userId: string) => `profile-update:pending:${userId}`,

  /** Sorted set of proposal IDs proposed in a source thread: profile-update:thread:{threadId} */
  threadList: (threadId: string) => `profile-update:thread:${threadId}`,

  /**
   * Idempotency cache for cat propose calls: dedup:profile-update:{userId}:{clientRequestId} → proposalId
   * Short TTL (minutes), strictly per-user.
   */
  dedup: (userId: string, clientRequestId: string) => `dedup:profile-update:${userId}:${clientRequestId}`,
} as const;
