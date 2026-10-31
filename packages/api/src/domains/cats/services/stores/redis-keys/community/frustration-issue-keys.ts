/**
 * F222: Redis key namespace for FrustrationIssueStore.
 *
 * All keys are auto-prefixed by ioredis keyPrefix. These are the bare suffixes.
 */

export const FrustrationIssueKeys = {
  /** Hash: all issue fields. */
  detail: (issueId: string) => `frustration-issue:${issueId}`,

  /** Sorted set: issues in a thread (score = createdAt). */
  threadList: (threadId: string) => `frustration-issues:thread:${threadId}`,

  /** Sorted set: all issues for a user (score = createdAt). */
  userList: (userId: string) => `frustration-issues:user:${userId}`,

  /** Sorted set: confirmed issues for a user (score = confirmedAt). */
  userConfirmed: (userId: string) => `frustration-issues:confirmed:${userId}`,

  /** Sorted set: draft issues for a user (score = createdAt). */
  userDraft: (userId: string) => `frustration-issues:draft:${userId}`,
} as const;
