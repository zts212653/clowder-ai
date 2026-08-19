/**
 * Redis key patterns for F260 entity proposal storage.
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const EntityProposalKeys = {
  /** Hash with proposal fields: entity-proposal:{proposalId} */
  detail: (id: string) => `entity-proposal:${id}`,

  /** Sorted set of pending proposal IDs for a user (score=createdAt): entity-proposal-user-pending:{userId} */
  userPending: (userId: string) => `entity-proposal-user-pending:${userId}`,

  /** Sorted set of settled (approved|rejected) proposal IDs for a user (score=decidedAt): entity-proposal-user-settled:{userId} */
  userSettled: (userId: string) => `entity-proposal-user-settled:${userId}`,

  /** Auto-increment counter for proposal IDs: entity-proposal-counter */
  counter: () => 'entity-proposal-counter',

  /** Dedup reservation: entity-proposal-dedup:{userId}::{clientRequestId} */
  dedup: (userId: string, clientRequestId: string) => `entity-proposal-dedup:${userId}::${clientRequestId}`,
} as const;
