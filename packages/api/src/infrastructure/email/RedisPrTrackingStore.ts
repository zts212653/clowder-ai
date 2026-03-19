import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IPrTrackingStore, PrTrackingEntry, PrTrackingInput } from './PrTrackingStore.js';
import { PrTrackingKeys } from './pr-tracking-keys.js';

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Lua: atomic remove — only del+zrem if hash still exists; otherwise just zrem orphan member
const REMOVE_LUA = `
local existed = redis.call("exists", KEYS[1])
if existed == 1 then
  redis.call("del", KEYS[1])
  redis.call("zrem", KEYS[2], ARGV[1])
  return 1
else
  redis.call("zrem", KEYS[2], ARGV[1])
  return 0
end
`.trim();

export class RedisPrTrackingStore implements IPrTrackingStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number }) {
    this.redis = redis;
    this.ttlSeconds = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async register(input: PrTrackingInput): Promise<PrTrackingEntry> {
    const entry: PrTrackingEntry = {
      ...input,
      registeredAt: Date.now(),
    };

    const key = PrTrackingKeys.detail(input.repoFullName, input.prNumber);
    const allKey = PrTrackingKeys.all();
    const member = `${input.repoFullName}#${input.prNumber}`;

    const pipeline = this.redis.multi();
    pipeline.hset(key, this.serialize(entry));
    pipeline.expire(key, this.ttlSeconds);
    pipeline.zadd(allKey, String(entry.registeredAt), member);
    await pipeline.exec();

    return entry;
  }

  async get(repoFullName: string, prNumber: number): Promise<PrTrackingEntry | null> {
    const key = PrTrackingKeys.detail(repoFullName, prNumber);
    const data = await this.redis.hgetall(key);
    if (!data || !data.repoFullName) {
      // Atomic self-heal: only zrem if hash is still absent (avoids racing with concurrent register)
      const member = `${repoFullName}#${prNumber}`;
      this.redis
        .eval(
          'if redis.call("exists",KEYS[1])==0 then return redis.call("zrem",KEYS[2],ARGV[1]) end return 0',
          2,
          key,
          PrTrackingKeys.all(),
          member,
        )
        .catch(() => {});
      return null;
    }
    return this.hydrate(data);
  }

  async remove(repoFullName: string, prNumber: number): Promise<boolean> {
    const key = PrTrackingKeys.detail(repoFullName, prNumber);
    const member = `${repoFullName}#${prNumber}`;
    const result = await this.redis.eval(REMOVE_LUA, 2, key, PrTrackingKeys.all(), member);
    return result === 1;
  }

  async listAll(): Promise<PrTrackingEntry[]> {
    const members = await this.redis.zrevrange(PrTrackingKeys.all(), 0, -1);
    if (members.length === 0) return [];

    const pipeline = this.redis.multi();
    for (const member of members) {
      const [repo, prStr] = splitMember(member);
      if (repo && prStr) {
        pipeline.hgetall(PrTrackingKeys.detail(repo, parseInt(prStr, 10)));
      }
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const entries: PrTrackingEntry[] = [];
    const staleMembers: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result) continue;
      const [err, data] = result;
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.repoFullName) {
        // Hash expired but sorted set member remains — stale
        const member = members[i];
        if (member) staleMembers.push(member);
        continue;
      }
      entries.push(this.hydrate(d));
    }

    // Best-effort self-healing: remove stale sorted set members
    if (staleMembers.length > 0) {
      this.redis.zrem(PrTrackingKeys.all(), ...staleMembers).catch(() => {});
    }

    return entries;
  }

  private serialize(entry: PrTrackingEntry): Record<string, string> {
    return {
      repoFullName: entry.repoFullName,
      prNumber: String(entry.prNumber),
      catId: entry.catId,
      threadId: entry.threadId,
      userId: entry.userId,
      registeredAt: String(entry.registeredAt),
    };
  }

  private hydrate(data: Record<string, string>): PrTrackingEntry {
    return {
      repoFullName: data.repoFullName!,
      prNumber: parseInt(data.prNumber ?? '0', 10),
      catId: data.catId ?? '',
      threadId: data.threadId ?? '',
      userId: data.userId ?? '',
      registeredAt: parseInt(data.registeredAt ?? '0', 10),
    };
  }
}

function splitMember(member: string): [string | undefined, string | undefined] {
  const lastHash = member.lastIndexOf('#');
  if (lastHash <= 0) return [undefined, undefined];
  return [member.slice(0, lastHash), member.slice(lastHash + 1)];
}
