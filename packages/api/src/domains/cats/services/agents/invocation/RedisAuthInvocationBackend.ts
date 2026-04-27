/**
 * F174 Phase B — Redis-backed IAuthInvocationBackend implementation.
 *
 * Restart-resilient: API process exit / deploy / crash no longer drops active
 * invocation tokens. Phase B's main painpoint fix.
 *
 * Schema (all keys ioredis auto-prefixed with `cat-cafe:`):
 * - auth:inv:{invocationId}                 → Hash (record fields, expiresAt)
 * - auth:inv:{invocationId}:msgs            → Set (clientMessageIds)
 * - auth:latest:{threadId}:{catId}          → String (latest invocationId)
 *
 * All keys carry PEXPIREAT(expiresAt) so Redis natively reaps expired records.
 *
 * IMPORTANT — ioredis keyPrefix gotcha (LL-016):
 *   - HSET / HGET / EVAL KEYS[]: ioredis auto-prefixes (pass bare key)
 *   - keys() / SCAN: NOT auto-prefixed (we don't use them here)
 * → All keys passed to ioredis below are bare. Do NOT manually prepend prefix.
 *
 * Reference impl: RedisInvocationRecordStore.ts (Hash + Lua atomic pattern)
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { AuthInvocationInput, IAuthInvocationBackend } from './IAuthInvocationBackend.js';
import type { InvocationRecord, VerifyResult } from './InvocationRegistry.js';

const KEY_INV = (id: string) => `auth:inv:${id}`;
const KEY_MSGS = (id: string) => `auth:inv:${id}:msgs`;
const KEY_LATEST = (threadId: string, catId: string) => `auth:latest:${threadId}:${catId}`;
const KEY_REFRESH_COOLDOWN = (id: string) => `auth:refresh-cooldown:${id}`;

const MAX_CLIENT_MESSAGE_IDS = 1000;

/**
 * VERIFY_AND_SLIDE_LUA
 *
 * KEYS[1] = auth:inv:{invocationId}    (ioredis auto-prefixes)
 * ARGV[1] = expectedCallbackToken
 * ARGV[2] = nowMs (string)
 * ARGV[3] = newExpiresAtMs (string)
 *
 * Returns:
 *   { 'fail', '<reason>' }  where reason ∈ {unknown_invocation, invalid_token, expired}
 *   { 'ok', <flat hash array from HGETALL> }
 */
const VERIFY_LUA = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 0 then
  return {'fail', 'unknown_invocation'}
end

local stored = redis.call('HGET', KEYS[1], 'callbackToken')
if stored ~= ARGV[1] then
  return {'fail', 'invalid_token'}
end

local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt'))
if not expiresAt or tonumber(ARGV[2]) > expiresAt then
  redis.call('DEL', KEYS[1])
  return {'fail', 'expired'}
end

redis.call('HSET', KEYS[1], 'expiresAt', ARGV[3])
-- Grace: keep key ~60s past logical expiry so Lua can distinguish 'expired'
-- (key still around, expiresAt in past) from 'unknown_invocation' (truly gone).
redis.call('PEXPIREAT', KEYS[1], tonumber(ARGV[3]) + 60000)

return {'ok', redis.call('HGETALL', KEYS[1])}
`;

/**
 * VERIFY_LATEST_LUA — atomic verify + isLatest + slide.
 *
 * KEYS[1] = auth:inv:{invocationId}
 * KEYS[2] = auth:latest:{threadId}:{catId}
 * ARGV[1] = callbackToken
 * ARGV[2] = nowMs
 * ARGV[3] = newExpiresAtMs
 * ARGV[4] = invocationId  (so latest pointer comparison happens server-side)
 *
 * Closes race window between preValidation isLatest check and preHandler
 * verify slide (cloud Codex P2 #1368, 05de7c98b). All checks + slide happen
 * in one Redis round-trip — concurrent create() can't sneak in.
 */
const VERIFY_LATEST_LUA = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 0 then
  return {'fail', 'unknown_invocation'}
end

local stored = redis.call('HGET', KEYS[1], 'callbackToken')
if stored ~= ARGV[1] then
  return {'fail', 'invalid_token'}
end

local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt'))
if not expiresAt or tonumber(ARGV[2]) > expiresAt then
  redis.call('DEL', KEYS[1])
  return {'fail', 'expired'}
end

local latest = redis.call('GET', KEYS[2])
if latest ~= ARGV[4] then
  return {'fail', 'stale_invocation'}
end

redis.call('HSET', KEYS[1], 'expiresAt', ARGV[3])
redis.call('PEXPIREAT', KEYS[1], tonumber(ARGV[3]) + 60000)
-- Slide latest pointer alongside record so isLatest stays consistent.
redis.call('PEXPIREAT', KEYS[2], tonumber(ARGV[3]) + 60000)

return {'ok', redis.call('HGETALL', KEYS[1])}
`;

/**
 * CREATE_LUA
 *
 * KEYS[1] = auth:inv:{invocationId}
 * KEYS[2] = auth:latest:{threadId}:{catId}
 * ARGV[1..N-2] = field/value pairs for the record Hash
 * ARGV[N-1] = invocationId (for latest pointer)
 * ARGV[N]   = expiresAtMs
 */
const CREATE_LUA = `
local n = #ARGV
local hashFields = {}
for i = 1, n - 2 do hashFields[i] = ARGV[i] end

redis.call('HSET', KEYS[1], unpack(hashFields))
-- Grace: 60s past logical expiry so Lua can return 'expired' before reaper hits.
local graceMs = tonumber(ARGV[n]) + 60000
redis.call('PEXPIREAT', KEYS[1], graceMs)

redis.call('SET', KEYS[2], ARGV[n - 1])
redis.call('PEXPIREAT', KEYS[2], graceMs)

return 1
`;

function parseHashArray(arr: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i += 2) {
    const k = arr[i];
    const v = arr[i + 1];
    if (typeof k === 'string' && typeof v === 'string') out[k] = v;
  }
  return out;
}

function recordFromHash(fields: Record<string, string>, msgs: Set<string>): InvocationRecord | null {
  if (!fields.invocationId || !fields.callbackToken) return null;
  const record: InvocationRecord = {
    invocationId: fields.invocationId,
    callbackToken: fields.callbackToken,
    userId: fields.userId ?? '',
    catId: (fields.catId ?? '') as CatId,
    threadId: fields.threadId ?? '',
    clientMessageIds: msgs,
    createdAt: Number(fields.createdAt ?? 0),
    expiresAt: Number(fields.expiresAt ?? 0),
  };
  if (fields.parentInvocationId) record.parentInvocationId = fields.parentInvocationId;
  if (fields.a2aTriggerMessageId) record.a2aTriggerMessageId = fields.a2aTriggerMessageId;
  return record;
}

export class RedisAuthInvocationBackend implements IAuthInvocationBackend {
  constructor(private readonly redis: RedisClient) {}

  async create(input: AuthInvocationInput, ttlMs: number): Promise<void> {
    const expiresAt = Date.now() + ttlMs;
    const fields: string[] = [
      'invocationId',
      input.invocationId,
      'callbackToken',
      input.callbackToken,
      'userId',
      input.userId,
      'catId',
      input.catId as string,
      'threadId',
      input.threadId,
      'createdAt',
      String(input.createdAt),
      'expiresAt',
      String(expiresAt),
    ];
    if (input.parentInvocationId) fields.push('parentInvocationId', input.parentInvocationId);
    if (input.a2aTriggerMessageId) fields.push('a2aTriggerMessageId', input.a2aTriggerMessageId);

    await this.redis.eval(
      CREATE_LUA,
      2,
      KEY_INV(input.invocationId),
      KEY_LATEST(input.threadId, input.catId as string),
      ...fields,
      input.invocationId,
      String(expiresAt),
    );
  }

  /**
   * F174-C — verify token without sliding TTL. Pure read path: HGETALL +
   * comparisons. No PEXPIREAT calls. Used by refresh-token onRequest hook
   * to validate before claiming cooldown (gpt52 P1 #2 — bad-auth请求 not
   * allowed to burn cooldown slot).
   */
  async peek(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    const raw = await this.redis.hgetall(KEY_INV(invocationId));
    if (!raw || Object.keys(raw).length === 0) {
      return { ok: false, reason: 'unknown_invocation' };
    }
    if (raw.callbackToken !== callbackToken) {
      return { ok: false, reason: 'invalid_token' };
    }
    const expiresAt = Number(raw.expiresAt ?? 0);
    if (!expiresAt || Date.now() > expiresAt) {
      return { ok: false, reason: 'expired' };
    }
    const record = recordFromHash(raw, new Set<string>());
    if (!record) return { ok: false, reason: 'unknown_invocation' };
    return { ok: true, record };
  }

  async verifyLatest(invocationId: string, callbackToken: string, ttlMs: number): Promise<VerifyResult> {
    const now = Date.now();
    const newExpiresAt = now + ttlMs;
    // We need threadId/catId to build KEYS[2]. HGET them first; if record is
    // gone, return unknown_invocation directly. The Lua script then re-checks
    // record existence atomically — this preflight just lets us pass the right
    // KEYS[2] to Lua (Redis Cluster needs all KEYS hashing to one slot but
    // single-node Redis doesn't care; consistency is on Lua side).
    const meta = await this.redis.hmget(KEY_INV(invocationId), 'threadId', 'catId');
    const threadId = meta?.[0];
    const catId = meta?.[1];
    if (!threadId || !catId) {
      return { ok: false, reason: 'unknown_invocation' };
    }
    const result = (await this.redis.eval(
      VERIFY_LATEST_LUA,
      2,
      KEY_INV(invocationId),
      KEY_LATEST(threadId, catId),
      callbackToken,
      String(now),
      String(newExpiresAt),
      invocationId,
    )) as [string, string | string[]];

    if (!Array.isArray(result) || result.length < 2) {
      return { ok: false, reason: 'unknown_invocation' };
    }
    if (result[0] === 'fail') {
      const reason = result[1];
      if (
        reason === 'expired' ||
        reason === 'invalid_token' ||
        reason === 'unknown_invocation' ||
        reason === 'stale_invocation'
      ) {
        return { ok: false, reason };
      }
      return { ok: false, reason: 'unknown_invocation' };
    }
    const fields = parseHashArray(result[1]);
    // Cloud Codex P2 (PR #1368, ef22153e1): regular verify() slides msgs key
    // TTL alongside the invocation; verifyLatest must mirror that or
    // long-running sessions kept alive only by refresh-token would lose
    // their dedup set when the original create-time TTL expired (clientMessageId
    // would be treated as first-seen again, breaking callback dedup contract).
    // PEXPIREAT on a non-existent msgs key is a no-op so this is safe.
    await this.redis.pexpireat(KEY_MSGS(invocationId), newExpiresAt + 60_000);
    const record = recordFromHash(fields, new Set<string>());
    if (!record) return { ok: false, reason: 'unknown_invocation' };
    return { ok: true, record };
  }

  async verify(invocationId: string, callbackToken: string, ttlMs: number): Promise<VerifyResult> {
    const now = Date.now();
    const newExpiresAt = now + ttlMs;
    const result = (await this.redis.eval(
      VERIFY_LUA,
      1,
      KEY_INV(invocationId),
      callbackToken,
      String(now),
      String(newExpiresAt),
    )) as [string, string | string[]];

    if (!Array.isArray(result) || result.length < 2) {
      return { ok: false, reason: 'unknown_invocation' };
    }

    if (result[0] === 'fail') {
      const reason = result[1];
      if (reason === 'expired' || reason === 'invalid_token' || reason === 'unknown_invocation') {
        return { ok: false, reason };
      }
      return { ok: false, reason: 'unknown_invocation' };
    }

    const fields = parseHashArray(result[1]);
    // F174-B P2 (cloud Codex review #1363): don't load idempotency set on every
    // verify(). It's hot path — and no consumer of verify() reads
    // record.clientMessageIds (only this backend's claimClientMessageId mutates
    // the underlying SET via dedicated SADD/SCARD calls). Return empty Set;
    // claimClientMessageId() does its own EXISTS check on the msgs key so we
    // can't use the empty Set against it.
    const msgs = new Set<string>();
    // Slide msgs key TTL alongside record (best-effort; only if it exists).
    // PEXPIREAT on a non-existent key is a no-op so this is safe.
    await this.redis.pexpireat(KEY_MSGS(invocationId), newExpiresAt + 60_000);
    // F174 Phase B P1 (gpt52 review #1363): slide latest pointer TTL too.
    // Without this, the latest key stays anchored to its create()-time
    // PEXPIREAT and drifts behind the record → isLatest() returns false in
    // long sessions even though the record verifies. We only slide if the
    // pointer still references THIS invocationId — otherwise a newer create()
    // already overwrote it and we shouldn't extend that newer pointer's life
    // on behalf of an old verify.
    if (fields.threadId && fields.catId) {
      const latestKey = KEY_LATEST(fields.threadId, fields.catId);
      const currentLatest = await this.redis.get(latestKey);
      if (currentLatest === invocationId) {
        await this.redis.pexpireat(latestKey, newExpiresAt + 60_000);
      }
    }
    const record = recordFromHash(fields, msgs);
    if (!record) return { ok: false, reason: 'unknown_invocation' };
    return { ok: true, record };
  }

  async getRecord(invocationId: string): Promise<InvocationRecord | null> {
    const raw = await this.redis.hgetall(KEY_INV(invocationId));
    if (!raw || Object.keys(raw).length === 0) return null;
    const expiresAt = Number(raw.expiresAt ?? 0);
    if (Date.now() > expiresAt) {
      await this.redis.del(KEY_INV(invocationId));
      return null;
    }
    // F174-B P2 (cloud Codex review): same as verify(), don't load msgs set
    // unless caller explicitly needs it. isLatest() (the only consumer) only
    // reads threadId/catId.
    return recordFromHash(raw, new Set<string>());
  }

  /**
   * F174 D2b-1 — pure record read, ignores expiry, never deletes. Returns
   * whatever the hash currently contains (subject only to Redis-side TTL
   * eviction). 砚砚 P1 review: PR #1397 — the notifier needs metadata for
   * 401-causing invocations after verify() has just deleted them.
   */
  async peekRecord(invocationId: string): Promise<InvocationRecord | null> {
    const raw = await this.redis.hgetall(KEY_INV(invocationId));
    if (!raw || Object.keys(raw).length === 0) return null;
    return recordFromHash(raw, new Set<string>());
  }

  async isLatest(invocationId: string): Promise<boolean> {
    const record = await this.getRecord(invocationId);
    if (!record) return false;
    const latest = await this.redis.get(KEY_LATEST(record.threadId, record.catId as string));
    return latest === invocationId;
  }

  async getLatestId(threadId: string, catId: string): Promise<string | undefined> {
    const id = await this.redis.get(KEY_LATEST(threadId, catId));
    return id ?? undefined;
  }

  async claimClientMessageId(invocationId: string, clientMessageId: string): Promise<boolean> {
    const recordExists = await this.redis.exists(KEY_INV(invocationId));
    if (recordExists === 0) return false;

    const added = await this.redis.sadd(KEY_MSGS(invocationId), clientMessageId);
    if (added === 0) return false;

    // Tie msgs key TTL to record's expiresAt (best-effort; OK if record disappears mid-flight)
    const expiresAt = await this.redis.hget(KEY_INV(invocationId), 'expiresAt');
    if (expiresAt) {
      await this.redis.pexpireat(KEY_MSGS(invocationId), Number(expiresAt));
    }

    // Bound enforcement: if Set exceeds MAX, SPOP one element (random eviction —
    // acceptable since dedup window is best-effort, not a security boundary)
    const count = await this.redis.scard(KEY_MSGS(invocationId));
    if (count > MAX_CLIENT_MESSAGE_IDS) {
      await this.redis.spop(KEY_MSGS(invocationId));
    }
    return true;
  }

  async tryClaimRefreshCooldown(invocationId: string, cooldownMs: number): Promise<boolean> {
    // SET key value PX <ms> NX → atomically write only if absent.
    // Returns 'OK' on first claim, null when key already exists (still cooling down).
    const result = await this.redis.set(KEY_REFRESH_COOLDOWN(invocationId), '1', 'PX', cooldownMs, 'NX');
    return result === 'OK';
  }
}
