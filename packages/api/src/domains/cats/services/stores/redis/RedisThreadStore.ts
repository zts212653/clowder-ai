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
import { ThreadKeys } from '../redis-keys/thread-keys.js';

const DEFAULT_TTL = 30 * 24 * 60 * 60; // 30 days

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
    const ttl = options?.ttlSeconds;
    if (ttl === undefined) {
      this.ttlSeconds = DEFAULT_TTL;
    } else if (!Number.isFinite(ttl)) {
      this.ttlSeconds = DEFAULT_TTL;
    } else if (ttl <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(ttl);
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
      return null;
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
    // Only refresh TTL for participants key.
    if (this.ttlSeconds !== null) {
      await this.redis.expire(participantsKey, this.ttlSeconds);
    }
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
    await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'title', title);
  }

  async updatePin(threadId: string, pinned: boolean): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.redis.eval(
      HSET_IF_HAS_ID_LUA,
      1,
      key,
      'pinned',
      String(pinned),
      'pinnedAt',
      pinned ? String(Date.now()) : '0',
    );
  }

  async updateFavorite(threadId: string, favorited: boolean): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.redis.eval(
      HSET_IF_HAS_ID_LUA,
      1,
      key,
      'favorited',
      String(favorited),
      'favoritedAt',
      favorited ? String(Date.now()) : '0',
    );
  }

  async updateThinkingMode(threadId: string, mode: 'debug' | 'play'): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'thinkingMode', mode);
  }

  async updateMentionActionabilityMode(threadId: string, mode: MentionActionabilityMode): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    // strict is default behavior; clearing keeps storage backward-compatible.
    if (mode === 'strict') {
      await this.redis.hdel(key, 'mentionActionabilityMode');
      return;
    }
    await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'mentionActionabilityMode', mode);
  }

  async updatePreferredCats(threadId: string, catIds: CatId[]): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    // R5 fix: dedupe at write time to prevent duplicate invocations
    const unique = [...new Set(catIds)];
    // Store as JSON array string; empty array → remove field
    if (unique.length > 0) {
      await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'preferredCats', JSON.stringify(unique));
    } else {
      // Remove the field entirely (clear preference)
      await this.redis.hdel(key, 'preferredCats');
    }
  }

  async updatePhase(threadId: string, phase: ThreadPhase): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'phase', phase);
  }

  async linkBacklogItem(threadId: string, backlogItemId: string): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'backlogItemId', backlogItemId);
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
      await this.redis.hdel(key, 'routingPolicy');
      return;
    }

    await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'routingPolicy', JSON.stringify(policy));
  }

  async getThreadMemory(threadId: string): Promise<ThreadMemoryV1 | null> {
    const key = ThreadKeys.detail(threadId);
    const raw = await this.redis.hget(key, 'threadMemory');
    if (!raw) return null;
    return parseThreadMemoryJson(raw);
  }

  async updateThreadMemory(threadId: string, memory: ThreadMemoryV1): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'threadMemory', JSON.stringify(memory));
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
      await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'votingState', '');
      await this.redis.hdel(key, 'votingState');
    } else {
      await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'votingState', JSON.stringify(state));
    }
  }

  async updateBootcampState(threadId: string, state: BootcampStateV1 | null): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    if (state === null) {
      await this.redis.hdel(key, 'bootcampState');
    } else {
      await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'bootcampState', JSON.stringify(state));
    }
  }

  async updateConnectorHubState(threadId: string, state: ConnectorHubStateV1 | null): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    if (state === null) {
      await this.redis.hdel(key, 'connectorHubState');
    } else {
      await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'connectorHubState', JSON.stringify(state));
    }
  }

  async updateVoiceMode(threadId: string, voiceMode: boolean): Promise<void> {
    const key = ThreadKeys.detail(threadId);
    if (voiceMode) {
      await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, key, 'voiceMode', '1');
    } else {
      await this.redis.hdel(key, 'voiceMode');
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

    const pipeline = this.redis.multi();
    pipeline.del(key);
    pipeline.del(ThreadKeys.participants(threadId));
    // F032 Phase C: Clean up activity data
    pipeline.del(ThreadKeys.activity(threadId));
    // F046 D3: Clean up one-shot mention-routing feedback data
    pipeline.del(ThreadKeys.mentionRoutingFeedback(threadId));
    if (createdBy) {
      pipeline.zrem(ThreadKeys.userList(createdBy), threadId);
    }
    const results = await pipeline.exec();

    // First del result: [err, count]
    const delResult = results?.[0];
    return delResult ? (delResult[1] as number) > 0 : false;
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
