/**
 * Redis key patterns for community issue storage (F168).
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const CommunityIssueKeys = {
  /** Hash with issue details: community-issue:{id} */
  detail: (id: string) => `community-issue:${id}`,

  /** Per-repo sorted set (score=updatedAt): community-issues:repo:{repo} */
  repo: (repo: string) => `community-issues:repo:${repo}`,

  /** Global sorted set of all issues: community-issues:all */
  all: 'community-issues:all',

  /** Dedup lookup: community-issue:lookup:{repo}:{number} → id */
  lookup: (repo: string, issueNumber: number) => `community-issue:lookup:${repo}:${issueNumber}`,
} as const;
