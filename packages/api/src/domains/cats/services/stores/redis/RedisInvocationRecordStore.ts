/**
 * Redis InvocationRecord Store
 * Redis-backed invocation record storage with Lua atomic create.
 *
 * ADR-008 D1+D2: Lua 脚本原子创建 — 幂等 key 占位 + Record 创建在同一 EVAL 中。
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes ALL commands including eval() KEYS[].
 * Do NOT manually prepend the prefix — pass bare keys and let ioredis handle it.
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { TokenUsage } from '../../types.js';
import type {
  CreateInvocationInput,
  CreateResult,
  IInvocationRecordStore,
  InvocationRecord,
  InvocationStatus,
  UpdateInvocationInput,
} from '../ports/InvocationRecordStore.js';
import { InvocationKeys } from '../redis-keys/invocation-keys.js';

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const IDEMPOTENCY_TTL_SECONDS = 300; // 5 minutes

/**
 * Lua script for atomic idempotency check + record creation.
 * KEYS[1] = idempotency key (ioredis auto-prefixes)
 * KEYS[2] = invocation record key (ioredis auto-prefixes)
 * ARGV[1..7] = id, threadId, userId, targetCats(JSON), intent, idempotencyKey, now
 */
const CREATE_ATOMIC_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return {'duplicate', existing}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ${IDEMPOTENCY_TTL_SECONDS})
redis.call('HSET', KEYS[2],
  'id', ARGV[1], 'threadId', ARGV[2], 'userId', ARGV[3],
  'targetCats', ARGV[4], 'intent', ARGV[5],
  'idempotencyKey', ARGV[6], 'status', 'queued',
  'userMessageId', '', 'error', '',
  'createdAt', ARGV[7], 'updatedAt', ARGV[7])
redis.call('EXPIRE', KEYS[2], ${DEFAULT_TTL_SECONDS})
return {'created', ARGV[1]}
`;

/**
 * Lua script for atomic status update with state machine guard.
 * Handles both CAS (expectedStatus provided) and non-CAS paths atomically.
 *
 * KEYS[1] = invocation record hash key
 * ARGV[1] = expectedStatus ("" if non-CAS)
 * ARGV[2] = newStatus ("" if no status change)
 * ARGV[3..N] = field/value pairs to HSET (always includes updatedAt)
 *
 * Returns:
 *   1  = success
 *   0  = CAS mismatch (expectedStatus didn't match current)
 *  -1  = illegal state transition
 *  -2  = record not found
 */
const ATOMIC_UPDATE_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if not current then
  return -2
end

local expected = ARGV[1]
local newStatus = ARGV[2]

-- CAS check: if expectedStatus provided, current must match
if expected ~= '' and current ~= expected then
  return 0
end

-- State machine guard: validate transition when newStatus is provided.
-- Self-transitions (newStatus == current) are rejected for terminal states
-- because succeeded/canceled have empty allow-sets, matching isValidTransition().
if newStatus ~= '' then
  local transitions = {
    queued   = {running=1, failed=1, canceled=1},
    running  = {succeeded=1, failed=1, canceled=1},
    failed   = {running=1, canceled=1},
    succeeded = {},
    canceled  = {}
  }
  local allowed = transitions[current]
  if not allowed or not allowed[newStatus] then
    return -1
  end
end

-- Apply field/value pairs
local fields = {}
for i = 3, #ARGV, 2 do
  fields[#fields + 1] = ARGV[i]
  fields[#fields + 1] = ARGV[i + 1]
end
if #fields > 0 then
  redis.call('HSET', KEYS[1], unpack(fields))
end
return 1
`;

export class RedisInvocationRecordStore implements IInvocationRecordStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
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

  async create(input: CreateInvocationInput): Promise<CreateResult> {
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID();
    const now = String(Date.now());

    // Bare keys — ioredis keyPrefix auto-applies to eval() KEYS[] too
    const idempKey = InvocationKeys.idempotency(input.threadId, input.userId, input.idempotencyKey);
    const recordKey = InvocationKeys.detail(id);

    const result = (await this.redis.eval(
      CREATE_ATOMIC_LUA,
      2,
      idempKey,
      recordKey,
      id,
      input.threadId,
      input.userId,
      JSON.stringify(input.targetCats),
      input.intent,
      input.idempotencyKey,
      now,
    )) as [string, string];

    return {
      outcome: result[0] as 'created' | 'duplicate',
      invocationId: result[1],
    };
  }

  async get(id: string): Promise<InvocationRecord | null> {
    const key = InvocationKeys.detail(id);
    const data = await this.redis.hgetall(key);
    if (!data || !data.id) return null;
    return this.hydrateRecord(data);
  }

  async update(id: string, input: UpdateInvocationInput): Promise<InvocationRecord | null> {
    const key = InvocationKeys.detail(id);

    // Build field/value pairs for HSET
    const pairs: string[] = [];
    pairs.push('updatedAt', String(Date.now()));
    if (input.status !== undefined) pairs.push('status', input.status);
    if (input.userMessageId !== undefined) pairs.push('userMessageId', input.userMessageId ?? '');
    if (input.error !== undefined) pairs.push('error', input.error);
    if (input.usageByCat !== undefined) pairs.push('usageByCat', JSON.stringify(input.usageByCat));

    // F128: stamp usageRecordedAt on first usageByCat write (HSETNX semantics)
    if (input.usageByCat !== undefined) {
      const existing = await this.redis.hget(key, 'usageRecordedAt');
      if (!existing) pairs.push('usageRecordedAt', String(Date.now()));
    }

    // All updates go through ATOMIC_UPDATE_LUA for consistent guard behavior.
    // The Lua script handles CAS check + state machine validation atomically.
    const result = (await this.redis.eval(
      ATOMIC_UPDATE_LUA,
      1,
      key,
      input.expectedStatus ?? '',
      input.status ?? '',
      ...pairs,
    )) as number;

    // -2 = not found, 0 = CAS mismatch, -1 = illegal transition
    if (result !== 1) return null;

    return this.get(id);
  }

  async getByIdempotencyKey(threadId: string, userId: string, key: string): Promise<InvocationRecord | null> {
    const idempKey = InvocationKeys.idempotency(threadId, userId, key);
    const invocationId = await this.redis.get(idempKey);
    if (!invocationId) return null;
    return this.get(invocationId);
  }

  /**
   * F048: Scan all invocation records matching a given status.
   * Uses Redis SCAN (non-blocking cursor) + pipeline HGET for efficiency.
   *
   * IMPORTANT: ioredis SCAN does NOT auto-apply keyPrefix.
   * We must manually prepend the prefix for matching, then strip it from results.
   */
  async scanByStatus(status: InvocationStatus): Promise<string[]> {
    const matchPattern = `${this.keyPrefix}${InvocationKeys.detail('*')}`;
    const ids: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of keys) {
          pipeline.hget(this.stripPrefix(key), 'status');
        }
        const results = await pipeline.exec();
        for (let i = 0; i < keys.length; i++) {
          const [err, val] = results?.[i]!;
          if (!err && val === status) {
            ids.push(this.stripPrefix(keys[i]!).replace(/^invoc:/, ''));
          }
        }
      }
    } while (cursor !== '0');
    return ids;
  }

  /**
   * F128: Scan ALL invocation records.
   * Uses Redis SCAN (non-blocking cursor) + pipeline HGETALL for full hydration.
   */
  async scanAll(): Promise<InvocationRecord[]> {
    const matchPattern = `${this.keyPrefix}${InvocationKeys.detail('*')}`;
    const records: InvocationRecord[] = [];
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
          if (!err && data && typeof data === 'object' && (data as Record<string, string>).id) {
            records.push(this.hydrateRecord(data as Record<string, string>));
          }
        }
      }
    } while (cursor !== '0');
    return records;
  }

  /** Reassign invocation ownership to a different userId (repair helper for scheduler backfill). */
  async reassignUserId(id: string, nextUserId: string): Promise<InvocationRecord | null> {
    const record = await this.get(id);
    if (!record) return null;
    if (record.userId === nextUserId) return record;

    const key = InvocationKeys.detail(id);
    await this.redis.hset(key, {
      userId: nextUserId,
      updatedAt: String(Date.now()),
    });

    const oldIdempKey = InvocationKeys.idempotency(record.threadId, record.userId, record.idempotencyKey);
    const newIdempKey = InvocationKeys.idempotency(record.threadId, nextUserId, record.idempotencyKey);
    const claimedId = await this.redis.get(oldIdempKey);
    if (claimedId === id) {
      const ttl = await this.redis.ttl(oldIdempKey);
      const pipeline = this.redis.multi();
      pipeline.del(oldIdempKey);
      if (ttl > 0) {
        pipeline.set(newIdempKey, id, 'EX', ttl);
      } else {
        pipeline.set(newIdempKey, id);
      }
      await pipeline.exec();
    }

    return this.get(id);
  }

  private hydrateRecord(data: Record<string, string>): InvocationRecord {
    const errorValue = data.error;
    const hasError = errorValue !== undefined && errorValue !== '';
    const usageByCat = safeParseObject(data.usageByCat);
    return {
      id: data.id!,
      threadId: data.threadId!,
      userId: data.userId!,
      userMessageId: data.userMessageId === '' ? null : data.userMessageId!,
      targetCats: safeParseArray(data.targetCats) as CatId[],
      intent: (data.intent as 'execute' | 'ideate') ?? 'execute',
      status: (data.status as InvocationStatus) ?? 'queued',
      idempotencyKey: data.idempotencyKey!,
      ...(hasError ? { error: errorValue } : {}),
      ...(usageByCat ? { usageByCat } : {}),
      ...(data.usageRecordedAt ? { usageRecordedAt: parseInt(data.usageRecordedAt, 10) } : {}),
      createdAt: parseInt(data.createdAt!, 10),
      updatedAt: parseInt(data.updatedAt!, 10),
    };
  }
}

function safeParseArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseObject(value: string | undefined): Record<string, TokenUsage> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, TokenUsage>)
      : null;
  } catch {
    return null;
  }
}
