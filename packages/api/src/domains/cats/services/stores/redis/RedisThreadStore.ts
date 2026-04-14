/**
 * Redis Thread Store
 * Redis-backed thread storage with same interface as in-memory ThreadStore.
 *
 * Redis 数据结构:
 *   cat-cafe:thread:{threadId}              → Hash (对话详情)
 *   cat-cafe:thread:{threadId}:participants  → Set (参与猫)
 *   cat-cafe:threads:user:{userId}          → Sorted Set (用户对话列表, score=lastActiveAt)
 *
 * TTL 默认 30 天。
 */

import type { CatId, ThreadPhase } from '@cat-cafe/shared';
import { generateThreadId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  BootcampStateV1,
  ConnectorHubStateV1,
  IThreadStore,
  MentionActionabilityMode,
  Thread,
  ThreadMemoryV1,
  ThreadMentionRoutingFeedback,
  ThreadParticipantActivity,
  ThreadRoutingPolicyV1,
  VotingStateV1,
} from '../ports/ThreadStore.js';
import { DEFAULT_THREAD_ID } from '../ports/ThreadStore.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { ThreadKeys } from '../redis-keys/thread-keys.js';

const DEFAULT_TTL = 0; // persistent — set >0 via env to enable expiry

/**
 * Atomic hash update guard:
 * only applies HSET when the thread hash has a canonical `id` field.
 * Prevents late updates from recreating orphan hashes after delete races.
 */
const HSET_IF_HAS_ID_LUA = `
if redis.call('HEXISTS', KEYS[1], 'id') == 0 then
  return 0
end
redis.call('HSET', KEYS[1], unpack(ARGV))
return 1
`;

/**
 * Atomic participants guard:
 * only applies SADD when the thread detail hash has canonical `id`.
 * Prevents delete/addParticipants race from recreating orphan participant sets.
 */
const SADD_IF_DETAIL_HAS_ID_LUA = `
if redis.call('HEXISTS', KEYS[1], 'id') == 0 then
  return 0
end
redis.call('SADD', KEYS[2], unpack(ARGV))
return 1
`;

/**
 * Cloud Codex P2 fix: Atomic participant activity update guard.
 * Only updates activity when the thread detail hash has canonical `id`.
 * KEYS[1] = detail key, KEYS[2] = participants key, KEYS[3] = activity key
 * ARGV[1] = catId, ARGV[2] = timestamp, ARGV[3] = ttl (or -1 for no expiration)
 *
 * Cloud Codex R2 P2 fix: Also refresh detail TTL to prevent detail expiring
 * before participants/activity (which would cause routing to non-existent thread).
 */
const UPDATE_ACTIVITY_IF_DETAIL_HAS_ID_LUA = `
if redis.call('HEXISTS', KEYS[1], 'id') == 0 then
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1] .. ':lastMessageAt', ARGV[2])
redis.call('HINCRBY', KEYS[3], ARGV[1] .. ':messageCount', 1)
redis.call('HSET', KEYS[3], ARGV[1] .. ':healthy', ARGV[4])
local ttl = tonumber(ARGV[3])
if ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
else
  redis.call('PERSIST', KEYS[1])
  redis.call('PERSIST', KEYS[2])
  redis.call('PERSIST', KEYS[3])
end
return 1
`;

/**
 * Atomically read and clear a one-shot mention-routing feedback payload.
 * KEYS[1] = feedback hash key, ARGV[1] = catId
 */
const HGETDEL_LUA = `
local value = redis.call('HGET', KEYS[1], ARGV[1])
if value then
  redis.call('HDEL', KEYS[1], ARGV[1])
end
return value
`;

/**
 * Atomic thread deletion: DEL detail + related keys + conditional tombstone.
 * Prevents race where get() → recoverThreadFromMessages() resurrects between
 * pipeline DEL and non-atomic tombstone SET.
 * KEYS[1]=detail, KEYS[2]=participants, KEYS[3]=activity,
 * KEYS[4]=mentionFeedback, KEYS[5]=tombstone [, KEYS[6]=userList]
 * ARGV[1]=threadId (for optional ZREM from userList)
 */
const DELETE_THREAD_LUA = `
local deleted = redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
if #KEYS >= 6 then
  redis.call('ZREM', KEYS[6], ARGV[1])
end
if deleted > 0 then
  redis.call('SET', KEYS[5], '1')
end
return deleted
`;

/** R1 P2-1: Shared validation for ThreadMemoryV1 JSON — rejects incomplete/corrupt data. */
function parseThreadMemoryJson(raw: string): ThreadMemoryV1 | null {
  try {
    const p = JSON.parse(raw);
    if (
      p &&
      typeof p === 'object' &&
      p.v === 1 &&
      typeof p.summary === 'string' &&
      Number.isFinite(p.sessionsIncorporated) &&
      Number.isFinite(p.updatedAt)
    ) {
      return p as ThreadMemoryV1;
    }
    return null;
  } catch {
    return null;
  }
}

export class RedisThreadStore implements IThreadStore {
  private readonly redis: RedisClient;
  /** null means no expiration. */
  private readonly ttlSeconds: number | null;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number }) {
    this.redis = redis;
    const raw = options?.ttlSeconds ?? DEFAULT_TTL;
    if (!Number.isFinite(raw) || raw <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(raw);
    }
  }

  async create(userId: string, title?: string, projectPath?: string): Promise<Thread> {
    const now = Date.now();
    const thread: Thread = {
      id: generateThreadId(),
      projectPath: projectPath ?? 'default',
      title: title ?? null,
      createdBy: userId,
      participants: [],
      lastActiveAt: now,
      createdAt: now,
    };

    const key = ThreadKeys.detail(thread.id);
    const pipeline = this.redis.multi();
    pipeline.hset(key, this.serializeThread(thread));
    if (this.ttlSeconds !== null) {
      pipeline.expire(key, this.ttlSeconds);
    }
    pipeline.zadd(ThreadKeys.userList(userId), String(now), thread.id);
    if (this.ttlSeconds !== null) {
      pipeline.expire(ThreadKeys.userList(userId), this.ttlSeconds);
    }
    await pipeline.exec();

    return thread;
  }

  async get(threadId: string): Promise<Thread | null> {
    const data = await this.redis.hgetall(ThreadKeys.detail(threadId));
    if (!data || !data.id) {
      if (threadId === DEFAULT_THREAD_ID) {
        return this.createDefaultThread();
      }
      return this.recoverThreadFromMessages(threadId);
    }

    const thread = this.hydrateThread(data);
    // Load participants from Set
    const members = await this.redis.smembers(ThreadKeys.participants(threadId));
    thread.participants = members as CatId[];
    return thread;
  }

  async list(userId: string): Promise<Thread[]> {
    const ids = await this.redis.zrevrange(ThreadKeys.userList(userId), 0, -1);

    // Ensure default thread is included
    const hasDefault = ids.includes(DEFAULT_THREAD_ID);
    if (!hasDefault) ids.push(DEFAULT_THREAD_ID);

    const threads: Thread[] = [];
    for (const id of ids) {
      const thread = await this.get(id);
      if (thread && !thread.deletedAt) threads.push(thread);
    }

    // Sort by lastActiveAt descending
    threads.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return threads;
  }

  async listByProject(userId: string, projectPath: string): Promise<Thread[]> {
    const all = await this.list(userId);
    return all.filter((t) => t.projectPath === projectPath);
  }

  async addParticipants(threadId: string, catIds: CatId[]): Promise<void> {
    if (catIds.length === 0) return;
    const detailKey = ThreadKeys.detail(threadId);
    const participantsKey = ThreadKeys.participants(threadId);
    if (threadId === DEFAULT_THREAD_ID) {
      const hasDefaultDetail = await this.redis.hexists(detailKey, 'id');
      if (hasDefaultDetail === 0) {
        await this.createDefaultThread();
      }
    }
    const updated = (await this.redis.eval(
      SADD_IF_DETAIL_HAS_ID_LUA,
      2,
      detailKey,
      participantsKey,
      ...catIds,
    )) as number;
    if (updated === 0) return;

    // Cloud Codex P1 fix: Do NOT update activity here.
    // Activity should only be updated via updateParticipantActivity() after successful message append.
    await this.applyKeyRetention([participantsKey]);
  }

  async getParticipants(threadId: string): Promise<CatId[]> {
    const members = await this.redis.smembers(ThreadKeys.participants(threadId));
    return members as CatId[];
  }

  /** F032 Phase C: Get participants with activity, sorted by lastMessageAt descending */
  async getParticipantsWithActivity(threadId: string): Promise<ThreadParticipantActivity[]> {
    const participants = await this.getParticipants(threadId);
    if (participants.length === 0) return [];

    const activityKey = ThreadKeys.activity(threadId);
    const activityData = await this.redis.hgetall(activityKey);

    const result: ThreadParticipantActivity[] = participants.map((catId) => {
      const lastMessageAt = parseInt(activityData[`${catId}:lastMessageAt`] ?? '0', 10);
      const messageCount = parseInt(activityData[`${catId}:messageCount`] ?? '0', 10);
      const healthyRaw = activityData[`${catId}:healthy`];
      const lastResponseHealthy = healthyRaw === undefined ? undefined : healthyRaw === '1';
      return { catId, lastMessageAt, messageCount, lastResponseHealthy };
    });

    // Sort by lastMessageAt descending (most recent first)
    result.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return result;
  }

  /** F032 P1-2 fix: Update participant activity on every message */
  async updateParticipantActivity(threadId: string, catId: CatId, healthy?: boolean): Promise<void> {
    // Cloud Codex P2 fix: Use Lua script to atomically check thread existence
    // and update activity with TTL refresh.
    const detailKey = ThreadKeys.detail(threadId);
    const participantsKey = ThreadKeys.participants(threadId);
    const activityKey = ThreadKeys.activity(threadId);
    const now = Date.now();
    const ttl = this.ttlSeconds ?? -1;

    await this.redis.eval(
      UPDATE_ACTIVITY_IF_DETAIL_HAS_ID_LUA,
      3,
      detailKey,
      participantsKey,
      activityKey,
      catId,
      String(now),
      String(ttl),
      healthy === false ? '0' : '1',
    );
  }

  async updateTitle(threadId: string, title: string): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.setDetailFields(key, 'title', title);
  }

  async updateProjectPath(threadId: string, projectPath: string): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.setDetailFields(key, 'projectPath', projectPath);
  }

  async updatePin(threadId: string, pinned: boolean): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.setDetailFields(key, 'pinned', String(pinned), 'pinnedAt', pinned ? String(Date.now()) : '0');
  }

  async updateFavorite(threadId: string, favorited: boolean): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.setDetailFields(
      key,
      'favorited',
      String(favorited),
      'favoritedAt',
      favorited ? String(Date.now()) : '0',
    );
  }

  async updateThinkingMode(threadId: string, mode: 'debug' | 'play'): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.setDetailFields(key, 'thinkingMode', mode);
  }

  async updateMentionActionabilityMode(threadId: string, mode: MentionActionabilityMode): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    // strict is default behavior; clearing keeps storage backward-compatible.
    if (mode === 'strict') {
      await this.deleteDetailFields(key, 'mentionActionabilityMode');
      return;
    }
    await this.setDetailFields(key, 'mentionActionabilityMode', mode);
  }

  async updatePreferredCats(threadId: string, catIds: CatId[]): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    // R5 fix: dedupe at write time to prevent duplicate invocations
    const unique = [...new Set(catIds)];
    // Store as JSON array string; empty array → remove field
    if (unique.length > 0) {
      await this.setDetailFields(key, 'preferredCats', JSON.stringify(unique));
    } else {
      // Remove the field entirely (clear preference)
      await this.deleteDetailFields(key, 'preferredCats');
    }
  }

  async updatePhase(threadId: string, phase: ThreadPhase): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.setDetailFields(key, 'phase', phase);
  }

  async linkBacklogItem(threadId: string, backlogItemId: string): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.setDetailFields(key, 'backlogItemId', backlogItemId);
  }

  async setMentionRoutingFeedback(
    threadId: string,
    catId: CatId,
    feedback: ThreadMentionRoutingFeedback,
  ): Promise<void> {
    const detailKey = ThreadKeys.detail(threadId);
    const exists = await this.redis.hexists(detailKey, 'id');
    if (exists === 0) return;

    const feedbackKey = ThreadKeys.mentionRoutingFeedback(threadId);
    await this.redis.hset(feedbackKey, catId, JSON.stringify(feedback));
    if (this.ttlSeconds !== null) {
      await this.redis.expire(feedbackKey, this.ttlSeconds);
    }
  }

  async consumeMentionRoutingFeedback(threadId: string, catId: CatId): Promise<ThreadMentionRoutingFeedback | null> {
    const feedbackKey = ThreadKeys.mentionRoutingFeedback(threadId);
    const raw = (await this.redis.eval(HGETDEL_LUA, 1, feedbackKey, catId)) as string | null;
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as ThreadMentionRoutingFeedback;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async updateRoutingPolicy(threadId: string, policy: ThreadRoutingPolicyV1 | null): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    const scopes = policy?.scopes;
    const hasScopes = scopes && Object.keys(scopes).length > 0;

    if (!policy || policy.v !== 1 || !hasScopes) {
      await this.deleteDetailFields(key, 'routingPolicy');
      return;
    }

    await this.setDetailFields(key, 'routingPolicy', JSON.stringify(policy));
  }

  async getThreadMemory(threadId: string): Promise<ThreadMemoryV1 | null> {
    const key = ThreadKeys.detail(threadId);
    const raw = await this.redis.hget(key, 'threadMemory');
    if (!raw) return null;
    return parseThreadMemoryJson(raw);
  }

  async updateThreadMemory(threadId: string, memory: ThreadMemoryV1): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.setDetailFields(key, 'threadMemory', JSON.stringify(memory));
  }

  async getVotingState(threadId: string): Promise<VotingStateV1 | null> {
    const key = ThreadKeys.detail(threadId);
    const raw = await this.redis.hget(key, 'votingState');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as VotingStateV1;
    } catch {
      return null;
    }
  }

  async updateVotingState(threadId: string, state: VotingStateV1 | null): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    if (state === null) {
      await this.deleteDetailFields(key, 'votingState');
    } else {
      await this.setDetailFields(key, 'votingState', JSON.stringify(state));
    }
  }

  async updateBootcampState(threadId: string, state: BootcampStateV1 | null): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    if (state === null) {
      await this.deleteDetailFields(key, 'bootcampState');
    } else {
      await this.setDetailFields(key, 'bootcampState', JSON.stringify(state));
    }
  }

  async updateConnectorHubState(threadId: string, state: ConnectorHubStateV1 | null): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    if (state === null) {
      await this.deleteDetailFields(key, 'connectorHubState');
    } else {
      await this.setDetailFields(key, 'connectorHubState', JSON.stringify(state));
    }
  }

  async updateBubbleDisplay(
    threadId: string,
    field: 'bubbleThinking' | 'bubbleCli',
    value: 'global' | 'expanded' | 'collapsed',
  ): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    if (value === 'global') {
      await this.deleteDetailFields(key, field);
    } else {
      await this.setDetailFields(key, field, value);
    }
  }

  async updateVoiceMode(threadId: string, voiceMode: boolean): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    if (voiceMode) {
      await this.setDetailFields(key, 'voiceMode', '1');
    } else {
      await this.deleteDetailFields(key, 'voiceMode');
    }
  }

  async updateLastActive(threadId: string): Promise<void> {
    const now = String(Date.now());
    const key = ThreadKeys.detail(threadId);
    const updated = (await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'lastActiveAt', now)) as number;
    if (updated === 0) return;

    // Update score in all user lists that contain this thread
    const createdBy = await this.redis.hget(key, 'createdBy');
    if (createdBy) {
      await this.redis.zadd(ThreadKeys.userList(createdBy), now, threadId);
      await this.applyKeyRetention([key, ThreadKeys.userList(createdBy)]);
    }
  }

  /** F095 Phase D: Soft-delete — set deletedAt timestamp. */
  async softDelete(threadId: string): Promise<boolean> {
    if (threadId === DEFAULT_THREAD_ID) return false;
    const key = ThreadKeys.detail(threadId);
    const existing = await this.redis.hget(key, 'id');
    if (!existing) return false;
    // Already soft-deleted?
    const existingDeletedAt = await this.redis.hget(key, 'deletedAt');
    if (existingDeletedAt && parseInt(existingDeletedAt, 10) > 0) return false;
    await this.redis.hset(key, 'deletedAt', String(Date.now()));
    await this.applyKeyRetention([key]);
    return true;
  }

  /** F095 Phase D: Restore a soft-deleted thread. */
  async restore(threadId: string): Promise<boolean> {
    const key = ThreadKeys.detail(threadId);
    const existing = await this.redis.hget(key, 'id');
    if (!existing) return false;
    const existingDeletedAt = await this.redis.hget(key, 'deletedAt');
    if (!existingDeletedAt || parseInt(existingDeletedAt, 10) <= 0) return false;
    await this.redis.hset(key, 'deletedAt', '0');
    await this.applyKeyRetention([key]);
    return true;
  }

  /** F095 Phase D: List soft-deleted threads (trash bin). */
  async listDeleted(userId: string): Promise<Thread[]> {
    const ids = await this.redis.zrevrange(ThreadKeys.userList(userId), 0, -1);
    const threads: Thread[] = [];
    for (const id of ids) {
      const thread = await this.get(id);
      if (thread?.deletedAt) {
        threads.push(thread);
      }
    }
    threads.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    return threads;
  }

  async delete(threadId: string): Promise<boolean> {
    if (threadId === DEFAULT_THREAD_ID) return false;

    const key = ThreadKeys.detail(threadId);
    const createdBy = await this.redis.hget(key, 'createdBy');

    // Atomic Lua: DEL + tombstone in one round-trip — no race window for
    // get() → recoverThreadFromMessages() to resurrect between DEL and SET.
    const keys: string[] = [
      key,
      ThreadKeys.participants(threadId),
      ThreadKeys.activity(threadId),
      ThreadKeys.mentionRoutingFeedback(threadId),
      ThreadKeys.tombstone(threadId),
    ];
    if (createdBy) {
      keys.push(ThreadKeys.userList(createdBy));
    }
    const result = await this.redis.eval(DELETE_THREAD_LUA, keys.length, ...keys, threadId);
    return (result as number) > 0;
  }

  private async createDefaultThread(): Promise<Thread> {
    const now = Date.now();
    const thread: Thread = {
      id: DEFAULT_THREAD_ID,
      projectPath: 'default',
      title: null,
      createdBy: 'system',
      participants: [],
      lastActiveAt: now,
      createdAt: now,
    };

    const key = ThreadKeys.detail(DEFAULT_THREAD_ID);
    await this.redis.hset(key, this.serializeThread(thread));
    if (this.ttlSeconds !== null) {
      await this.redis.expire(key, this.ttlSeconds);
    }
    return thread;
  }

  private async recoverThreadFromMessages(threadId: string): Promise<Thread | null> {
    // Don't resurrect intentionally hard-deleted threads
    const tombstone = await this.redis.get(ThreadKeys.tombstone(threadId));
    if (tombstone) return null;

    const timelineKey = MessageKeys.thread(threadId);
    const [firstIds, lastIds] = await Promise.all([
      this.redis.zrange(timelineKey, 0, 4),
      this.redis.zrevrange(timelineKey, 0, 4),
    ]);
    if (firstIds.length === 0 && lastIds.length === 0) {
      return null;
    }

    const candidateIds = [...new Set([...firstIds, ...lastIds])];
    const candidateMessages = await this.loadMessageSnapshots(candidateIds);
    const firstMessage = firstIds.map((id) => candidateMessages.get(id)).find((msg) => msg !== null);
    const lastMessage = lastIds.map((id) => candidateMessages.get(id)).find((msg) => msg !== null);
    if (!firstMessage || !lastMessage) {
      return null;
    }

    const participants = await this.recoverParticipants(threadId, candidateIds, candidateMessages);
    const recovered: Thread = {
      id: threadId,
      projectPath: 'default',
      title: this.deriveRecoveredTitle(firstMessage.content),
      createdBy: firstMessage.userId,
      participants,
      createdAt: firstMessage.timestamp,
      lastActiveAt: lastMessage.timestamp,
      thinkingMode: 'debug',
    };

    const detailKey = ThreadKeys.detail(threadId);
    const participantsKey = ThreadKeys.participants(threadId);
    const userListKey = ThreadKeys.userList(recovered.createdBy);
    const pipeline = this.redis.multi();
    pipeline.hset(detailKey, this.serializeThread(recovered));
    pipeline.zadd(userListKey, String(recovered.lastActiveAt), threadId);
    if (participants.length > 0) {
      pipeline.sadd(participantsKey, ...participants);
    }
    await pipeline.exec();
    await this.applyKeyRetention([detailKey, participantsKey, userListKey]);
    return recovered;
  }

  private async loadMessageSnapshots(messageIds: string[]): Promise<Map<string, RecoveredMessageSnapshot | null>> {
    if (messageIds.length === 0) return new Map();
    const pipeline = this.redis.multi();
    for (const messageId of messageIds) {
      pipeline.hgetall(MessageKeys.detail(messageId));
    }
    const results = await pipeline.exec();
    const snapshots = new Map<string, RecoveredMessageSnapshot | null>();
    for (let i = 0; i < messageIds.length; i += 1) {
      const data = results?.[i]?.[1];
      if (!data || typeof data !== 'object') {
        snapshots.set(messageIds[i], null);
        continue;
      }
      const hash = data as Record<string, string>;
      if (!hash.id || !hash.userId) {
        snapshots.set(messageIds[i], null);
        continue;
      }
      snapshots.set(messageIds[i], {
        id: hash.id,
        userId: hash.userId,
        catId: hash.catId || null,
        content: hash.content ?? '',
        timestamp: parseInt(hash.timestamp ?? '0', 10),
      });
    }
    return snapshots;
  }

  private async recoverParticipants(
    threadId: string,
    messageIds: string[],
    candidateMessages: Map<string, RecoveredMessageSnapshot | null>,
  ): Promise<CatId[]> {
    const activityData = await this.redis.hgetall(ThreadKeys.activity(threadId));
    const fromActivity = [
      ...new Set(
        Object.keys(activityData)
          .map((key) => key.split(':')[0])
          .filter(Boolean),
      ),
    ];
    if (fromActivity.length > 0) {
      return fromActivity as CatId[];
    }

    const fromMessages = messageIds
      .map((id) => candidateMessages.get(id))
      .filter((message): message is RecoveredMessageSnapshot => Boolean(message?.catId))
      .map((message) => message.catId as CatId);
    return [...new Set(fromMessages)];
  }

  private deriveRecoveredTitle(content: string): string | null {
    const normalized = content.trim();
    if (!normalized) return null;
    return normalized.length > 30 ? `${normalized.slice(0, 30)}...` : normalized;
  }

  private async applyKeyRetention(keys: string[]): Promise<void> {
    const uniqueKeys = [...new Set(keys.filter(Boolean))];
    if (uniqueKeys.length === 0) return;
    const pipeline = this.redis.multi();
    for (const key of uniqueKeys) {
      if (this.ttlSeconds === null) {
        pipeline.persist(key);
      } else {
        pipeline.expire(key, this.ttlSeconds);
      }
    }
    await pipeline.exec();
  }

  private async setDetailFields(key: string, ...fields: string[]): Promise<void> {
    const updated = (await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, ...fields)) as number;
    if (updated === 0) return;
    await this.applyKeyRetention([key]);
  }

  private async deleteDetailFields(key: string, ...fields: string[]): Promise<void> {
    if (fields.length === 0) return;
    await this.redis.hdel(key, ...fields);
    await this.applyKeyRetention([key]);
  }

  private serializeThread(thread: Thread): Record<string, string> {
    const result: Record<string, string> = {
      id: thread.id,
      projectPath: thread.projectPath,
      title: thread.title ?? '',
      createdBy: thread.createdBy,
      lastActiveAt: String(thread.lastActiveAt),
      createdAt: String(thread.createdAt),
      pinned: String(thread.pinned ?? false),
      pinnedAt: String(thread.pinnedAt ?? 0),
      favorited: String(thread.favorited ?? false),
      favoritedAt: String(thread.favoritedAt ?? 0),
      thinkingMode: thread.thinkingMode ?? 'debug',
    };
    if (thread.phase) {
      result.phase = thread.phase;
    }
    if (thread.backlogItemId) {
      result.backlogItemId = thread.backlogItemId;
    }
    if (thread.preferredCats && thread.preferredCats.length > 0) {
      result.preferredCats = JSON.stringify(thread.preferredCats);
    }
    if (thread.mentionActionabilityMode === 'relaxed') {
      result.mentionActionabilityMode = 'relaxed';
    }
    if (thread.routingPolicy) {
      result.routingPolicy = JSON.stringify(thread.routingPolicy);
    }
    if (thread.threadMemory) {
      result.threadMemory = JSON.stringify(thread.threadMemory);
    }
    if (thread.voiceMode) {
      result.voiceMode = '1';
    }
    if (thread.deletedAt) {
      result.deletedAt = String(thread.deletedAt);
    }
    if (thread.bootcampState) {
      result.bootcampState = JSON.stringify(thread.bootcampState);
    }
    if (thread.connectorHubState) {
      result.connectorHubState = JSON.stringify(thread.connectorHubState);
    }
    return result;
  }

  private hydrateThread(data: Record<string, string>): Thread {
    const pinnedAt = parseInt(data.pinnedAt ?? '0', 10);
    const favoritedAt = parseInt(data.favoritedAt ?? '0', 10);
    const result: Thread = {
      id: data.id ?? '',
      projectPath: data.projectPath ?? 'default',
      title: data.title || null,
      createdBy: data.createdBy ?? 'unknown',
      participants: [], // Loaded separately from Set
      lastActiveAt: parseInt(data.lastActiveAt ?? '0', 10),
      createdAt: parseInt(data.createdAt ?? '0', 10),
      pinned: data.pinned === 'true',
      pinnedAt: pinnedAt || null,
      favorited: data.favorited === 'true',
      favoritedAt: favoritedAt || null,
      thinkingMode: (data.thinkingMode === 'debug' ? 'debug' : 'play') as 'debug' | 'play',
    };
    if (data.mentionActionabilityMode === 'relaxed') {
      result.mentionActionabilityMode = 'relaxed';
    }
    const phase = this.parsePhase(data.phase);
    if (phase) {
      result.phase = phase;
    }
    if (data.backlogItemId) {
      result.backlogItemId = data.backlogItemId;
    }
    if (data.preferredCats) {
      try {
        const parsed = JSON.parse(data.preferredCats);
        // Cloud P1: guard against valid-but-non-array JSON (e.g. '{}', '"str"')
        if (Array.isArray(parsed)) {
          result.preferredCats = parsed as CatId[];
        }
      } catch {
        /* ignore malformed JSON — treat as no preference */
      }
    }

    if (data.routingPolicy) {
      try {
        const parsed = JSON.parse(data.routingPolicy);
        // Minimal validation: object with v===1
        if (parsed && typeof parsed === 'object' && parsed.v === 1) {
          result.routingPolicy = parsed as ThreadRoutingPolicyV1;
        }
      } catch {
        /* ignore malformed JSON — treat as no policy */
      }
    }
    if (data.threadMemory) {
      const mem = parseThreadMemoryJson(data.threadMemory);
      if (mem) result.threadMemory = mem;
    }
    if (data.voiceMode === '1') {
      result.voiceMode = true;
    }
    if (data.bubbleThinking === 'expanded' || data.bubbleThinking === 'collapsed') {
      result.bubbleThinking = data.bubbleThinking;
    }
    if (data.bubbleCli === 'expanded' || data.bubbleCli === 'collapsed') {
      result.bubbleCli = data.bubbleCli;
    }
    const deletedAt = parseInt(data.deletedAt ?? '0', 10);
    if (deletedAt > 0) {
      result.deletedAt = deletedAt;
    }
    if (data.bootcampState) {
      try {
        const parsed = JSON.parse(data.bootcampState);
        if (parsed && typeof parsed === 'object' && parsed.v === 1) {
          result.bootcampState = parsed as BootcampStateV1;
        }
      } catch {
        /* ignore malformed JSON */
      }
    }
    if (data.connectorHubState) {
      try {
        const parsed = JSON.parse(data.connectorHubState);
        if (parsed && typeof parsed === 'object' && parsed.v === 1) {
          result.connectorHubState = parsed as ConnectorHubStateV1;
        }
      } catch {
        /* ignore malformed JSON */
      }
    }
    return result;
  }

  private parsePhase(raw: string | undefined): ThreadPhase | undefined {
    if (!raw) return undefined;
    if (raw === 'coding' || raw === 'research' || raw === 'brainstorm') {
      return raw;
    }
    return undefined;
  }
}

type RecoveredMessageSnapshot = {
  id: string;
  userId: string;
  catId: string | null;
  content: string;
  timestamp: number;
};
