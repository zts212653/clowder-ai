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
 */
const ACK_CAS_LUA = `
local cur = redis.call('HGET', KEYS[1], 'lastReadMessageId')
if cur and ARGV[1] <= cur then return 0 end
redis.call('HSET', KEYS[1], 'lastReadMessageId', ARGV[1], 'updatedAt', ARGV[2])
return 1
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
