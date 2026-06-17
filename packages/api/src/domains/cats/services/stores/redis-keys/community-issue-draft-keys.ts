/**
 * F235: Redis key namespace for CommunityIssueDraftStore.
 *
 * All keys are auto-prefixed by ioredis keyPrefix. These are the bare suffixes.
 */

export const CommunityIssueDraftKeys = {
  /** Hash: all draft fields. */
  detail: (draftId: string) => `community-issue-draft:${draftId}`,

  /** String: sourceId → draftId mapping (for INV-3 uniqueness + getBySourceId). */
  source: (sourceId: string) => `community-issue-draft:source:${sourceId}`,

  /** Sorted set: drafts for a user (score = createdAt). */
  userList: (userId: string) => `community-issue-drafts:user:${userId}`,
} as const;
