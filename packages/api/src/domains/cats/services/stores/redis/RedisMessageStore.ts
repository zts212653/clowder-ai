/**
 * Redis Message Store
 * Redis-backed message storage with same interface as in-memory MessageStore.
 *
 * Redis 数据结构:
 *   cat-cafe:msg:{id}                → Hash (消息详情)
 *   cat-cafe:msg:timeline            → Sorted Set (全局时间线, score=timestamp)
 *   cat-cafe:msg:user:{userId}       → Sorted Set (用户维度)
 *   cat-cafe:msg:mentions:{catId}    → Sorted Set (提及维度)
 *   cat-cafe:msg:thread:{threadId}   → Sorted Set (对话维度)
 *
 * 消息 TTL 可配置 (默认 7 天)。
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { cursorFor, parseCursor } from '../cursor.js';
import type {
  AppendMessageInput,
  BoundedThreadMessagePage,
  HostMessageExtra,
  MarkCanceledResult,
  MarkDeliveredResult,
  MessageAppendListener,
  QueueCustodyInitializeResult,
  QueueCustodyTransitionInput,
  QueueCustodyTransitionResult,
  QueuedMessageCustody,
  StoredMessage,
  StoredPluginMessage,
  StreamMetadataAugmentInput,
  ThreadFrontierAppendResult,
  ThreadMessageReadOptions,
  ThreadObservedAppendResult,
  ThreadUnreadMessageProjection,
  ThreadUnreadProjectionCursor,
} from '../ports/MessageStore.js';
import {
  applyStreamMetadataAugment,
  assertValidAppendDeliveryMetadata,
  assertValidStoredMessageTimestamp,
  DEFAULT_THREAD_ID,
  generateSortableId,
  isDelivered,
} from '../ports/MessageStore.js';
import { assertQueueCustodyMessageBinding, assertQueueCustodyTransition } from '../ports/queued-message-custody.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import {
  isSystemUserMessage,
  isTimelinePublished,
  resolveDeliveryTimelineScore,
  resolveThreadMessageVisibility,
} from '../visibility.js';
import { appendMessage } from './redis-message-append.js';
import { CANCEL_LUA, DELIVER_LUA, REASSIGN_LUA } from './redis-message-delivery-lua-scripts.js';
import {
  appendMessageAndObservePriorFrontier,
  appendMessageIfThreadFrontier,
} from './redis-message-frontier-append.js';
import {
  safeParseConnectorSource,
  safeParseContentBlocks,
  safeParseExtra,
  safeParseMentions,
  safeParseMetadata,
  safeParsePluginMessage,
  safeParseQueueCustody,
  safeParseToolEvents,
  serializeExtra,
} from './redis-message-parsers.js';
import { projectRedisUnreadSummaries } from './redis-unread-summary-projection.js';
import {
  APPEND_WITH_VISIBILITY_LUA,
  CANCEL_WITH_VISIBILITY_LUA,
  DELIVER_WITH_VISIBILITY_LUA,
  ENSURE_VISIBILITY_MIGRATED_LUA,
  MAX_BACKFILL_MEMBERS,
} from './redis-visibility-lua-scripts.js';

const log = createModuleLogger('redis-message-store');

const DEFAULT_LIMIT = 50;
const DEFAULT_TTL_SECONDS = 0; // persistent — set >0 via env to enable expiry

const REDIS_NUMBER_ALIASES = new Map<string, number>([
  ['', Number.NaN],
  ['inf', Number.POSITIVE_INFINITY],
  ['+inf', Number.POSITIVE_INFINITY],
  ['-inf', Number.NEGATIVE_INFINITY],
]);

/** Decode both Redis ZSCORE spellings and JavaScript number spellings without truncation. */
function parseRedisNumber(raw: string): number {
  const value = raw.trim();
  return REDIS_NUMBER_ALIASES.get(value) ?? Number(value);
}

function parseStoredMessageTimestamp(raw: string | undefined): number {
  return parseRedisNumber(raw ?? '0');
}
const INITIALIZE_QUEUE_CUSTODY_LUA = `
local messageId = redis.call('HGET', KEYS[1], 'id')
if not messageId then
  return -1
end
if redis.call('HGET', KEYS[1], 'deliveryStatus') ~= 'queued' then
  return -2
end
local existing = redis.call('HGET', KEYS[1], 'queueCustody')
if existing and existing ~= '' then
  return 0
end
redis.call('HSET', KEYS[1], 'queueCustody', ARGV[1], 'queueCustodyRevision', ARGV[2])
return 1
`;

const TRANSITION_QUEUE_CUSTODY_LUA = `
local messageId = redis.call('HGET', KEYS[1], 'id')
local custody = redis.call('HGET', KEYS[1], 'queueCustody')
if not messageId or not custody then
  return {-1, -1}
end
local currentRevision = tonumber(redis.call('HGET', KEYS[1], 'queueCustodyRevision') or '0')
if currentRevision ~= tonumber(ARGV[1]) then
  return {0, currentRevision}
end
if redis.call('HGET', KEYS[1], 'deliveryStatus') ~= 'queued' then
  return {-2, currentRevision}
end
local nextRevision = tonumber(ARGV[3])

-- #1269 R8 P1-3: pre-mutation guard — compute visibilitySeq BEFORE any HSET/ZADD.
-- redis.error_reply() does NOT rollback prior writes, so all validation must
-- precede all mutations. Previously custody HSET was before HWM validation,
-- meaning a corrupt HWM would leave custody already mutated.
local seq = nil
local kp = ARGV[6]
local threadId = nil
if ARGV[4] ~= '' then
  threadId = redis.call('HGET', KEYS[1], 'threadId')
  local existingVis = redis.call('HGET', KEYS[1], 'visibilitySeq')
  if existingVis == false and threadId then
    local metaKey = kp .. 'msg:visibility-meta:' .. threadId
    local hwmRaw = redis.call('HGET', metaKey, 'hwm')
    local hwm = 0
    if hwmRaw ~= false then
      hwm = tonumber(hwmRaw)
      if hwm == nil then
        return redis.error_reply('VISIBILITY_HWM_UNPARSEABLE: raw=' .. tostring(hwmRaw) .. ' metaKey=' .. metaKey)
      end
      if hwm ~= hwm then
        return redis.error_reply('VISIBILITY_HWM_NAN: metaKey=' .. metaKey)
      end
      if hwm ~= math.floor(hwm) or hwm < 0 then
        return redis.error_reply('VISIBILITY_HWM_INVALID: hwm=' .. tostring(hwm) .. ' metaKey=' .. metaKey)
      end
    end
    local t = redis.call('TIME')
    local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
    seq = math.max(hwm + 1, now_ms)
    if seq > 9007199254730991 then
      return redis.error_reply('VISIBILITY_SEQ_EXHAUSTED: seq=' .. tostring(seq))
    end
  end
end

-- All validation passed — write mutations atomically
redis.call('HSET', KEYS[1], 'queueCustody', ARGV[2], 'queueCustodyRevision', ARGV[3])

if ARGV[4] ~= '' then
  redis.call('HSET', KEYS[1], 'deliveredAt', ARGV[4], 'timelineOrderAt', ARGV[5], 'deliveryStatus', 'delivered')
  redis.call('ZADD', KEYS[2], ARGV[5], messageId)
  redis.call('ZADD', KEYS[3], ARGV[5], messageId)
  redis.call('ZADD', KEYS[4], ARGV[5], messageId)

  if seq then
    local visKey = kp .. 'msg:visibility:' .. threadId
    local metaKey = kp .. 'msg:visibility-meta:' .. threadId
    redis.call('ZADD', visKey, seq, messageId)
    redis.call('HSET', metaKey, 'hwm', tostring(seq))
    redis.call('HSETNX', metaKey, 'migrated', '1')
    redis.call('HSET', KEYS[1], 'visibilitySeq', tostring(seq))
  end

  return {2, nextRevision}
end
return {1, nextRevision}
`;

const UPDATE_PLUGIN_MESSAGE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local current = nil
local raw = redis.call('HGET', KEYS[1], 'pluginMessage')
if raw and raw ~= '' then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok then current = decoded end
else
  local legacyRaw = redis.call('HGET', KEYS[1], 'extra')
  if legacyRaw and legacyRaw ~= '' then
    local ok, decoded = pcall(cjson.decode, legacyRaw)
    if ok then current = decoded.pluginMessage end
  end
end
if not current or tonumber(current.revision) ~= tonumber(ARGV[2]) then return -1 end
redis.call('HSET', KEYS[1], 'pluginMessage', ARGV[1])
return 1
`;

function splitMessageExtra(extra: StoredMessage['extra'] | undefined): {
  hostExtra: HostMessageExtra;
  pluginMessage: StoredPluginMessage | undefined;
} {
  const { pluginMessage, ...hostExtra } = extra ?? {};
  return { hostExtra, pluginMessage };
}

function serializeHostExtra(extra: StoredMessage['extra'] | undefined): string {
  const { hostExtra } = splitMessageExtra(extra);
  return Object.keys(hostExtra).length > 0 ? serializeExtra(hostExtra) : '';
}

function hydrateExtra(rawExtra: string | undefined, rawPluginMessage: string | undefined): StoredMessage['extra'] {
  const parsedExtra = safeParseExtra(rawExtra);
  const { hostExtra, pluginMessage: legacyPluginMessage } = splitMessageExtra(parsedExtra);
  // Once the independent field exists it is authoritative, including when
  // malformed (fail-closed); fall back only for pre-F288 embedded records.
  if (rawPluginMessage === undefined) {
    // Pre-F288 path: no independent field, fall back to legacy embedded record.
    if (Object.keys(hostExtra).length === 0 && legacyPluginMessage === undefined) return undefined;
    return { ...hostExtra, ...(legacyPluginMessage ? { pluginMessage: legacyPluginMessage } : {}) };
  }
  // F288 path: independent field exists. Preserve it even when invalid so
  // projectEnvelope enters the plugin branch and fail-closes (codex P1 fix).
  const pluginMessage = safeParsePluginMessage(rawPluginMessage);
  // When pluginMessage parsed to undefined (malformed), keep an invalid marker
  // object so `extra.pluginMessage !== undefined` remains true — projectEnvelope
  // will detect the malformed payload via readPluginMessageExtra and return null.
  const pluginValue = pluginMessage ?? ({} as StoredPluginMessage);
  return { ...hostExtra, pluginMessage: pluginValue };
}

export class RedisMessageStore {
  private readonly redis: RedisClient;
  /** null means no expiration/pruning (persistent retention). */
  private readonly ttlSeconds: number | null;
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: MessageAppendListener;

  constructor(
    redis: RedisClient,
    options?: {
      ttlSeconds?: number;
      onAppend?: MessageAppendListener;
    },
  ) {
    this.redis = redis;
    this.onAppend = options?.onAppend;
    const raw = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isFinite(raw) || raw <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(raw);
    }
  }

  /** Resolve ioredis keyPrefix (SCAN doesn't auto-apply it) */
  private get keyPrefix(): string {
    return (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  }

  /** Strip keyPrefix from a raw SCAN key for use with normal commands (which auto-prefix) */
  private stripPrefix(rawKey: string): string {
    const p = this.keyPrefix;
    return p && rawKey.startsWith(p) ? rawKey.slice(p.length) : rawKey;
  }

  async append(msg: AppendMessageInput): Promise<StoredMessage> {
    assertValidAppendDeliveryMetadata(msg);
    assertValidStoredMessageTimestamp(msg.timestamp);
    const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
    const idempotencyIndexKey = msg.idempotencyKey
      ? MessageKeys.idempotency(msg.userId, threadId, msg.idempotencyKey)
      : null;

    // Keep the common replay path ahead of ID generation; the Lua check below
    // remains the authoritative claim for concurrent callers.
    if (idempotencyIndexKey) {
      const existingId = await this.redis.get(idempotencyIndexKey);
      if (existingId) {
        const existingMessage = await this.getById(existingId);
        if (existingMessage) {
          return existingMessage;
        }
      }
      // Stale reference: do NOT delete here (avoids a check-then-act race).
      // APPEND_WITH_VISIBILITY_LUA will reclaim it atomically (#1210).
    }

    const id = generateSortableId(msg.timestamp);
    const { idempotencyKey, ...payload } = msg;
    void idempotencyKey;
    const stored: StoredMessage = { ...payload, id, threadId };
    const score = msg.timestamp;
    const hashKey = MessageKeys.detail(id);

    // Build hash fields as flat key-value pairs for the Lua HSET
    const hashFields: string[] = [
      'id',
      id,
      'threadId',
      threadId,
      'userId',
      msg.userId,
      'catId',
      msg.catId ?? '',
      'content',
      msg.content,
      'contentBlocks',
      msg.contentBlocks ? JSON.stringify(msg.contentBlocks) : '',
      'toolEvents',
      msg.toolEvents ? JSON.stringify(msg.toolEvents) : '',
      'metadata',
      msg.metadata ? JSON.stringify(msg.metadata) : '',
      'extra',
      msg.extra ? serializeExtra(msg.extra) : '',
      'mentions',
      JSON.stringify(msg.mentions),
      'timestamp',
      String(msg.timestamp),
    ];
    if (msg.thinking) hashFields.push('thinking', msg.thinking);
    if (msg.origin) hashFields.push('origin', msg.origin);
    if (msg.visibility) hashFields.push('visibility', msg.visibility);
    if (msg.whisperTo) hashFields.push('whisperTo', JSON.stringify(msg.whisperTo));
    if (msg.source) hashFields.push('source', JSON.stringify(msg.source));
    if (msg.mentionsUser) hashFields.push('mentionsUser', '1');
    if (msg.deliveryStatus) hashFields.push('deliveryStatus', msg.deliveryStatus);
    // #1269 P1-1: restore queueCustody serialization that createStoredMessageData() provided.
    // Without these, F254 custody CAS operations fail on messages appended with initial custody.
    if (msg.queueCustody) {
      hashFields.push('queueCustody', JSON.stringify(msg.queueCustody));
      hashFields.push('queueCustodyRevision', String(msg.queueCustody.revision));
    }
    if (msg.replyTo) hashFields.push('replyTo', msg.replyTo);

    // Mention catIds for ZADD into per-cat mention sets
    const mentionCatIds = msg.mentions as readonly string[];
    const ttlSec = this.ttlSeconds ?? 0;

    // Shape (a) atomic append: all data writes + visibility writes + idempotency
    // in one Lua linearization point. Combines #1200 visibility and #1210 atomic
    // idempotency. See §8.6 of 1200-cursor-order-analysis.md.
    //
    // ARGV layout: kp, id, threadId, score, userId, isQueued, ttlSeconds,
    //   idemKeyRaw, mentionCount, ...mentionCatIds, hashFieldPairCount, ...hashFieldPairs
    const argv: (string | number)[] = [
      this.keyPrefix, // [1] keyPrefix
      id, // [2] msgId
      threadId, // [3] threadId
      String(score), // [4] score
      msg.userId, // [5] userId
      // #1269: timeline-published queued cat speech gets visibilitySeq at append
      msg.deliveryStatus === 'queued' && !isTimelinePublished(stored) ? '1' : '', // [6] isQueued
      String(ttlSec), // [7] ttlSeconds
      idempotencyIndexKey ?? '', // [8] idemKeyRaw ('' if none)
      String(mentionCatIds.length), // [9] mentionCount
      ...mentionCatIds, // [10..9+N] mention catIds
      String(hashFields.length / 2), // [10+N] hashFieldPairCount
      ...hashFields, // [11+N..] hash field pairs
    ];

    // #1200/#1269: ensure visibility migration is complete BEFORE the append.
    // Timeline-published messages (delivered + queued cat speech) need the index.
    // Lua marks the thread as migrated via HSETNX. Without this, the first
    // post-deploy append to a legacy thread would skip backfilling legacy members.
    if (isTimelinePublished(stored)) {
      await this.ensureVisibilityMigrated(threadId);
    }

    // Lua returns:
    // - string (existing msgId) → idempotency replay, return existing message
    // - number (visibilitySeq) → new message created, seq > 0 for non-queued
    const result = await this.redis.eval(APPEND_WITH_VISIBILITY_LUA, 1, hashKey, ...argv);

    // #1210 idempotency: if Lua returned a string, a concurrent caller won.
    if (typeof result === 'string' && result !== String(0)) {
      const existingMessage = await this.getById(result);
      if (existingMessage) {
        return existingMessage;
      }
      // The concurrent winner's hash vanished (deleteByThread / TTL) between the
      // Lua claim and this hydration. Do not fall through to the created path,
      // which would fire onAppend for a message that was never persisted.
      throw new Error(`Idempotency winner ${result} for key ${idempotencyKey} vanished before hydration`);
    }

    // #1200 P2-6: Lua returns allocated visibilitySeq (number) or 0 for queued.
    // Inject into returned message so callers get canonical position without re-read.
    const seq = typeof result === 'number' ? result : Number(result);
    if (seq > 0) {
      stored.visibilitySeq = seq;
    }

    // F102 KD-34: fire-and-forget append listener for thread index updates
    if (this.onAppend) {
      try {
        void Promise.resolve(this.onAppend(stored)).catch(() => {});
      } catch {
        /* best-effort */
      }
    }

    return stored;
  }

  async getLatestThreadMessageIdIncludingQueued(threadId: string): Promise<string | null> {
    const ids = await this.redis.zrevrange(MessageKeys.thread(threadId), 0, 0);
    return ids[0] ?? null;
  }

  async getByIdempotencyKey(userId: string, threadId: string, idempotencyKey: string): Promise<StoredMessage | null> {
    const messageId = await this.redis.get(MessageKeys.idempotency(userId, threadId, idempotencyKey));
    return messageId ? this.getById(messageId) : null;
  }

  async appendIfThreadFrontier(
    msg: AppendMessageInput,
    expectedLatestMessageId: string | null,
  ): Promise<ThreadFrontierAppendResult> {
    return appendMessageIfThreadFrontier({
      redis: this.redis,
      message: msg,
      expectedLatestMessageId,
      ttlSeconds: this.ttlSeconds,
      loadById: (messageId) => this.getById(messageId),
      ...(this.onAppend ? { onAppend: this.onAppend } : {}),
    });
  }

  async appendAndObservePriorFrontier(msg: AppendMessageInput): Promise<ThreadObservedAppendResult> {
    return appendMessageAndObservePriorFrontier({
      redis: this.redis,
      message: msg,
      ttlSeconds: this.ttlSeconds,
      loadById: (messageId) => this.getById(messageId),
      ...(this.onAppend ? { onAppend: this.onAppend } : {}),
    });
  }

  async getById(id: string): Promise<StoredMessage | null> {
    const data = await this.redis.hgetall(MessageKeys.detail(id));
    return this.hydrateHash(data);
  }

  /**
   * Convert a Redis hash (Record<string, string> from HGETALL) into a StoredMessage.
   * Shared by getById (direct HGETALL) and parseLuaHgetall (Lua-returned HGETALL).
   */
  private hydrateHash(data: Record<string, string>): StoredMessage | null {
    if (!data || !data.id) return null;

    const contentBlocks = safeParseContentBlocks(data.contentBlocks);
    const toolEvents = safeParseToolEvents(data.toolEvents);
    const parsedMetadata = safeParseMetadata(data.metadata);
    const parsedExtra = hydrateExtra(data.extra, data.pluginMessage);
    const parsedSource = safeParseConnectorSource(data.source);
    const parsedQueueCustody = safeParseQueueCustody(data.queueCustody);
    const deletedAt = data.deletedAt ? parseInt(data.deletedAt, 10) : undefined;
    return {
      id: data.id,
      threadId: data.threadId || DEFAULT_THREAD_ID,
      userId: data.userId ?? 'unknown',
      catId: (data.catId || null) as CatId | null,
      content: data.content ?? '',
      ...(contentBlocks ? { contentBlocks } : {}),
      ...(toolEvents ? { toolEvents } : {}),
      ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
      ...(parsedExtra ? { extra: parsedExtra } : {}),
      mentions: safeParseMentions(data.mentions),
      timestamp: parseStoredMessageTimestamp(data.timestamp),
      ...(deletedAt ? { deletedAt, deletedBy: data.deletedBy ?? '' } : {}),
      ...(data._tombstone === '1' ? { _tombstone: true as const } : {}),
      ...(data.thinking ? { thinking: data.thinking } : {}),
      ...(data.origin === 'stream' || data.origin === 'callback' || data.origin === 'briefing'
        ? { origin: data.origin as 'stream' | 'callback' | 'briefing' }
        : {}),
      ...(data.visibility === 'whisper' ? { visibility: 'whisper' as const } : {}),
      ...(data.whisperTo ? { whisperTo: safeParseMentions(data.whisperTo) } : {}),
      ...(data.revealedAt ? { revealedAt: parseInt(data.revealedAt, 10) } : {}),
      ...(data.deliveredAt ? { deliveredAt: parseRedisNumber(data.deliveredAt) } : {}),
      ...(data.timelineOrderAt !== undefined ? { timelineOrderAt: parseRedisNumber(data.timelineOrderAt) } : {}),
      ...(data.deliveryStatus ? { deliveryStatus: data.deliveryStatus as StoredMessage['deliveryStatus'] } : {}),
      ...(parsedQueueCustody ? { queueCustody: parsedQueueCustody } : {}),
      ...(parsedSource ? { source: parsedSource } : {}),
      ...(data.mentionsUser === '1' ? { mentionsUser: true } : {}),
      ...(data.replyTo ? { replyTo: data.replyTo } : {}),
      ...(data.visibilitySeq ? { visibilitySeq: parseInt(data.visibilitySeq, 10) } : {}),
    };
  }

  /**
   * Parse a Lua HGETALL return (flat [key, val, key, val, ...] array) into StoredMessage.
   * Used by CAS methods (markDelivered, markCanceled, reassignUserId) to hydrate
   * the winning hash state atomically — no separate getById round-trip needed,
   * eliminating the gap where a transient failure could lose the CAS receipt.
   */
  private parseLuaHgetall(result: unknown): StoredMessage | null {
    if (!Array.isArray(result)) return null;
    const data: Record<string, string> = {};
    for (let i = 0; i < result.length; i += 2) {
      data[result[i] as string] = result[i + 1] as string;
    }
    return this.hydrateHash(data);
  }

  private parseLuaTransitionResult(result: unknown): { outcome: number; message: StoredMessage | null } {
    if (!Array.isArray(result) || result.length < 1) {
      throw new Error('unexpected Redis message transition result');
    }
    return {
      outcome: Number(result[0]),
      message: this.parseLuaHgetall(result[1]),
    };
  }

  /** Scan all stored message hashes (Redis-only repair helper). */
  async scanAll(): Promise<StoredMessage[]> {
    const matchPattern = `${this.keyPrefix}${MessageKeys.detail('*')}`;
    const messages: StoredMessage[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of keys) {
          pipeline.hgetall(this.stripPrefix(key));
        }
        const results = await pipeline.exec();
        for (const entry of results ?? []) {
          const [err, data] = entry!;
          if (err || !data || typeof data !== 'object') continue;
          const d = data as Record<string, string>;
          if (!d.id) continue;
          const msg = await this.getById(d.id);
          if (msg) messages.push(msg);
        }
      }
    } while (cursor !== '0');
    return messages;
  }

  /**
   * F233: List messages that carry cross-post metadata (extra.crossPost.sourceThreadId).
   * Uses SCAN + pipeline HGET to check the `extra` field efficiently, then hydrates
   * only matching messages. For the FeatTrajectoryCollectorScheduler's CrossPostCollector.
   */
  async listCrossPostMessages(): Promise<StoredMessage[]> {
    const matchPattern = `${this.keyPrefix}${MessageKeys.detail('*')}`;
    const results: StoredMessage[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length === 0) continue;
      // Pipeline: fetch only the `extra` field to check for cross-post metadata
      const pipeline = this.redis.pipeline();
      for (const key of keys) pipeline.hget(this.stripPrefix(key), 'extra');
      const extraResults = await pipeline.exec();
      // Collect IDs of messages with cross-post metadata
      const matchedIds: string[] = [];
      for (let i = 0; i < (extraResults?.length ?? 0); i++) {
        const [err, extraRaw] = extraResults![i]!;
        if (err || !extraRaw || typeof extraRaw !== 'string') continue;
        try {
          const parsed = JSON.parse(extraRaw);
          if (parsed?.crossPost?.sourceThreadId) {
            // Extract ID from key: strip prefix, then strip "msg:" prefix
            const stripped = this.stripPrefix(keys[i]);
            const id = stripped.replace(/^msg:/, '');
            matchedIds.push(id);
          }
        } catch {
          // malformed JSON — skip
        }
      }
      // Hydrate matched messages — only include delivered ones
      for (const id of matchedIds) {
        const msg = await this.getById(id);
        if (msg && (!msg.deliveryStatus || msg.deliveryStatus === 'delivered')) {
          results.push(msg);
        }
      }
    } while (cursor !== '0');
    return results;
  }

  /**
   * Reassign a message to a different userId and move user-timeline membership.
   * PR #1193: atomic Lua — derives currentUserId and effectiveOrder from the hash
   * inside the script, eliminating stale-snapshot races with markDelivered.
   */
  async reassignUserId(id: string, nextUserId: string): Promise<StoredMessage | null> {
    const hashKey = MessageKeys.detail(id);
    const ttlArg = String(this.ttlSeconds ?? 0);
    const raw = await this.redis.eval(REASSIGN_LUA, 1, hashKey, id, nextUserId, this.keyPrefix, ttlArg);
    const { outcome, message } = this.parseLuaTransitionResult(raw);
    if (outcome === -1) return null;
    if (!message) throw new Error(`Redis reassignment lost canonical message: ${id}`);
    return message;
  }

  async getRecent(limit?: number, userId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = userId ? MessageKeys.user(userId) : MessageKeys.TIMELINE;
    return this.fetchVisibleDesc(key, n);
  }

  async listOwnerMessagesInWindow(
    ownerUserId: string,
    sinceInclusive: number,
    untilInclusive: number,
  ): Promise<StoredMessage[]> {
    assertValidStoredMessageTimestamp(sinceInclusive);
    assertValidStoredMessageTimestamp(untilInclusive);
    if (sinceInclusive > untilInclusive) return [];

    const ids = await this.redis.zrangebyscore(
      MessageKeys.user(ownerUserId),
      String(sinceInclusive),
      String(untilInclusive),
    );
    const messages = await this.hydrateMessages(ids);
    return messages.filter((message) => message.userId === ownerUserId && isDelivered(message));
  }

  /**
   * Get mentions for a cat, ascending (oldest first after cursor).
   * #1200 §8.7 migration: scans INSIDE the visibility relation with match-counted
   * discipline — chunks visibility ZSET until `limit` MENTION matches collected or
   * thread exhausted. Accepts v1 + v2 cursors. Per-cat mentions ZSET is NOT used
   * for cursor advance (remains a time-domain display/backfill surface).
   */
  async getMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
    afterMessageId?: string,
  ): Promise<StoredMessage[]> {
    if (!threadId) {
      // Global mention query without threadId: fall back to mention ZSET scan.
      // §8.7 audit: no cursor-advance call sites use the global path.
      return this.getMentionsForLegacy(catId, limit, userId);
    }
    const n = limit ?? DEFAULT_LIMIT;
    await this.ensureVisibilityMigrated(threadId);
    const visKey = MessageKeys.threadVisibility(threadId);

    // Parse cursor + resolve to visibility position (same as getByThreadAfter)
    const cursor = parseCursor(afterMessageId);
    let afterSeq: number | null = null;
    let cursorId: string | null = null;

    if (cursor) {
      cursorId = cursor.id;
      if (cursor.version === 2) {
        afterSeq = cursor.seq;
      } else {
        const seqRaw = await this.redis.hget(MessageKeys.detail(cursor.id), 'visibilitySeq');
        if (seqRaw) afterSeq = Number(seqRaw);
        else {
          const score = await this.redis.zscore(visKey, cursor.id);
          if (score !== null) afterSeq = Number(score);
        }
      }
    }

    // Match-counted scan with mention predicate + soft-delete exclusion.
    // #1200 Sol R2: hydrateAndFilter no longer filters deletedAt (tombstone-keep parity).
    // Mention scan explicitly excludes deleted messages here.
    const mentionFilter = (msg: StoredMessage) => !msg.deletedAt && msg.mentions.includes(catId);
    const result: StoredMessage[] = [];
    const staleIds: string[] = [];

    // #1269: mention scans use isTimelinePublished — timeline-published cat speech
    // is visible at append time (accepted contract: timeline-published = visible everywhere).
    if (!cursor || afterSeq === null) {
      await this.scanVisibilityChunked(
        visKey,
        '-inf',
        '+inf',
        n,
        userId,
        result,
        staleIds,
        isTimelinePublished,
        mentionFilter,
      );
    } else {
      const sameRaw = await this.redis.zrangebyscore(visKey, String(afterSeq), String(afterSeq));
      const sameFiltered = sameRaw.filter((id) => id > cursorId!);
      if (sameFiltered.length > 0) {
        const sameScores = new Map(sameFiltered.map((id) => [id, afterSeq!]));
        await this.hydrateAndFilter(
          sameFiltered,
          userId,
          n,
          result,
          staleIds,
          isTimelinePublished,
          sameScores,
          mentionFilter,
        );
      }
      if (result.length < n) {
        await this.scanVisibilityChunked(
          visKey,
          `(${afterSeq}`,
          '+inf',
          n,
          userId,
          result,
          staleIds,
          isTimelinePublished,
          mentionFilter,
        );
      }
    }

    if (staleIds.length > 0) this.redis.zrem(visKey, ...staleIds).catch(() => {});
    return result;
  }

  /** Legacy global mention scan (no threadId). Not used by cursor-advance paths. */
  private async getMentionsForLegacy(catId: CatId, limit?: number, userId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const mentionKey = MessageKeys.mentions(catId);

    // #1200 codex R5 P2: apply userId filtering (match getRecentMentionsFor behavior).
    // Scan in chunks so filtered-out entries don't consume the limit.
    const CHUNK = 50;
    const eligible: string[] = [];
    let offset = 0;

    while (eligible.length < n) {
      const chunk = await this.redis.zrange(mentionKey, offset, offset + CHUNK - 1);
      if (chunk.length === 0) break;
      for (const id of chunk) {
        if (eligible.length >= n) break;
        if (userId) {
          const score = await this.redis.zscore(MessageKeys.user(userId), id);
          if (score === null) continue;
        }
        eligible.push(id);
      }
      if (chunk.length < CHUNK) break;
      offset += CHUNK;
    }

    if (eligible.length === 0) return [];
    const messages = await this.hydrateMessages(eligible);
    // #1200 Sol R2: explicit deletedAt filter for mentions (hydrateAndFilter no longer filters)
    // #1269: isTimelinePublished — timeline-published = visible everywhere.
    return messages.filter((m) => isTimelinePublished(m) && !m.deletedAt).slice(0, n);
  }

  /**
   * Get the most recent N mentions for a cat, ascending within the returned window (oldest→newest).
   */
  async getRecentMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
  ): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const mentionKey = MessageKeys.mentions(catId);

    const CHUNK = 50;
    const ids: string[] = [];
    let offset = 0;

    // Scan backward (descending) in chunks and filter down to the most recent N matches.
    while (ids.length < n) {
      const chunk = await this.redis.zrevrange(mentionKey, offset, offset + CHUNK - 1);
      if (chunk.length === 0) break;
      for (const id of chunk) {
        if (ids.length >= n) break;
        if (userId) {
          const score = await this.redis.zscore(MessageKeys.user(userId), id);
          if (score === null) continue;
        }
        if (threadId) {
          const score = await this.redis.zscore(MessageKeys.thread(threadId), id);
          if (score === null) continue;
        }
        ids.push(id);
      }
      offset += CHUNK;
    }

    if (ids.length === 0) return [];
    const messages = await this.hydrateMessages(ids.reverse());
    // #1269: isTimelinePublished — timeline-published = visible everywhere.
    return messages.filter(isTimelinePublished);
  }

  async getBefore(timestamp: number, limit?: number, userId?: string, beforeId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = userId ? MessageKeys.user(userId) : MessageKeys.TIMELINE;

    if (!beforeId) {
      // F117: Chunked scan (desc) to collect N delivered messages
      const CHUNK = Math.max(n, 50);
      const result: StoredMessage[] = []; // desc order (newest first)
      let offset = 0;
      while (result.length < n) {
        const ids = await this.redis.zrevrangebyscore(key, `(${timestamp}`, '-inf', 'LIMIT', offset, CHUNK);
        if (ids.length === 0) break;
        // Keep desc order — don't reverse
        const messages = await this.hydrateMessages(ids);
        for (const msg of messages) {
          if (isDelivered(msg)) result.push(msg);
          if (result.length >= n) break;
        }
        if (ids.length < CHUNK) break;
        offset += CHUNK;
      }
      // Take first N (newest) and reverse to ascending
      return result.slice(0, n).reverse();
    }

    // F117: Scan cursor path with integrated isDelivered filtering
    const result = await this.fetchVisibleBeforeCursor(key, timestamp, beforeId, n);
    return result.reverse();
  }

  async getByThread(
    threadId: string,
    limit?: number,
    userId?: string,
    options?: ThreadMessageReadOptions,
  ): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = MessageKeys.thread(threadId);
    return this.fetchVisibleDesc(
      key,
      n,
      userId ? (m) => m.userId === userId || isSystemUserMessage(m) : undefined,
      resolveThreadMessageVisibility(options),
    );
  }

  async getByThreadIncludingQueued(threadId: string, limit?: number, userId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = MessageKeys.thread(threadId);
    const CHUNK = Math.max(n, 50);
    const result: StoredMessage[] = [];
    let offset = 0;

    while (result.length < n) {
      const ids = await this.redis.zrevrange(key, offset, offset + CHUNK - 1);
      if (ids.length === 0) break;
      const messages = await this.hydrateMessages(ids);
      for (const msg of messages) {
        if (msg.deletedAt) continue;
        if (msg.deliveryStatus === 'canceled') continue;
        if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
        result.push(msg);
        if (result.length >= n) break;
      }
      if (ids.length < CHUNK) break;
      offset += CHUNK;
    }

    return result.slice(0, n).reverse();
  }

  /**
   * Get messages in a thread after a cursor ID (exclusive), oldest first.
   * If afterId is undefined, returns from thread start.
   * If limit is undefined, returns all matches.
   *
   * #1200 rewrite: reads from the visibility index (not the thread ZSET).
   * §8.10 steps 4+5: ensureVisibilityMigrated → parseCursor → resolve/direct →
   * WITHSCORES → hydrate → filter-then-limit → visibilitySeq injection.
   * Lazy null-ZREM for stale members.
   */
  async getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
    options?: ThreadMessageReadOptions,
  ): Promise<StoredMessage[]> {
    // 1. Ensure visibility index is migrated (lazy one-time backfill)
    await this.ensureVisibilityMigrated(threadId);

    const visKey = MessageKeys.threadVisibility(threadId);

    // 2. Parse cursor token (§8.3) + resolve to (seq, id) pair (§8.4)
    const cursor = parseCursor(afterId);
    let afterSeq: number | null = null;
    let cursorId: string | null = null;

    if (cursor) {
      cursorId = cursor.id;
      if (cursor.version === 2) {
        // v2: seq is directly available — skip resolve round-trips
        afterSeq = cursor.seq;
      } else {
        // v1: lazy resolve (§8.4 three-step)
        // Step 1: HGET visibilitySeq from message hash (cheapest)
        const seqRaw = await this.redis.hget(MessageKeys.detail(cursor.id), 'visibilitySeq');
        if (seqRaw) {
          afterSeq = Number(seqRaw);
        } else {
          // Step 2: ZSCORE from visibility index (hash evicted but member exists)
          const score = await this.redis.zscore(visKey, cursor.id);
          if (score !== null) afterSeq = Number(score);
          // Step 3: Both null = fully pruned → scan from start
        }
      }
    }

    // 3. Chunked WITHSCORES read from visibility ZSET: filter-then-limit
    // #1269 R9 P1-1: caller-appropriate visibility predicate — respects
    // includeQueuedCatMessages option (default: isDelivered only).
    const isVisible = resolveThreadMessageVisibility(options);
    const maxResults = limit && limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
    const result: StoredMessage[] = [];
    const staleIds: string[] = [];

    if (!cursor || afterSeq === null) {
      // No cursor or fully pruned: scan from start
      await this.scanVisibilityChunked(visKey, '-inf', '+inf', maxResults, userId, result, staleIds, isVisible);
    } else {
      // Same-score segment: IDs with same visibilitySeq, id > cursorId
      const sameRaw = await this.redis.zrangebyscore(visKey, String(afterSeq), String(afterSeq));
      const sameFiltered = sameRaw.filter((id) => id > cursorId!);
      if (sameFiltered.length > 0) {
        // All members share afterSeq — build score map for injection
        const sameScores = new Map(sameFiltered.map((id) => [id, afterSeq!]));
        await this.hydrateAndFilter(sameFiltered, userId, maxResults, result, staleIds, isVisible, sameScores);
      }
      // Strict segment: visibilitySeq > afterSeq (chunked)
      // #1200 codex P2: pass maxResults (absolute total), not maxResults - result.length.
      // scanVisibilityChunked's while loop uses `result.length < maxCollect` — result
      // already contains items from the same-score segment, so passing the absolute
      // target lets the shared accumulator stop at the right total.
      if (result.length < maxResults) {
        await this.scanVisibilityChunked(
          visKey,
          `(${afterSeq}`,
          '+inf',
          maxResults,
          userId,
          result,
          staleIds,
          isVisible,
        );
      }
    }

    // 4. Lazy null-ZREM: clean stale visibility members (fire-and-forget)
    if (staleIds.length > 0) {
      this.redis.zrem(visKey, ...staleIds).catch(() => {});
    }

    return result;
  }

  async getUnreadSummaryProjection(
    cursors: readonly ThreadUnreadProjectionCursor[],
    userId: string,
  ): Promise<ThreadUnreadMessageProjection[]> {
    return projectRedisUnreadSummaries(this.redis, cursors, userId);
  }

  /**
   * #1200 §8.7: Get the latest visible cursor for a thread.
   *
   * Reverse chunked scan of the visibility ZSET: ZREVRANGE WITHSCORES from the
   * top, hydrate, apply the SAME filter chain as getByThreadAfter (tombstone-keep /
   * null-skip / canceled-skip / isDelivered), return the FIRST live member.
   *
   * Returns {cursor: v2 token, messageId: raw ID} or null if no live messages.
   * Used by public read-state routes (mark-all, read/latest) where time-latest ≠
   * visibility-latest once late delivery exists.
   */
  async getLatestVisibleCursor(threadId: string): Promise<{ cursor: string; messageId: string } | null> {
    await this.ensureVisibilityMigrated(threadId);
    const visKey = MessageKeys.threadVisibility(threadId);
    const CHUNK = 20;
    const staleIds: string[] = [];
    let offset = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const raw = await this.redis.zrevrange(visKey, offset, offset + CHUNK - 1, 'WITHSCORES');
      if (raw.length === 0) break;

      // Parse WITHSCORES pairs: [id, score, id, score, ...]
      for (let i = 0; i < raw.length; i += 2) {
        const id = raw[i]!;
        const score = Number(raw[i + 1]);
        const data = await this.redis.hgetall(MessageKeys.detail(id));
        if (!data || !data.id) {
          staleIds.push(id);
          continue;
        }
        const msg = this.hydrateHash(data as Record<string, string>);
        if (!msg) {
          staleIds.push(id);
          continue;
        }
        // #1269: include timeline-published queued cat speech (has visibilitySeq
        // since append). Skip non-published and soft-deleted messages.
        if (!isTimelinePublished(msg)) continue;
        if (msg.deletedAt) continue;

        // Found the latest visible message — build v2 cursor
        // Lazy null-ZREM for stale members encountered before this one
        if (staleIds.length > 0) {
          this.redis.zrem(visKey, ...staleIds).catch(() => {});
        }
        return {
          cursor: cursorFor({ id: msg.id, visibilitySeq: score }),
          messageId: msg.id,
        };
      }

      offset += CHUNK;
    }

    // No live messages found — clean stale members
    if (staleIds.length > 0) {
      this.redis.zrem(visKey, ...staleIds).catch(() => {});
    }
    return null;
  }

  /** #1200: Canonicalize a raw message ID to a v2 cursor token. */
  async canonicalizeCursor(messageId: string, threadId: string): Promise<string> {
    await this.ensureVisibilityMigrated(threadId);
    const score = await this.redis.zscore(MessageKeys.threadVisibility(threadId), messageId);
    if (score == null) return messageId;
    return cursorFor({ id: messageId, visibilitySeq: Number(score) });
  }

  /**
   * #1200: Ensure the visibility index exists for a thread (lazy migration guard).
   * Cheap no-op when already migrated (single HGET inside the Lua).
   */
  private async ensureVisibilityMigrated(threadId: string): Promise<void> {
    const threadKey = MessageKeys.thread(threadId);
    await this.redis.eval(
      ENSURE_VISIBILITY_MIGRATED_LUA,
      1,
      threadKey,
      this.keyPrefix,
      threadId,
      String(MAX_BACKFILL_MEMBERS),
    );
  }

  /**
   * #1200: Chunked scan of the visibility ZSET. Reads CHUNK members at a time,
   * hydrates, filters (visibilityPredicate + userId), and collects into `result`.
   * Stops when `maxCollect` published messages are collected or ZSET exhausted.
   *
   * #1269 R9 P1-1: visibilityPredicate is caller-supplied — getByThreadAfter
   * passes resolveThreadMessageVisibility(options), mention scans pass
   * isTimelinePublished. This keeps canonical position allocation independent
   * from reader eligibility.
   */
  private async scanVisibilityChunked(
    visKey: string,
    minScore: string,
    maxScore: string,
    maxCollect: number,
    userId: string | undefined,
    result: StoredMessage[],
    staleIds: string[],
    visibilityPredicate: (msg: StoredMessage) => boolean,
    extraFilter?: (msg: StoredMessage) => boolean,
  ): Promise<void> {
    const CHUNK = Math.max(maxCollect, 50);
    let offset = 0;
    while (result.length < maxCollect) {
      // WITHSCORES: response is [id, score, id, score, ...] — binding by ID (§8.7 rev 4)
      const raw = await this.redis.zrangebyscore(visKey, minScore, maxScore, 'WITHSCORES', 'LIMIT', offset, CHUNK);
      if (raw.length === 0) break;

      // Parse WITHSCORES pairs into ids + score map
      const ids: string[] = [];
      const scores = new Map<string, number>();
      for (let i = 0; i < raw.length; i += 2) {
        const id = raw[i]!;
        const score = Number(raw[i + 1]);
        ids.push(id);
        scores.set(id, score);
      }

      // #1200 P1-B: NO lex-ID filtering. Score-range params handle positioning.
      // #1200 codex P2: pass maxCollect directly — hydrateAndFilter checks
      // result.length < maxCollect with the shared accumulator.
      if (ids.length > 0) {
        await this.hydrateAndFilter(
          ids,
          userId,
          maxCollect,
          result,
          staleIds,
          visibilityPredicate,
          scores,
          extraFilter,
        );
      }

      if (ids.length < CHUNK) break;
      offset += CHUNK;
    }
  }

  /**
   * #1200: Hydrate a batch of IDs + apply visibility filters.
   * Collects up to `maxCollect` published messages into `result`.
   * Null-hydrated IDs are added to `staleIds` for lazy ZREM.
   *
   * #1269 R9 P1-1: visibilityPredicate is caller-supplied so each reader
   * applies its own publication filter (e.g. resolveThreadMessageVisibility
   * for getByThreadAfter, isTimelinePublished for mention scans).
   */
  private async hydrateAndFilter(
    ids: string[],
    userId: string | undefined,
    maxCollect: number,
    result: StoredMessage[],
    staleIds: string[],
    visibilityPredicate: (msg: StoredMessage) => boolean,
    scores?: Map<string, number>,
    extraFilter?: (msg: StoredMessage) => boolean,
  ): Promise<void> {
    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.hgetall(MessageKeys.detail(id));
    }
    const rawResults = await pipeline.exec();
    if (!rawResults) return;

    for (let i = 0; i < rawResults.length && result.length < maxCollect; i++) {
      const [err, data] = rawResults[i] ?? [null, null];
      if (err || !data || typeof data !== 'object') {
        staleIds.push(ids[i]!);
        continue;
      }
      const d = data as Record<string, string>;
      if (!d.id) {
        staleIds.push(ids[i]!);
        continue;
      }

      const msg = this.hydrateHash(d);
      if (!msg) {
        staleIds.push(ids[i]!);
        continue;
      }
      // #1200 Sol R2 P2-5: tombstones (deletedAt) are KEPT per binding doc
      // (tombstone-keep / null-skip / canceled-skip / visibilityPredicate). Parity with
      // Memory store: both stores return tombstones in getByThreadAfter.
      // #1269 R9 P1-1: caller-supplied visibilityPredicate replaces hardcoded filter.
      // getByThreadAfter passes resolveThreadMessageVisibility(options) (option-aware);
      // mention scans pass isTimelinePublished (always include published cat speech).
      // Hidden queued work is excluded by all predicates.
      if (!visibilityPredicate(msg)) continue;
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      if (extraFilter && !extraFilter(msg)) continue;
      // §8.7: Inject visibilitySeq from WITHSCORES (authoritative over hash field
      // for backfilled legacy messages that lack the hash field). Binding by ID.
      if (scores) {
        const seq = scores.get(ids[i]!);
        if (seq !== undefined) msg.visibilitySeq = seq;
      }
      result.push(msg);
    }
  }

  async getByThreadBefore(
    threadId: string,
    timestamp: number,
    limit?: number,
    beforeId?: string,
    userId?: string,
    options?: ThreadMessageReadOptions,
  ): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = MessageKeys.thread(threadId);
    const userFilter = userId ? (m: StoredMessage) => m.userId === userId || isSystemUserMessage(m) : undefined;
    const isVisible = resolveThreadMessageVisibility(options);

    if (!beforeId) {
      // F117: Chunked desc scan — collect N delivered, scan until full or exhausted
      const CHUNK = Math.max(n, 50);
      const result: StoredMessage[] = []; // desc order (newest first)
      let offset = 0;
      while (result.length < n) {
        const ids = await this.redis.zrevrangebyscore(key, `(${timestamp}`, '-inf', 'LIMIT', offset, CHUNK);
        if (ids.length === 0) break;
        // Keep desc order — don't reverse
        const messages = await this.hydrateMessages(ids);
        for (const msg of messages) {
          if (!isVisible(msg)) continue;
          if (userFilter && !userFilter(msg)) continue;
          result.push(msg);
          if (result.length >= n) break;
        }
        if (ids.length < CHUNK) break;
        offset += CHUNK;
      }
      return result.slice(0, n).reverse();
    }

    // F117/F128: Scan cursor path with integrated publication + user filtering
    const result = await this.fetchVisibleBeforeCursor(key, timestamp, beforeId, n, userFilter, isVisible);
    return result.reverse();
  }

  async getByThreadBeforeBounded(
    threadId: string,
    timestamp: number,
    limit: number,
    beforeId: string | undefined,
    userId: string | undefined,
    scanLimit: number,
    options?: ThreadMessageReadOptions,
  ): Promise<BoundedThreadMessagePage> {
    const key = MessageKeys.thread(threadId);
    const resultTarget = Math.max(1, Math.floor(limit));
    const rawLimit = Math.max(0, Math.floor(scanLimit));
    const chunkSize = Math.min(resultTarget, 500);
    const userFilter = userId
      ? (message: StoredMessage) => message.userId === userId || isSystemUserMessage(message)
      : undefined;
    const isVisible = resolveThreadMessageVisibility(options);
    const result: StoredMessage[] = [];
    let scannedCount = 0;
    let storageRoundTrips = 0;
    let exhausted = rawLimit === 0;
    let offset = 0;
    let nextCursor: BoundedThreadMessagePage['nextCursor'];

    let cursorRank: number | null | undefined;
    if (beforeId) {
      cursorRank = await this.redis.zrevrank(key, beforeId);
      storageRoundTrips += 1;
    }

    while (result.length < resultTarget && scannedCount < rawLimit) {
      const count = Math.min(chunkSize, rawLimit - scannedCount);
      let raw: string[];
      if (cursorRank !== null && cursorRank !== undefined) {
        const start = cursorRank + 1 + offset;
        raw = await this.redis.zrevrange(key, start, start + count - 1, 'WITHSCORES');
      } else {
        const max = beforeId ? String(timestamp) : `(${timestamp}`;
        raw = await this.redis.zrevrangebyscore(key, max, '-inf', 'WITHSCORES', 'LIMIT', offset, count);
      }
      storageRoundTrips += 1;

      const pairCount = Math.floor(raw.length / 2);
      if (pairCount === 0) {
        exhausted = true;
        break;
      }

      const validIds: string[] = [];
      for (let index = 0; index < pairCount; index += 1) {
        const id = raw[index * 2]!;
        const score = parseRedisNumber(raw[index * 2 + 1]!);
        scannedCount += 1;
        nextCursor = { timestamp: score, id };
        if (cursorRank === null && beforeId && score === timestamp && id >= beforeId) continue;
        validIds.push(id);
      }

      if (validIds.length > 0) {
        const messages = await this.hydrateMessages(validIds);
        storageRoundTrips += 1;
        for (const message of messages) {
          if (!isVisible(message)) continue;
          if (userFilter && !userFilter(message)) continue;
          result.push(message);
        }
      }

      offset += pairCount;
      if (pairCount < count) {
        exhausted = true;
        break;
      }
    }

    return {
      messages: result.reverse(),
      scannedCount,
      storageRoundTrips,
      exhausted,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /**
   * Scan a sorted set in reverse (newest first), hydrate + apply the selected
   * visibility predicate, collecting up to `n` visible messages. Returns oldest first.
   */
  private async fetchVisibleDesc(
    key: string,
    n: number,
    extraFilter?: (msg: StoredMessage) => boolean,
    visibilityFilter: (msg: StoredMessage) => boolean = isDelivered,
  ): Promise<StoredMessage[]> {
    const CHUNK = Math.max(n, 50);
    const result: StoredMessage[] = []; // Collects in desc order (newest first)
    let offset = 0;

    while (result.length < n) {
      const ids = await this.redis.zrevrange(key, offset, offset + CHUNK - 1);
      if (ids.length === 0) break; // Sorted set exhausted

      // Hydrate in desc order (don't reverse — preserve newest-first)
      const messages = await this.hydrateMessages(ids);
      for (const msg of messages) {
        if (!visibilityFilter(msg)) continue;
        if (extraFilter && !extraFilter(msg)) continue;
        result.push(msg);
        if (result.length >= n) break;
      }

      // If Redis returned fewer than CHUNK, the set is exhausted
      if (ids.length < CHUNK) break;
      offset += CHUNK;
    }

    // Take first N (newest) and reverse to ascending order
    return result.slice(0, n).reverse();
  }

  /**
   * Fetch IDs before a composite cursor (timestamp + beforeId) using chunked scanning.
   * Loops until we have `limit` results or exhaust the sorted set.
   */
  private async fetchBeforeWithCursor(
    key: string,
    timestamp: number,
    beforeId: string,
    limit: number,
  ): Promise<string[]> {
    const CHUNK = 50;
    const filtered: string[] = [];
    let offset = 0;

    while (filtered.length < limit) {
      const chunk = await this.redis.zrevrangebyscore(key, String(timestamp), '-inf', 'LIMIT', offset, CHUNK);
      if (chunk.length === 0) break;

      for (const id of chunk) {
        if (filtered.length >= limit) break;
        const score = await this.redis.zscore(key, id);
        if (score !== null && parseRedisNumber(score) === timestamp && id >= beforeId) {
          continue;
        }
        filtered.push(id);
      }

      offset += CHUNK;
    }

    return filtered;
  }

  /**
   * Scan before a cursor (desc), hydrate + apply visibility + optional extra,
   * collecting exactly N visible messages or until sorted set exhaustion.
   * Returns messages in desc order (newest first). Caller must reverse for asc.
   */
  private async fetchVisibleBeforeCursor(
    key: string,
    timestamp: number,
    beforeId: string,
    n: number,
    extraFilter?: (msg: StoredMessage) => boolean,
    visibilityFilter: (msg: StoredMessage) => boolean = isDelivered,
  ): Promise<StoredMessage[]> {
    const CHUNK = 50;
    const result: StoredMessage[] = [];
    let offset = 0;

    while (result.length < n) {
      const chunk = await this.redis.zrevrangebyscore(key, String(timestamp), '-inf', 'LIMIT', offset, CHUNK);
      if (chunk.length === 0) break;

      // Filter cursor boundary (same logic as fetchBeforeWithCursor)
      const validIds: string[] = [];
      for (const id of chunk) {
        const score = await this.redis.zscore(key, id);
        if (score !== null && parseRedisNumber(score) === timestamp && id >= beforeId) {
          continue;
        }
        validIds.push(id);
      }

      if (validIds.length > 0) {
        // Hydrate in desc order (don't reverse)
        const messages = await this.hydrateMessages(validIds);
        for (const msg of messages) {
          if (!visibilityFilter(msg)) continue;
          if (extraFilter && !extraFilter(msg)) continue;
          result.push(msg);
          if (result.length >= n) break;
        }
      }

      if (chunk.length < CHUNK) break;
      offset += CHUNK;
    }

    return result;
  }

  /**
   * Delete all messages in a thread. Returns count of deleted messages.
   */
  async deleteByThread(threadId: string): Promise<number> {
    const key = MessageKeys.thread(threadId);

    // Get all message IDs in this thread
    const ids = await this.redis.zrange(key, 0, -1);

    const pipeline = this.redis.multi();

    // Delete each message hash
    for (const id of ids) {
      pipeline.del(MessageKeys.detail(id));
    }

    // Delete the thread sorted set (even if empty — may still exist as empty key)
    pipeline.del(key);

    // #1200: Delete visibility ZSET + metadata hash (these are permanent — no TTL).
    // Must run even when ids.length === 0: a thread may have migrated metadata
    // but no messages (e.g. after all messages were individually deleted).
    pipeline.del(MessageKeys.threadVisibility(threadId));
    pipeline.del(MessageKeys.threadVisibilityMeta(threadId));

    // Note: We don't clean up global timeline, user timeline, or mention sets
    // as those will auto-expire via TTL. Cleaning them would be O(n) expensive.

    await pipeline.exec();
    return ids.length;
  }

  /**
   * ADR-008 D3: Soft delete — set deletedAt/deletedBy on message hash.
   */
  async softDelete(id: string, deletedBy: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const now = Date.now();
    await this.redis.hset(MessageKeys.detail(id), {
      deletedAt: String(now),
      deletedBy,
    });
    msg.deletedAt = now;
    msg.deletedBy = deletedBy;
    return msg;
  }

  /**
   * ADR-008 D3: Hard delete — wipe content, keep tombstone skeleton.
   */
  async hardDelete(id: string, deletedBy: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const now = Date.now();
    await this.redis.hset(MessageKeys.detail(id), {
      content: '',
      contentBlocks: '',
      toolEvents: '',
      metadata: '',
      extra: '',
      pluginMessage: '',
      thinking: '',
      mentions: '[]',
      deletedAt: String(now),
      deletedBy,
      _tombstone: '1',
    });
    msg.content = '';
    msg.mentions = [];
    delete msg.contentBlocks;
    delete msg.toolEvents;
    delete msg.metadata;
    delete msg.extra;
    delete msg.thinking;
    msg.deletedAt = now;
    msg.deletedBy = deletedBy;
    msg._tombstone = true;
    return msg;
  }

  /**
   * ADR-008 D3: Restore a soft-deleted message — remove deletedAt/deletedBy.
   * Rejects tombstones (hard-deleted messages are irreversible).
   */
  async restore(id: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg || !msg.deletedAt || msg._tombstone) return null;
    await this.redis.hdel(MessageKeys.detail(id), 'deletedAt', 'deletedBy');
    delete msg.deletedAt;
    delete msg.deletedBy;
    return msg;
  }

  /**
   * F35: Reveal all unrevealed whispers in a thread. Returns count of revealed messages.
   */
  async revealWhispers(threadId: string, userId: string): Promise<number> {
    const key = MessageKeys.thread(threadId);
    const ids = await this.redis.zrange(key, 0, -1);
    if (ids.length === 0) return 0;

    const now = String(Date.now());
    let count = 0;
    for (const id of ids) {
      const fields = await this.redis.hmget(MessageKeys.detail(id), 'visibility', 'revealedAt', 'userId');
      if (fields[0] !== 'whisper') continue;
      if (fields[1]) continue; // already revealed
      if (fields[2] !== userId) continue; // only reveal caller's whispers
      await this.redis.hset(MessageKeys.detail(id), 'revealedAt', now);
      count++;
    }
    return count;
  }

  /** F096: Update message extra data (merge semantics — preserves existing fields). */
  async updateExtra(id: string, extra: HostMessageExtra): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const { hostExtra: current, pluginMessage } = splitMessageExtra(msg.extra);
    const merged = { ...current, ...extra };
    const pipeline = this.redis.multi();
    pipeline.hset(MessageKeys.detail(id), { extra: serializeExtra(merged) });
    // Lazy migration for a pre-F288 record whose plugin payload still lives in
    // the legacy extra JSON. HSETNX cannot overwrite a concurrent newer write.
    if (pluginMessage) {
      pipeline.hsetnx(MessageKeys.detail(id), 'pluginMessage', JSON.stringify(pluginMessage));
    }
    await pipeline.exec();
    return this.getById(id);
  }

  async updatePluginMessage(
    id: string,
    pluginMessage: StoredPluginMessage,
    expectedRevision: number,
  ): Promise<StoredMessage | null> {
    const updated = await this.redis.eval(
      UPDATE_PLUGIN_MESSAGE_LUA,
      1,
      MessageKeys.detail(id),
      JSON.stringify(pluginMessage),
      String(expectedRevision),
    );
    if (Number(updated) !== 1) return null;
    return this.getById(id);
  }

  async augmentStreamMetadata(id: string, patch: StreamMetadataAugmentInput): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const augmented = applyStreamMetadataAugment(msg, patch);
    const fields: Record<string, string> = {};
    if (patch.thinking && augmented.thinking) fields.thinking = augmented.thinking;
    if (patch.metadata && augmented.metadata) fields.metadata = JSON.stringify(augmented.metadata);
    if (patch.toolEvents?.length && augmented.toolEvents) fields.toolEvents = JSON.stringify(augmented.toolEvents);
    if (patch.replyTo && augmented.replyTo) fields.replyTo = augmented.replyTo;
    if (patch.mentionsUser && augmented.mentionsUser) fields.mentionsUser = '1';
    const { pluginMessage } = splitMessageExtra(augmented.extra);
    if (patch.extra && augmented.extra) fields.extra = serializeHostExtra(augmented.extra);
    if (Object.keys(fields).length > 0) {
      const pipeline = this.redis.multi();
      pipeline.hset(MessageKeys.detail(id), fields);
      if (pluginMessage) {
        pipeline.hsetnx(MessageKeys.detail(id), 'pluginMessage', JSON.stringify(pluginMessage));
      }
      await pipeline.exec();
    }
    return (await this.getById(id)) ?? augmented;
  }

  /**
   * F098-D: Atomically mark a queued message delivered while preserving the
   * Clowder AI publication score and returning an applied/no-op receipt.
   */
  async markDelivered(id: string, deliveredAt: number): Promise<MarkDeliveredResult | null> {
    assertValidStoredMessageTimestamp(deliveredAt);
    const hashKey = MessageKeys.detail(id);

    // #1200 codex P1: ensure visibility migration before DELIVER Lua marks migrated.
    // We need threadId for ensureVisibilityMigrated — get it from the hash.
    // The extra HGET is acceptable: delivery is a one-time operation per message.
    const threadId = await this.redis.hget(hashKey, 'threadId');
    if (threadId) {
      await this.ensureVisibilityMigrated(threadId);
    }

    // Atomic CAS: queued → delivered + visibilitySeq allocation.
    // #1200: DELIVER_WITH_VISIBILITY_LUA extends the original to atomically allocate
    // a visibilitySeq and ZADD into the visibility index upon delivery.
    // Lua returns HGETALL on CAS win (no separate getById round-trip needed).
    const result = await this.redis.eval(
      DELIVER_WITH_VISIBILITY_LUA,
      1,
      hashKey,
      id,
      String(deliveredAt),
      this.keyPrefix,
    );
    if (result === 0) {
      // CAS no-op: message was not queued (already delivered or not found)
      const existing = await this.getById(id);
      if (!existing) return null;
      return { ...existing, deliveryTransitioned: false };
    }
    const message = this.parseLuaHgetall(result);
    if (!message) throw new Error(`Redis delivery transition lost canonical message: ${id}`);
    return { ...message, deliveryTransitioned: true };
  }

  async initializeQueueCustody(id: string, custody: QueuedMessageCustody): Promise<QueueCustodyInitializeResult> {
    assertQueueCustodyMessageBinding({ deliveryStatus: 'queued', queueCustody: custody });
    const outcome = Number(
      await this.redis.eval(
        INITIALIZE_QUEUE_CUSTODY_LUA,
        1,
        MessageKeys.detail(id),
        JSON.stringify(custody),
        String(custody.revision),
      ),
    );
    if (outcome === -1) return { kind: 'not_found' };
    if (outcome === -2) return { kind: 'not_queued' };
    const message = await this.getById(id);
    if (!message) return { kind: 'not_found' };
    if (outcome === 0) return { kind: 'existing', message };
    if (outcome !== 1) throw new Error(`unexpected queue custody initialize result: ${outcome}`);
    return { kind: 'initialized', message };
  }

  async transitionQueueCustody(id: string, input: QueueCustodyTransitionInput): Promise<QueueCustodyTransitionResult> {
    if (input.deliveredAt !== undefined) assertValidStoredMessageTimestamp(input.deliveredAt);
    const current = await this.getById(id);
    if (!current?.queueCustody) return { kind: 'not_found' };
    if (current.queueCustody.revision !== input.expectedRevision) {
      return { kind: 'revision_mismatch', actualRevision: current.queueCustody.revision };
    }
    if (current.deliveryStatus !== 'queued') {
      throw new Error('queue custody transition requires a queued message');
    }
    assertQueueCustodyTransition(current.queueCustody, input);
    const timelineScore =
      input.deliveredAt === undefined ? undefined : resolveDeliveryTimelineScore(current, input.deliveredAt);

    // #1269 P1-2: ensure visibility migration before delivery (same as markDelivered).
    // Custody transitions without delivery skip this (no visibility allocation needed).
    if (input.deliveredAt !== undefined) {
      await this.ensureVisibilityMigrated(current.threadId);
    }

    const rawResult = (await this.redis.eval(
      TRANSITION_QUEUE_CUSTODY_LUA,
      4,
      MessageKeys.detail(id),
      MessageKeys.thread(current.threadId),
      MessageKeys.TIMELINE,
      MessageKeys.user(current.userId),
      String(input.expectedRevision),
      JSON.stringify(input.next),
      String(input.next.revision),
      input.deliveredAt === undefined ? '' : String(input.deliveredAt),
      timelineScore === undefined ? '' : String(timelineScore),
      this.keyPrefix, // [6] keyPrefix for visibility key construction inside Lua
    )) as [number | string, number | string];
    const outcome = Number(rawResult[0]);
    const actualRevision = Number(rawResult[1]);
    if (outcome === -1) return { kind: 'not_found' };
    if (outcome === 0) return { kind: 'revision_mismatch', actualRevision };
    if (outcome === -2) throw new Error('queue custody transition requires a queued message');
    if (outcome !== 1 && outcome !== 2) throw new Error(`unexpected queue custody transition result: ${outcome}`);

    const updated = await this.getById(id);
    if (!updated) throw new Error(`queue custody transition lost stored message: ${id}`);
    return { kind: 'updated', message: updated, deliveryTransitioned: outcome === 2 };
  }

  /**
   * F117: Mark a queued message as canceled (withdraw/clear).
   * #1200: CANCEL_WITH_VISIBILITY_LUA extends the original to ZREM from the
   * visibility index (handles backfilled legacy queued members).
   */
  async markCanceled(id: string): Promise<MarkCanceledResult | null> {
    const hashKey = MessageKeys.detail(id);
    // Atomic CAS: queued → canceled + visibility ZREM.
    const result = await this.redis.eval(CANCEL_WITH_VISIBILITY_LUA, 1, hashKey, this.keyPrefix);
    if (result === 0) {
      const existing = await this.getById(id);
      if (!existing) return null;
      return { ...existing, deliveryTransitioned: false };
    }
    const message = this.parseLuaHgetall(result);
    if (!message) throw new Error(`Redis cancellation transition lost canonical message: ${id}`);
    return { ...message, deliveryTransitioned: true };
  }

  /**
   * Atomic content-dedup claim via SET NX PX. Returns true on first claim within the window,
   * false if an identical claim is still live (concurrent or recent byte-identical post). This
   * is the race-safe gate for the callback exact-duplicate scan.
   */
  async claimContentDedupKey(key: string, ttlMs: number): Promise<boolean> {
    const claimed = await this.redis.set(
      MessageKeys.contentDedup(key),
      '1',
      'PX',
      Math.max(1, Math.floor(ttlMs)),
      'NX',
    );
    return claimed === 'OK';
  }

  /**
   * #697: Scan for message IDs matching a given deliveryStatus.
   * Uses SCAN + pipeline HGET pattern (same as InvocationRecordStore.scanByStatus).
   * Called by StartupReconciler to find orphaned queued messages after restart.
   */
  async scanByDeliveryStatus(status: string): Promise<string[]> {
    const matchPattern = `${this.keyPrefix}${MessageKeys.detail('*')}`;
    const ids: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of keys) {
          pipeline.hget(this.stripPrefix(key), 'deliveryStatus');
        }
        const results = await pipeline.exec();
        for (let i = 0; i < keys.length; i++) {
          const [err, val] = results?.[i] ?? [null, null];
          if (!err && val === status) {
            ids.push(this.stripPrefix(keys[i]!).replace(/^msg:/, ''));
          }
        }
      }
    } while (cursor !== '0');
    return ids;
  }

  /** Hydrate message IDs into full StoredMessage objects */
  private async hydrateMessages(ids: string[], options?: { includeDeleted?: boolean }): Promise<StoredMessage[]> {
    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.hgetall(MessageKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const messages: StoredMessage[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.id) continue;

      const deletedAt = d.deletedAt ? parseInt(d.deletedAt, 10) : undefined;

      // ADR-008 D3: skip soft-deleted messages unless includeDeleted
      if (deletedAt && !options?.includeDeleted) continue;

      const contentBlocks = safeParseContentBlocks(d.contentBlocks);
      const toolEvents = safeParseToolEvents(d.toolEvents);
      const parsedMetadata = safeParseMetadata(d.metadata);
      const parsedExtra = hydrateExtra(d.extra, d.pluginMessage);
      const parsedSource = safeParseConnectorSource(d.source);
      const parsedQueueCustody = safeParseQueueCustody(d.queueCustody);
      messages.push({
        id: d.id,
        threadId: d.threadId || DEFAULT_THREAD_ID,
        userId: d.userId ?? 'unknown',
        catId: (d.catId || null) as CatId | null,
        content: d.content ?? '',
        ...(contentBlocks ? { contentBlocks } : {}),
        ...(toolEvents ? { toolEvents } : {}),
        ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
        ...(parsedExtra ? { extra: parsedExtra } : {}),
        mentions: safeParseMentions(d.mentions),
        timestamp: parseStoredMessageTimestamp(d.timestamp),
        ...(deletedAt ? { deletedAt, deletedBy: d.deletedBy ?? '' } : {}),
        ...(d._tombstone === '1' ? { _tombstone: true as const } : {}),
        ...(d.thinking ? { thinking: d.thinking } : {}),
        ...(d.origin === 'stream' || d.origin === 'callback' || d.origin === 'briefing'
          ? { origin: d.origin as 'stream' | 'callback' | 'briefing' }
          : {}),
        ...(d.visibility === 'whisper' ? { visibility: 'whisper' as const } : {}),
        ...(d.whisperTo ? { whisperTo: safeParseMentions(d.whisperTo) } : {}),
        ...(d.revealedAt ? { revealedAt: parseInt(d.revealedAt, 10) } : {}),
        ...(d.deliveredAt ? { deliveredAt: parseRedisNumber(d.deliveredAt) } : {}),
        ...(d.timelineOrderAt !== undefined ? { timelineOrderAt: parseRedisNumber(d.timelineOrderAt) } : {}),
        ...(d.deliveryStatus ? { deliveryStatus: d.deliveryStatus as StoredMessage['deliveryStatus'] } : {}),
        ...(parsedQueueCustody ? { queueCustody: parsedQueueCustody } : {}),
        ...(parsedSource ? { source: parsedSource } : {}),
        ...(d.mentionsUser === '1' ? { mentionsUser: true } : {}),
        ...(d.replyTo ? { replyTo: d.replyTo } : {}),
        // #1200 Sol R6 P2-1: Inject visibilitySeq from hash (parity with hydrateHash).
        // Without this, getRecentMentionsFor returns items without visibilitySeq,
        // causing cursorFor to emit v1 while getter cursors are v2 → cross-format.
        ...(d.visibilitySeq ? { visibilitySeq: parseInt(d.visibilitySeq, 10) } : {}),
      });
    }
    return messages;
  }
}
