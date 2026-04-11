/**
 * Redis implementation of per-thread key-value memory store.
 * Uses Redis Hash for efficient per-thread storage.
 */

import type { MemoryEntry, MemoryInput } from '@cat-cafe/shared';
import type { Redis } from 'ioredis';
import type { IMemoryStore } from '../ports/MemoryStore.js';
import { MAX_KEYS_PER_THREAD } from '../ports/MemoryStore.js';
import { MEMORY_TTL_SECONDS, memoryKey } from '../redis-keys/memory-keys.js';

/**
 * Redis implementation of IMemoryStore.
 * Uses Hash per thread: HSET cat-cafe:memory:{threadId} {key} {JSON}
 */
export class RedisMemoryStore implements IMemoryStore {
  constructor(private redis: Redis) {}

  async set(input: MemoryInput): Promise<MemoryEntry> {
    const key = memoryKey(input.threadId);

    // Check current size
    const currentSize = await this.redis.hlen(key);
    const isNewKey = !(await this.redis.hexists(key, input.key));

    if (isNewKey && currentSize >= MAX_KEYS_PER_THREAD) {
      // Need to evict oldest
      await this.evictOldest(input.threadId, key);
    }

    const entry: MemoryEntry = {
      key: input.key,
      value: input.value,
      threadId: input.threadId,
      updatedBy: input.updatedBy,
      updatedAt: Date.now(),
    };

    await this.redis.hset(key, input.key, JSON.stringify(entry));
    if (MEMORY_TTL_SECONDS > 0) await this.redis.expire(key, MEMORY_TTL_SECONDS);

    return entry;
  }

  async get(threadId: string, memKey: string): Promise<MemoryEntry | null> {
    const raw = await this.redis.hget(memoryKey(threadId), memKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MemoryEntry;
    } catch {
      return null;
    }
  }

  async list(threadId: string): Promise<MemoryEntry[]> {
    const all = await this.redis.hgetall(memoryKey(threadId));
    const entries: MemoryEntry[] = [];
    for (const value of Object.values(all)) {
      try {
        entries.push(JSON.parse(value) as MemoryEntry);
      } catch {
        // Skip malformed entries
      }
    }
    return entries.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async delete(threadId: string, memKey: string): Promise<boolean> {
    const result = await this.redis.hdel(memoryKey(threadId), memKey);
    return result > 0;
  }

  /** Delete all entries for a thread. Returns count of deleted entries. */
  async deleteThread(threadId: string): Promise<number> {
    const key = memoryKey(threadId);
    const count = await this.redis.hlen(key);
    if (count > 0) {
      await this.redis.del(key);
    }
    return count;
  }

  private async evictOldest(_threadId: string, hashKey: string): Promise<void> {
    const all = await this.redis.hgetall(hashKey);
    let oldest: { key: string; time: number } | null = null;

    for (const [k, v] of Object.entries(all)) {
      try {
        const entry = JSON.parse(v) as MemoryEntry;
        if (!oldest || entry.updatedAt < oldest.time) {
          oldest = { key: k, time: entry.updatedAt };
        }
      } catch {
        // Skip malformed entries
      }
    }

    if (oldest) {
      await this.redis.hdel(hashKey, oldest.key);
    }
  }
}
