/**
 * Redis key patterns for community-ops event engine (F168).
 * All keys are bare (no prefix here); the ioredis client keyPrefix is applied
 * automatically by the RedisClient factory.
 *
 * Naming convention (mirrors existing redis-keys/ patterns):
 *   community:events:log:{subjectKey}   → LIST (per-subject ordered events)
 *   community:events:seen               → SET  (global sourceEventId dedup)
 *   community:events:subjects           → SET  (all active subjectKeys)
 *   community:object:{subjectKey}       → STRING (JSON-serialized projection)
 *   community:objects:index             → SET  (all subjectKeys with projections)
 */
export const CommunityKeys = {
  /** Per-subject event list: community:events:log:{subjectKey} */
  eventLog: (subjectKey: string) => `community:events:log:${subjectKey}`,

  /** Global dedup set for sourceEventId values */
  eventsSeen: 'community:events:seen',

  /** Global set of all subjectKeys that have at least one event */
  eventsSubjects: 'community:events:subjects',

  /** Serialised CommunityObjectProjection: community:object:{subjectKey} */
  objectProjection: (subjectKey: string) => `community:object:${subjectKey}`,

  /** Index set of all subjectKeys that have a projection */
  objectsIndex: 'community:objects:index',

  /** F168 C0.3: per-repo collection cursor for the repo-level comment poller (max comment updatedAt, ISO-8601) */
  repoCommentCursor: (repo: string) => `community:repo-comment:cursor:${repo}`,
} as const;

// ---------------------------------------------------------------------------
// Community event sourceEventId helpers
// Shared between webhook and polling paths to ensure convergence on the same
// idempotency key for the same underlying GitHub fact.
// ---------------------------------------------------------------------------

/**
 * Construct a stable sourceEventId for a GitHub issue comment.
 * Format: `comment:{owner}/{repo}#{issueNumber}:{commentId}`
 *
 * GitHub comment IDs are globally unique integers, so this key is globally
 * unique without needing the issue number — but including it makes the key
 * human-readable and aids debugging.
 *
 * Both the webhook handler (issue_comment.created) and the polling path
 * (IssueCommentTaskSpec) MUST use this function to ensure a single
 * occurrence of the comment reaches the event log exactly once.
 */
export function issueCommentEventId(repoFullName: string, issueNumber: number, commentId: number): string {
  return `comment:${repoFullName}#${issueNumber}:${commentId}`;
}
