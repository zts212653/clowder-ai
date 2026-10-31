/**
 * Redis Runtime Session Store
 * F211 Phase A1: Redis-backed runtime-session metadata sidecar.
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes normal commands and eval() KEYS[].
 * Pass bare keys as KEYS. Lua-built dynamic keys must explicitly include the
 * resolved keyPrefix, because Redis cannot apply ioredis client options inside
 * the script.
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { RuntimeSessionKeys } from '../stores/redis-keys/runtime-session-keys.js';
import {
  normalizeRuntimeSessionMetadata,
  type RuntimeSessionLifecycleState,
  type RuntimeSessionMetadata,
  type RuntimeSessionRuntime,
  type RuntimeSessionSurface,
} from './RuntimeSessionMetadata.js';
import type { IRuntimeSessionStore, RuntimeSessionRecentFilter } from './RuntimeSessionStore.js';

const UPSERT_LUA = `
local function active_key(runtime, threadId, catId)
  return ARGV[2] .. 'runtime-session-active:' .. runtime .. ':' .. threadId .. ':' .. catId
end

local function remove_recent_indexes(sessionId, record)
  if not record.runtime then
    return
  end
  redis.call('ZREM', ARGV[2] .. 'runtime-session:recent:' .. record.runtime, sessionId)
  if record.surface then
    redis.call('ZREM', ARGV[2] .. 'runtime-session:recent:' .. record.runtime .. ':' .. record.surface, sessionId)
    if record.catId then
      redis.call('ZREM', ARGV[2] .. 'runtime-session:recent:' .. record.runtime .. ':' .. record.surface .. ':' .. record.catId, sessionId)
    end
  end
end

local existing = redis.call('GET', KEYS[1])
if existing and existing ~= '' then
  local decoded = cjson.decode(existing)
  if decoded.runtime and decoded.runtimeSessionId then
    local oldRuntimeKey = ARGV[2] .. 'runtime-session:runtime:' .. decoded.runtime .. ':' .. decoded.runtimeSessionId
    redis.call('DEL', oldRuntimeKey)
  end
  if decoded.runtime and decoded.threadId and decoded.catId and decoded.lifecycle and decoded.lifecycle.state == 'active' then
    local oldActiveKey = active_key(decoded.runtime, decoded.threadId, decoded.catId)
    if redis.call('GET', oldActiveKey) == ARGV[1] then
      redis.call('DEL', oldActiveKey)
    end
  end
  if decoded.lifecycle and decoded.lifecycle.state then
    local oldStateKey = ARGV[2] .. 'runtime-session:lifecycle:' .. decoded.lifecycle.state
    redis.call('ZREM', oldStateKey, ARGV[1])
  end
  remove_recent_indexes(ARGV[1], decoded)
end

redis.call('SET', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], tonumber(ARGV[4]), ARGV[1])
redis.call('ZADD', ARGV[2] .. 'runtime-session:recent:' .. ARGV[5], tonumber(ARGV[4]), ARGV[1])
redis.call('ZADD', ARGV[2] .. 'runtime-session:recent:' .. ARGV[5] .. ':' .. ARGV[9], tonumber(ARGV[4]), ARGV[1])
redis.call('ZADD', ARGV[2] .. 'runtime-session:recent:' .. ARGV[5] .. ':' .. ARGV[9] .. ':' .. ARGV[7], tonumber(ARGV[4]), ARGV[1])

if ARGV[8] == 'active' and ARGV[6] ~= '' and ARGV[7] ~= '' then
  local newActiveKey = active_key(ARGV[5], ARGV[6], ARGV[7])
  local currentId = redis.call('GET', newActiveKey)
  local shouldSetActive = false

  if not currentId or currentId == '' or currentId == ARGV[1] then
    shouldSetActive = true
  else
    local currentPayload = redis.call('GET', ARGV[2] .. 'runtime-session:' .. currentId)
    if not currentPayload or currentPayload == '' then
      shouldSetActive = true
    else
      local current = cjson.decode(currentPayload)
      local currentObservedAt = 0
      if current.lifecycle and current.lifecycle.lastObservedAt then
        currentObservedAt = tonumber(current.lifecycle.lastObservedAt)
      end
      if tonumber(ARGV[4]) >= currentObservedAt then
        shouldSetActive = true
      end
    end
  end

  if shouldSetActive then
    redis.call('SET', newActiveKey, ARGV[1])
  end
end

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
      normalized.runtime,
      normalized.threadId ?? '',
      normalized.catId,
      normalized.lifecycle.state,
      normalized.surface,
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

  async getActiveByThreadCat(
    runtime: RuntimeSessionRuntime,
    threadId: string,
    catId: CatId,
  ): Promise<RuntimeSessionMetadata | null> {
    const sessionId = await this.redis.get(RuntimeSessionKeys.byThreadCat(runtime, threadId, catId));
    if (!sessionId) return null;
    const record = await this.getBySessionId(sessionId);
    if (
      !record ||
      record.runtime !== runtime ||
      record.threadId !== threadId ||
      record.catId !== catId ||
      record.lifecycle.state !== 'active'
    ) {
      return null;
    }
    return record;
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

  async listRecent(filter: RuntimeSessionRecentFilter): Promise<RuntimeSessionMetadata[]> {
    const runtime = filter.runtime ?? 'antigravity-desktop';
    const key = recentKeyFor(runtime, filter.surface, filter.catId);
    const limit = normalizeLimit(filter.limit);
    const offset = normalizeOffset(filter.offset);
    const sessionIds = await this.redis.zrevrange(key, offset, offset + limit - 1);
    if (sessionIds.length === 0) return [];

    const records = await this.readRecords(sessionIds);
    return records
      .filter((record) => {
        if (record.runtime !== runtime) return false;
        if (filter.surface && record.surface !== filter.surface) return false;
        if (filter.catId && record.catId !== filter.catId) return false;
        return true;
      })
      .sort((a, b) => {
        const observedDelta = b.lifecycle.lastObservedAt - a.lifecycle.lastObservedAt;
        if (observedDelta !== 0) return observedDelta;
        return a.sessionId.localeCompare(b.sessionId);
      })
      .slice(0, limit);
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

  private async readRecords(sessionIds: readonly string[]): Promise<RuntimeSessionMetadata[]> {
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
    return records;
  }
}

function parseMetadata(payload: string): RuntimeSessionMetadata {
  return normalizeRuntimeSessionMetadata(JSON.parse(payload));
}

function recentKeyFor(
  runtime: RuntimeSessionRuntime,
  surface: RuntimeSessionSurface | undefined,
  catId: CatId | undefined,
): string {
  if (surface && catId) return RuntimeSessionKeys.recentByRuntimeSurfaceCat(runtime, surface, catId);
  if (surface) return RuntimeSessionKeys.recentByRuntimeSurface(runtime, surface);
  return RuntimeSessionKeys.recentByRuntime(runtime);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1) return 50;
  return Math.min(limit, 200);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}
