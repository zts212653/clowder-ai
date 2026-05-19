/**
 * Redis key patterns for InvocationRecord storage.
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const InvocationKeys = {
  /** Hash with invocation record details: invoc:{id} */
  detail: (id: string) => `invoc:${id}`,

  /** Idempotency key: idemp:{threadId}:{userId}:{key} */
  idempotency: (threadId: string, userId: string, key: string) => `idemp:${threadId}:${userId}:${key}`,

  /**
   * F194 Phase B: per-thread+user Set of currently running invocationIds.
   * Maintained by RedisInvocationRecordStore.update via SADD/SREM at status transitions.
   * Used by listRunningByThread to avoid scanning all invoc:* hashes on hot read path.
   */
  runningByThread: (threadId: string, userId: string) => `invoc:running:${threadId}:${userId}`,
} as const;
