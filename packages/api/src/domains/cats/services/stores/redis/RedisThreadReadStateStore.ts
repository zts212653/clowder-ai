/**
 * Redis implementation of ThreadReadStateStore (F069)
 * Per-user/per-thread read cursor for unread badge persistence.
 */

import { type RedisClient, VISIBILITY_RESOLVE_SEQ_LUA } from '@cat-cafe/shared/utils';
import type { IMessageStore } from '../ports/MessageStore.js';
import type {
  IThreadReadStateStore,
  ThreadReadCoordinate,
  ThreadReadState,
  ThreadUnreadSummary,
} from '../ports/ThreadReadStateStore.js';
import { ReadStateKeys } from '../redis-keys/read-state-keys.js';

/**
 * Lua CAS: atomic monotonic ack — only advance cursor, never regress.
 * KEYS[1] = read-state hash key
 * ARGV[1] = new messageId
 * ARGV[2] = updatedAt timestamp
 * ARGV[3] = key prefix (for manual key construction inside Lua)
 * ARGV[4] = threadId (visibility ZSET fallback; '' disables)
 * ARGV[5] = canonical visibility cursor (optional)
 * Returns 1 if advanced, 0 if rejected (same or older).
 *
 * #3444 root-2 fix (audit thread_msk4hm5oat1ldrbh): the previous same-format
 * raw string comparison conflated creation order with visibility order — a
 * valid visibility inversion (created-early message becoming visible later)
 * made legitimate forward acks rejected, resurrecting unread badges.
 * Comparison now resolves both sides to (seq, id) via the shared
 * VISIBILITY_RESOLVE_SEQ_LUA fragment (message hash first, visibility ZSET
 * fallback for legacy messages the lazy backfill left without hash seq) and
 * compares in the visibility pair domain — the same coordinate system as
 * delivery/mention/seen (SET_IF_GREATER_LUA). One-sided fully-pruned residuals
 * stay fail-closed. Both-unresolvable pre-migration values retain raw lex for
 * compatibility; that bounded residual cannot repair a visibility inversion
 * until at least one side has canonical visibility evidence.
 */
const ACK_CAS_LUA = `
local cur = redis.call('HGET', KEYS[1], 'lastReadMessageId')
local durableCur = redis.call('HGET', KEYS[1], 'lastReadVisibilityCursor')
${VISIBILITY_RESOLVE_SEQ_LUA}
if cur then
  if ARGV[1] == cur then
    if ARGV[5] and ARGV[5] ~= '' then
      redis.call('HSET', KEYS[1], 'lastReadVisibilityCursor', ARGV[5])
    elseif string.sub(ARGV[1], 1, 3) == 'v2:' then
      redis.call('HSET', KEYS[1], 'lastReadVisibilityCursor', ARGV[1])
    end
    return 0
  end
  -- The rollout-gated primary may have been pruned. Once present, the
  -- canonical anchor is the authoritative monotonic comparison coordinate.
  local curSeq, curId = resolveSeq(durableCur or cur)
  local newSeq, newId = resolveSeq(ARGV[1])
  if curSeq and newSeq then
    -- Both resolved: visibility pair-domain comparison
    if newSeq < curSeq or (newSeq == curSeq and newId <= curId) then return 0 end
  elseif curSeq and not newSeq then
    -- Stored resolvable, incoming unresolvable: cannot prove advancement
    return 0
  elseif not curSeq and newSeq then
    -- Stored fully pruned (post-fallback): position unknowable → fail-closed
    return 0
  else
    -- Both unresolvable: raw lex fallback (pre-migration compatibility)
    if ARGV[1] <= cur then return 0 end
  end
end
redis.call('HSET', KEYS[1], 'lastReadMessageId', ARGV[1], 'updatedAt', ARGV[2])
if ARGV[5] and ARGV[5] ~= '' then
  redis.call('HSET', KEYS[1], 'lastReadVisibilityCursor', ARGV[5])
elseif string.sub(ARGV[1], 1, 3) == 'v2:' then
  redis.call('HSET', KEYS[1], 'lastReadVisibilityCursor', ARGV[1])
end
return 1
`;

/**
 * Atomic exact read-cursor replacement. Used both for same-position format
 * reconciliation and for accepted read evidence repairing a fully pruned slot.
 * Returns 1 if replaced, 0 if a concurrent writer changed the value.
 */
const REPLACE_READ_CURSOR_IF_EQUAL_LUA = `
local cur = redis.call('HGET', KEYS[1], 'lastReadMessageId')
if cur == ARGV[1] then
  redis.call('HSET', KEYS[1], 'lastReadMessageId', ARGV[2])
  if ARGV[3] and ARGV[3] ~= '' then
    redis.call('HSET', KEYS[1], 'lastReadVisibilityCursor', ARGV[3])
  end
  if ARGV[4] and ARGV[4] ~= '' then
    redis.call('HSET', KEYS[1], 'updatedAt', ARGV[4])
  end
  return 1
end
return 0
`;

/**
 * Atomic replacement of the complete durable read coordinate.
 * Both primary and canonical-anchor presence/value are CAS inputs.
 */
const REPLACE_READ_COORDINATE_IF_EQUAL_LUA = `
local cur = redis.call('HGET', KEYS[1], 'lastReadMessageId')
local anchor = redis.call('HGET', KEYS[1], 'lastReadVisibilityCursor')
if cur ~= ARGV[1] then return 0 end
if ARGV[2] == '1' then
  if anchor ~= ARGV[3] then return 0 end
elseif anchor then
  return 0
end
redis.call('HSET', KEYS[1], 'lastReadMessageId', ARGV[4], 'updatedAt', ARGV[7])
if ARGV[5] == '1' then
  redis.call('HSET', KEYS[1], 'lastReadVisibilityCursor', ARGV[6])
else
  redis.call('HDEL', KEYS[1], 'lastReadVisibilityCursor')
end
return 1
`;

export class RedisThreadReadStateStore implements IThreadReadStateStore {
  private readonly keyPrefix: string;

  constructor(private readonly redis: RedisClient) {
    // Read ioredis keyPrefix for Lua scripts that construct keys manually
    // (same pattern as SessionStore in @cat-cafe/shared). Optional-chained:
    // test doubles may not expose ioredis options.
    this.keyPrefix = redis.options?.keyPrefix ?? '';
  }

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
      ...(data.lastReadVisibilityCursor ? { lastReadVisibilityCursor: data.lastReadVisibilityCursor } : {}),
      updatedAt: Number(data.updatedAt ?? 0),
    };
  }

  async get(userId: string, threadId: string): Promise<ThreadReadState | null> {
    const key = ReadStateKeys.cursor(userId, threadId);
    const data = await this.redis.hgetall(key);
    return this.parseReadState(userId, threadId, data);
  }

  private readPosition(state: ThreadReadState): string {
    return state.lastReadVisibilityCursor ?? state.lastReadMessageId;
  }

  async ack(userId: string, threadId: string, messageId: string, canonicalCursor = ''): Promise<boolean> {
    const key = ReadStateKeys.cursor(userId, threadId);
    const result = await this.redis.eval(
      ACK_CAS_LUA,
      1,
      key,
      messageId,
      String(Date.now()),
      this.keyPrefix,
      threadId,
      canonicalCursor,
    );
    return result === 1;
  }

  /**
   * #1200: Atomically reconcile stored v1 read cursor → v2.
   * Same pattern as DeliveryCursorStore.preReconcile: CAS on old value
   * so concurrent writes don't lose data.
   */
  async reconcileReadCursor(userId: string, threadId: string, oldV1: string, newV2: string): Promise<boolean> {
    return this.replaceReadCursorIfEqual(userId, threadId, oldV1, newV2);
  }

  async replaceReadCursorIfEqual(
    userId: string,
    threadId: string,
    expectedValue: string,
    newValue: string,
    canonicalCursor?: string,
  ): Promise<boolean> {
    const key = ReadStateKeys.cursor(userId, threadId);
    const anchor = canonicalCursor ?? (newValue.startsWith('v2:') ? newValue : '');
    const updatedAt = canonicalCursor ? String(Date.now()) : '';
    const result = await this.redis.eval(
      REPLACE_READ_CURSOR_IF_EQUAL_LUA,
      1,
      key,
      expectedValue,
      newValue,
      anchor,
      updatedAt,
    );
    return result === 1;
  }

  async replaceReadCoordinateIfEqual(
    userId: string,
    threadId: string,
    expected: ThreadReadCoordinate,
    replacement: ThreadReadCoordinate,
  ): Promise<boolean> {
    const key = ReadStateKeys.cursor(userId, threadId);
    const result = await this.redis.eval(
      REPLACE_READ_COORDINATE_IF_EQUAL_LUA,
      1,
      key,
      expected.lastReadMessageId,
      expected.lastReadVisibilityCursor === undefined ? '0' : '1',
      expected.lastReadVisibilityCursor ?? '',
      replacement.lastReadMessageId,
      replacement.lastReadVisibilityCursor === undefined ? '0' : '1',
      replacement.lastReadVisibilityCursor ?? '',
      String(Date.now()),
    );
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
        return state && threadId
          ? [
              {
                threadId,
                afterId: this.readPosition(state),
                ...(state.lastReadVisibilityCursor ? { fallbackAfterId: state.lastReadMessageId } : {}),
              },
            ]
          : [];
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
      const afterId = this.readPosition(state);

      const unreadMessages = await messageStore.getByThreadAfter(threadId, afterId, undefined, userId, {
        includeQueuedCatMessages: true,
        unresolvedCursorPolicy: 'empty',
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
