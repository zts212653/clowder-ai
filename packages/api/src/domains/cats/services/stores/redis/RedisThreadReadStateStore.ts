/**
 * Redis implementation of ThreadReadStateStore (F069)
 * Per-user/per-thread read cursor for unread badge persistence.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IMessageStore } from '../ports/MessageStore.js';
import type { IThreadReadStateStore, ThreadReadState, ThreadUnreadSummary } from '../ports/ThreadReadStateStore.js';
import { ReadStateKeys } from '../redis-keys/read-state-keys.js';

/**
 * Lua CAS: atomic monotonic ack — only advance cursor, never regress.
 * KEYS[1] = read-state hash key
 * ARGV[1] = new messageId
 * ARGV[2] = updatedAt timestamp
 * Returns 1 if advanced, 0 if rejected (same or older).
 *
 * #1200 codex R14 + Sol R14: Fail-closed on cross-format comparison.
 * String comparison gives wrong results for v1-vs-v2: 'v' (0x76) > any digit,
 * so v2 always "wins" even when it represents an earlier message.
 * Same-format is safe: v2 lex ≡ (seq, id) order; v1 lex ≈ time order.
 * Cross-format → reject; app-layer pre-reconcile upgrades stored v1→v2
 * before reaching this CAS so same-format comparison is the norm.
 */
const ACK_CAS_LUA = `
local cur = redis.call('HGET', KEYS[1], 'lastReadMessageId')
if cur then
  local curV2 = string.sub(cur, 1, 3) == 'v2:'
  local newV2 = string.sub(ARGV[1], 1, 3) == 'v2:'
  if curV2 ~= newV2 then return 0 end
  if ARGV[1] <= cur then return 0 end
end
redis.call('HSET', KEYS[1], 'lastReadMessageId', ARGV[1], 'updatedAt', ARGV[2])
return 1
`;

/**
 * #1200 codex R13: Atomic reconcile of read-state cursor format.
 * CAS: if stored lastReadMessageId == ARGV[1] (old v1), upgrade to ARGV[2] (v2).
 * Returns 1 if reconciled, 0 if stored changed (race) or didn't match.
 */
const RECONCILE_READ_CURSOR_LUA = `
local cur = redis.call('HGET', KEYS[1], 'lastReadMessageId')
if cur == ARGV[1] then
  redis.call('HSET', KEYS[1], 'lastReadMessageId', ARGV[2])
  return 1
end
return 0
`;

export class RedisThreadReadStateStore implements IThreadReadStateStore {
  constructor(private readonly redis: RedisClient) {}

  private parseReadState(
    userId: string,
    threadId: string,
    data: Record<string, string> | null | undefined,
  ): ThreadReadState | null {
    if (!data?.lastReadMessageId) return null;
    return {
      userId,
      threadId,
      lastReadMessageId: data.lastReadMessageId,
      updatedAt: Number(data.updatedAt ?? 0),
    };
  }

  async get(userId: string, threadId: string): Promise<ThreadReadState | null> {
    const key = ReadStateKeys.cursor(userId, threadId);
    const data = await this.redis.hgetall(key);
    return this.parseReadState(userId, threadId, data);
  }

  async ack(userId: string, threadId: string, messageId: string): Promise<boolean> {
    const key = ReadStateKeys.cursor(userId, threadId);
    const result = await this.redis.eval(ACK_CAS_LUA, 1, key, messageId, String(Date.now()));
    return result === 1;
  }

  /**
   * #1200: Atomically reconcile stored v1 read cursor → v2.
   * Same pattern as DeliveryCursorStore.preReconcile: CAS on old value
   * so concurrent writes don't lose data.
   */
  async reconcileReadCursor(userId: string, threadId: string, oldV1: string, newV2: string): Promise<boolean> {
    const key = ReadStateKeys.cursor(userId, threadId);
    const result = await this.redis.eval(RECONCILE_READ_CURSOR_LUA, 1, key, oldV1, newV2);
    return result === 1;
  }

  async getUnreadSummaries(
    userId: string,
    threadIds: string[],
    messageStore: IMessageStore,
  ): Promise<ThreadUnreadSummary[]> {
    if (threadIds.length === 0) return [];

    // Sidebar reads can cover thousands of threads. Fetch every cursor in one
    // Redis round-trip, then hydrate unread windows with bounded concurrency.
    // This removes the serial cursor/message N+1 without creating an unbounded
    // burst against the message store.
    const cursorPipeline = this.redis.pipeline();
    for (const threadId of threadIds) {
      cursorPipeline.hgetall(ReadStateKeys.cursor(userId, threadId));
    }
    const cursorResults = await cursorPipeline.exec();
    if (!cursorResults) throw new Error('Unread cursor pipeline returned no results');

    const states = cursorResults.map((entry, index) => {
      const [error, rawData] = entry;
      if (error) throw error;
      const threadId = threadIds[index];
      if (!threadId) throw new Error(`Unread cursor pipeline returned unexpected result ${index}`);
      return this.parseReadState(userId, threadId, rawData as Record<string, string> | null);
    });

    if (messageStore.getUnreadSummaryProjection) {
      const cursors = states.flatMap((state, index) => {
        const threadId = threadIds[index];
        return state && threadId ? [{ threadId, afterId: state.lastReadMessageId }] : [];
      });
      const projected = await messageStore.getUnreadSummaryProjection(cursors, userId);
      const projectedByThread = new Map(projected.map((summary) => [summary.threadId, summary]));
      return threadIds.map((threadId, index) => {
        if (!states[index]) return { threadId, unreadCount: 0, hasUserMention: false };
        const summary = projectedByThread.get(threadId);
        if (!summary) throw new Error(`Unread projection missing thread ${threadId}`);
        return summary;
      });
    }

    const summarize = async (threadId: string, state: ThreadReadState | null): Promise<ThreadUnreadSummary> => {
      // Cold-start guard: no read cursor = treat as fully read (0 unread).
      // Pre-F069 threads have no cursor; counting all messages as unread
      // causes every badge to reappear on every page refresh.
      if (!state) {
        return { threadId, unreadCount: 0, hasUserMention: false };
      }
      const afterId = state.lastReadMessageId;

      const unreadMessages = await messageStore.getByThreadAfter(threadId, afterId, undefined, userId, {
        includeQueuedCatMessages: true,
      });
      // P1-2 fix: exclude user's own typed messages + deleted/tombstone messages
      // Cat messages (catId !== null) and connector messages (source) are counted as unread.
      // Only the user's own direct messages (catId === null, no source) are excluded.
      const relevant = unreadMessages.filter((m) => !m.deletedAt && (m.catId !== null || !!m.source));
      const unreadCount = relevant.length;
      const hasUserMention = relevant.some((m) => !!m.mentionsUser);

      return { threadId, unreadCount, hasUserMention };
    };

    const summaries = new Array<ThreadUnreadSummary>(threadIds.length);
    const concurrency = Math.min(32, threadIds.length);
    let nextIndex = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (nextIndex < threadIds.length) {
          const index = nextIndex++;
          const threadId = threadIds[index];
          if (!threadId) throw new Error(`Unread worker received unexpected index ${index}`);
          summaries[index] = await summarize(threadId, states[index] ?? null);
        }
      }),
    );

    return summaries;
  }

  async deleteByThread(threadId: string): Promise<void> {
    const prefix = (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
    const pattern = `${prefix}${ReadStateKeys.threadPattern(threadId)}`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        // Strip prefix for DEL (ioredis auto-prefixes normal commands)
        const bareKeys = prefix ? keys.map((k: string) => (k.startsWith(prefix) ? k.slice(prefix.length) : k)) : keys;
        await this.redis.del(...bareKeys);
      }
    } while (cursor !== '0');
  }
}
