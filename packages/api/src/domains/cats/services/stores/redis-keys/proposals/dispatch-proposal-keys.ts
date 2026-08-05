/**
 * Redis key patterns for F246 Phase B dispatch proposal storage.
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const DispatchProposalKeys = {
  /** Hash with proposal fields: dispatch-proposal:{proposalId} */
  detail: (id: string) => `dispatch-proposal:${id}`,

  /** Key prefix for proposal detail hashes (used in Lua scripts for dynamic key construction). */
  detailPrefix: 'dispatch-proposal:' as const,

  /** Sorted set of pending proposal IDs for a user (score=createdAt): dispatch-proposal-user-pending:{userId} */
  userPending: (userId: string) => `dispatch-proposal-user-pending:${userId}`,

  /**
   * F246 Phase F: Sorted set of settled (approved|rejected) proposal IDs for a user
   * (score=decidedAt): dispatch-proposal-user-settled:{userId}
   */
  userSettled: (userId: string) => `dispatch-proposal-user-settled:${userId}`,

  /** Idempotency lookup: dispatch-proposal-clientmsg:{sourceThreadId}:{clientMessageId} → proposalId */
  clientMsg: (sourceThreadId: string, clientMessageId: string) =>
    `dispatch-proposal-clientmsg:${sourceThreadId}:${clientMessageId}`,

  /**
   * F246 Phase J (AC-J4): Lineage key K → currently pending proposalId.
   * K = (sourceThreadId, targetThreadId, senderCatId).
   * Same-K create atomically supersedes the previous pending proposal (INV-J5).
   */
  lineage: (lineageKey: string) => `dispatch-proposal-lineage:${lineageKey}`,

  /**
   * #1291 deny-only candidate index. The encoded suffix is
   * owner×sourceInvocation×targetThread×canonicalTargetCat; members are proposal IDs.
   * Canonical proposal fields are always revalidated before a callback is blocked.
   */
  negativeAuthorization: (negativeAuthorizationKey: string) =>
    `dispatch-proposal-negative-authorization:${negativeAuthorizationKey}`,

  /** Legacy candidate projection; bounded at lookup by a durable cutover epoch. */
  legacyNegativeAuthorization: (legacyNegativeAuthorizationKey: string) =>
    `dispatch-proposal-legacy-negative-authorization:${legacyNegativeAuthorizationKey}`,

  /** Durable shadow → required activation point for unresolved legacy proposals. */
  negativeAuthorizationLegacyCutover: 'dispatch-proposal-negative-authorization-legacy-cutover' as const,

  /** Rebuild completion barrier: cutover is invalid until canonical indices have been rebuilt. */
  negativeAuthorizationLegacyRebuildCompletedAt:
    'dispatch-proposal-negative-authorization-legacy-rebuild-completed-at' as const,
} as const;
