import type { CatId } from '@cat-cafe/shared';
import type { Redis } from 'ioredis';
import type { TaskProgressSnapshot, TaskProgressStore } from './TaskProgressStore.js';

/**
 * Redis-backed task progress snapshots.
 *
 * Key naming:
 * - Use bare keys. Our ioredis client applies `cat-cafe:` via keyPrefix.
 */
function threadKey(threadId: string): string {
  return `task-progress:${threadId}`;
}

const DELETE_SNAPSHOT_IF_OWNER_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local ok, snapshot = pcall(cjson.decode, raw)
if not ok or snapshot['lastInvocationId'] ~= ARGV[2] then return 0 end
return redis.call('HDEL', KEYS[1], ARGV[1])
`;

export class RedisTaskProgressStore implements TaskProgressStore {
  constructor(
    private readonly redis: Pick<Redis, 'hget' | 'hset' | 'hgetall' | 'hdel' | 'expire' | 'del' | 'eval'>,
    private readonly defaultTtlSeconds: number,
  ) {}

  async getSnapshot(threadId: string, catId: CatId): Promise<TaskProgressSnapshot | null> {
    const raw = await this.redis.hget(threadKey(threadId), catId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TaskProgressSnapshot;
    } catch {
      return null;
    }
  }

  async setSnapshot(snapshot: TaskProgressSnapshot, options?: { ttlSeconds?: number }): Promise<void> {
    const key = threadKey(snapshot.threadId);
    await this.redis.hset(key, snapshot.catId, JSON.stringify(snapshot));
    const ttl = options?.ttlSeconds ?? this.defaultTtlSeconds;
    if (ttl > 0) await this.redis.expire(key, ttl);
  }

  async deleteSnapshot(threadId: string, catId: CatId): Promise<void> {
    await this.redis.hdel(threadKey(threadId), catId);
  }

  async deleteSnapshotIfOwner(threadId: string, catId: CatId, invocationId: string): Promise<boolean> {
    const deleted = await this.redis.eval(DELETE_SNAPSHOT_IF_OWNER_LUA, 1, threadKey(threadId), catId, invocationId);
    return deleted === 1;
  }

  async getThreadSnapshots(threadId: string): Promise<Record<string, TaskProgressSnapshot>> {
    const all = await this.redis.hgetall(threadKey(threadId));
    const out: Record<string, TaskProgressSnapshot> = {};
    for (const [catId, raw] of Object.entries(all)) {
      try {
        out[catId] = JSON.parse(raw) as TaskProgressSnapshot;
      } catch {
        // best-effort: ignore corrupted entries
      }
    }
    return out;
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.redis.del(threadKey(threadId));
  }
}
