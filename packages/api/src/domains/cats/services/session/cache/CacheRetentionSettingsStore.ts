import type { RedisClient } from '@cat-cafe/shared/utils';
import { z } from 'zod';

const preferenceSchema = z
  .object({
    userId: z.string().min(1),
    catId: z.string().min(1),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export interface CacheRetentionPreference {
  userId: string;
  catId: string;
  enabled: boolean;
  revision: number;
  updatedAt: number;
}

const part = (userId: string, catId: string) => Buffer.from(JSON.stringify([userId, catId])).toString('base64url');
export const cacheRetentionPreferenceKey = (userId: string, catId: string) =>
  `cache-retention:preference:${part(userId, catId)}`;

const SET_PREFERENCE = `
local previous = redis.call('GET', KEYS[1])
local revision = 0
if previous then revision = cjson.decode(previous).revision end
local value = cjson.decode(ARGV[1])
value.revision = revision + 1
local encoded = cjson.encode(value)
redis.call('SET', KEYS[1], encoded)
if value.enabled then redis.call('HSET', KEYS[2], ARGV[2], encoded)
else redis.call('HDEL', KEYS[2], ARGV[2]) end
return encoded
`;

/** Owner/member opt-in. SET has no expiry; API restarts must not reverse the owner's choice. */
export class CacheRetentionSettingsStore {
  constructor(private readonly redis: RedisClient) {}

  async enabledMembers(): Promise<Array<{ userId: string; catId: string }>> {
    return Object.values(await this.redis.hgetall('cache-retention:enabled-members')).map((raw) => {
      const value = preferenceSchema.parse(JSON.parse(raw));
      return { userId: value.userId, catId: value.catId };
    });
  }

  async get(userId: string, catId: string): Promise<CacheRetentionPreference> {
    const raw = await this.redis.get(cacheRetentionPreferenceKey(userId, catId));
    if (raw) {
      const value = preferenceSchema.parse(JSON.parse(raw));
      if (value.userId !== userId || value.catId !== catId) throw new Error('cache_retention_preference_scope');
      return value;
    }
    return { userId, catId, enabled: false, revision: 0, updatedAt: 0 };
  }

  async set(userId: string, catId: string, enabled: boolean): Promise<CacheRetentionPreference> {
    const raw = await this.redis.eval(
      SET_PREFERENCE,
      2,
      cacheRetentionPreferenceKey(userId, catId),
      'cache-retention:enabled-members',
      JSON.stringify({ userId, catId, enabled, updatedAt: Date.now() }),
      part(userId, catId),
    );
    return JSON.parse(String(raw)) as CacheRetentionPreference;
  }
}
