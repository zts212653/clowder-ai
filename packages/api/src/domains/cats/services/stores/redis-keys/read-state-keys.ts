/**
 * Redis key patterns for thread read state (F069).
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const ReadStateKeys = {
  /** Hash: read-state:{userId}:{threadId} → { lastReadMessageId, lastReadVisibilityCursor?, updatedAt } */
  cursor: (userId: string, threadId: string) => `read-state:${userId}:${threadId}`,
  /** Pattern for cleanup: read-state:*:{threadId} */
  threadPattern: (threadId: string) => `read-state:*:${threadId}`,
} as const;
