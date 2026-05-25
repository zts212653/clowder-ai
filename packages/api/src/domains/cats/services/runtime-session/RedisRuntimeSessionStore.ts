/**
 * Redis Runtime Session Store
 * F211 Phase A1: Redis-backed runtime-session metadata sidecar.
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes normal commands and eval() KEYS[].
 * Pass bare keys as KEYS. Lua-built dynamic keys must explicitly include the
 * resolved keyPrefix, because Redis cannot apply ioredis client options inside
 * the script.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { RuntimeSessionKeys } from '../stores/redis-keys/runtime-session-keys.js';
import {
  normalizeRuntimeSessionMetadata,
  type RuntimeSessionLifecycleState,
  type RuntimeSessionMetadata,
  type RuntimeSessionRuntime,
} from './RuntimeSessionMetadata.js';
import type { IRuntimeSessionStore } from './RuntimeSessionStore.js';

const UPSERT_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing and existing ~= '' then
  local decoded = cjson.decode(existing)
  if decoded.runtime and decoded.runtimeSessionId then
    local oldRuntimeKey = ARGV[2] .. 'runtime-session:runtime:' .. decoded.runtime .. ':' .. decoded.runtimeSessionId
    redis.call('DEL', oldRuntimeKey)
  end
  if decoded.lifecycle and decoded.lifecycle.state then
    local oldStateKey = ARGV[2] .. 'runtime-session:lifecycle:' .. decoded.lifecycle.state
    redis.call('ZREM', oldStateKey, ARGV[1])
  end
end

redis.call('SET', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], tonumber(ARGV[4]), ARGV[1])
return ARGV[3]
`;

export class RedisRuntimeSessionStore implements IRuntimeSessionStore {
  constructor(private readonly redis: RedisClient) {}

  async upsert(metadata: RuntimeSessionMetadata): Promise<RuntimeSessionMetadata> {
    const normalized = normalizeRuntimeSessionMetadata(metadata);
    const payload = JSON.stringify(normalized);
    await this.redis.eval(
      UPSERT_LUA,
      3,
      RuntimeSessionKeys.detail(normalized.sessionId),
      RuntimeSessionKeys.byRuntime(normalized.runtime, normalized.runtimeSessionId),
      RuntimeSessionKeys.byLifecycleState(normalized.lifecycle.state),
      normalized.sessionId,
      this.keyPrefix,
      payload,
      String(normalized.lifecycle.lastObservedAt),
    );
    return normalized;
  }

  async getBySessionId(sessionId: string): Promise<RuntimeSessionMetadata | null> {
    const payload = await this.redis.get(RuntimeSessionKeys.detail(sessionId));
    return payload ? parseMetadata(payload) : null;
  }

  async getByRuntimeSession(
    runtime: RuntimeSessionRuntime,
    runtimeSessionId: string,
  ): Promise<RuntimeSessionMetadata | null> {
    const sessionId = await this.redis.get(RuntimeSessionKeys.byRuntime(runtime, runtimeSessionId));
    return sessionId ? this.getBySessionId(sessionId) : null;
  }

  async listByLifecycleState(state: RuntimeSessionLifecycleState): Promise<RuntimeSessionMetadata[]> {
    const sessionIds = await this.redis.zrange(RuntimeSessionKeys.byLifecycleState(state), 0, -1);
    if (sessionIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const sessionId of sessionIds) {
      pipeline.get(RuntimeSessionKeys.detail(sessionId));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const records: RuntimeSessionMetadata[] = [];
    for (const [err, payload] of results) {
      if (err || typeof payload !== 'string') continue;
      records.push(parseMetadata(payload));
    }
    return records.sort((a, b) => {
      const observedDelta = a.lifecycle.lastObservedAt - b.lifecycle.lastObservedAt;
      if (observedDelta !== 0) return observedDelta;
      return a.sessionId.localeCompare(b.sessionId);
    });
  }

  async updateLifecycle(
    sessionId: string,
    patch: Partial<RuntimeSessionMetadata['lifecycle']>,
  ): Promise<RuntimeSessionMetadata | null> {
    const existing = await this.getBySessionId(sessionId);
    if (!existing) return null;
    return this.upsert({
      ...existing,
      lifecycle: {
        ...existing.lifecycle,
        ...patch,
      },
    });
  }

  private get keyPrefix(): string {
    return (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  }
}

function parseMetadata(payload: string): RuntimeSessionMetadata {
  return normalizeRuntimeSessionMetadata(JSON.parse(payload));
}
