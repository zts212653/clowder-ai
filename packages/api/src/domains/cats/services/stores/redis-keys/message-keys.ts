/**
 * Redis key patterns for message storage.
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const MessageKeys = {
  /** Hash with message details: msg:{id} */
  detail: (id: string) => `msg:${id}`,

  /** Global timeline sorted set */
  TIMELINE: 'msg:timeline',

  /** Per-user timeline sorted set: msg:user:{userId} */
  user: (userId: string) => `msg:user:${userId}`,

  /** Per-cat mentions sorted set: msg:mentions:{catId} */
  mentions: (catId: string) => `msg:mentions:${catId}`,

  /** Per-thread timeline sorted set: msg:thread:{threadId} */
  thread: (threadId: string) => `msg:thread:${threadId}`,

  /** Idempotency index: msg:idem:{userId}:{threadId}:{key} -> messageId */
  idempotency: (userId: string, threadId: string, key: string) => `msg:idem:${userId}:${threadId}:${key}`,

  /** Callback content-dedup claim (race-safe exact-duplicate gate): msg:cbdedup:{fingerprint} */
  contentDedup: (fingerprint: string) => `msg:cbdedup:${fingerprint}`,
} as const;
