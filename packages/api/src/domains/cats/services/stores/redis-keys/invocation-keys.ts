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

  /**
   * F297 (PR #3748 cloud R7 P2): per-user Set of threadIds that currently have a running
   * invocation. Directly addressable — the sidebar read path must not walk the keyspace.
   *
   * 为什么不能用 `SCAN MATCH invoc:running:*:{userId}`：Redis 的 SCAN 仍然遍历**整个
   * keyspace**，MATCH 只过滤返回值。于是 `GET /api/threads?view=sidebar` 的成本随库里
   * 所有持久化键增长，而不是随在跑的 thread 数。实测（本地无网络延迟）：
   * dbsize 3 → 0.3ms；200k → 201ms。
   *
   * 一致性方向：SADD 与 running set 在**同一原子操作**内完成，所以不会漏报
   * （漏报 = false terminal，F297 核心禁忌）；残留的多报由读侧 SCARD 校验消除。
   */
  runningThreadsByUser: (userId: string) => `invoc:running-threads:${userId}`,

  /**
   * Latest terminal InvocationRecord for one thread+user.
   *
   * This is an edge-maintained pointer, not a history index: deployments do not backfill
   * old terminal records.  That direction is intentional — an absent pointer renders idle,
   * while guessing from historical conversation activity forges done/error.
   *
   * The prefix deliberately does not match `invoc:*`; record SCANs must never HGETALL this
   * string key.
   */
  latestTerminalByThread: (threadId: string, userId: string) => `invoc-terminal:latest:${threadId}:${userId}`,
} as const;
