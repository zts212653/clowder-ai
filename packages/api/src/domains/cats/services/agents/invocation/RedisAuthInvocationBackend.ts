/** Redis-backed explicit callback credential lifecycle (F298 Phase A). */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { CallerTraceContext } from '../../../../../infrastructure/telemetry/genai-semconv.js';
import type {
  AuthInvocationInput,
  AuthInvocationMigrationResult,
  IAuthInvocationBackend,
} from './IAuthInvocationBackend.js';
import {
  type AuthTerminalCommitInput,
  type AuthTerminalCommitResult,
  type InvocationRecord,
  type VerifyResult,
} from './InvocationRegistry.js';
import { normalizeOwnerAuthProvenance } from './owner-auth-provenance.js';
import {
  CLAIM_AUTH_MESSAGE_ID_LUA,
  COMMIT_AUTH_TERMINAL_LUA,
  CREATE_AUTH_INVOCATION_LUA,
  MIGRATE_AUTH_SLOT_LUA,
  VERIFY_AUTH_INVOCATION_LUA,
} from './RedisAuthInvocationLua.js';
import { authRecordFromRedisHash, isAuthTerminalState, parseRedisHashArray } from './RedisAuthInvocationRecord.js';

const KEY_INV = (id: string) => `auth:inv:${id}`;
const KEY_MSGS = (id: string) => `auth:inv:${id}:msgs`;
const KEY_LATEST = (threadId: string, catId: string) => `auth:latest:${threadId}:${catId}`;
const KEY_REFRESH_COOLDOWN = (id: string) => `auth:refresh-cooldown:${id}`;
const DEFAULT_TOMBSTONE_GC_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLIENT_MESSAGE_IDS = 1000;
export class RedisAuthInvocationBackend implements IAuthInvocationBackend {
  private readonly tombstoneGcTtlMs: number;

  constructor(
    private readonly redis: RedisClient,
    options?: { tombstoneGcTtlMs?: number },
  ) {
    this.tombstoneGcTtlMs = options?.tombstoneGcTtlMs ?? DEFAULT_TOMBSTONE_GC_TTL_MS;
  }

  async create(input: AuthInvocationInput): Promise<void> {
    const fields: string[] = [
      'invocationId',
      input.invocationId,
      'callbackToken',
      input.callbackToken,
      'userId',
      input.userId,
      'ownerAuthProvenance',
      normalizeOwnerAuthProvenance(input.ownerAuthProvenance),
      'catId',
      input.catId as string,
      'threadId',
      input.threadId,
      'createdAt',
      String(input.createdAt),
      'state',
      'active',
    ];
    if (input.parentInvocationId) fields.push('parentInvocationId', input.parentInvocationId);
    if (input.managedWorkBinding) {
      fields.push('managedWorkId', input.managedWorkBinding.workId);
      fields.push('managedWorkAttemptId', input.managedWorkBinding.attemptId);
    }
    if (input.a2aTriggerMessageId) fields.push('a2aTriggerMessageId', input.a2aTriggerMessageId);
    if (input.originTriggerMessageId) fields.push('originTriggerMessageId', input.originTriggerMessageId);
    if (input.toolExecutionPolicy) fields.push('toolExecutionPolicy', JSON.stringify(input.toolExecutionPolicy));

    const latestKey = KEY_LATEST(input.threadId, input.catId as string);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const previousId = (await this.redis.get(latestKey)) ?? '';
      const oldKey = previousId ? KEY_INV(previousId) : KEY_INV(input.invocationId);
      const oldMsgsKey = previousId ? KEY_MSGS(previousId) : KEY_MSGS(input.invocationId);
      const now = Date.now();
      const result = (await this.redis.eval(
        CREATE_AUTH_INVOCATION_LUA,
        4,
        KEY_INV(input.invocationId),
        latestKey,
        oldKey,
        oldMsgsKey,
        previousId,
        input.invocationId,
        String(now),
        String(now + this.tombstoneGcTtlMs),
        ...fields,
      )) as [string, string];
      if (result?.[0] === 'ok') return;
      if (result?.[0] !== 'retry') throw new Error('callback auth create CAS returned an invalid response');
    }
    throw new Error('callback auth latest-slot contention exceeded retry budget');
  }

  async peek(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    const raw = await this.redis.hgetall(KEY_INV(invocationId));
    return this.verifyHash(raw, callbackToken);
  }

  async verifyLatest(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.verifyWithLua(invocationId, callbackToken, true);
  }

  async verify(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.verifyWithLua(invocationId, callbackToken, false);
  }

  async commitTerminal(input: AuthTerminalCommitInput): Promise<AuthTerminalCommitResult> {
    const meta = await this.redis.hmget(KEY_INV(input.invocationId), 'threadId', 'catId');
    const threadId = meta?.[0] ?? '';
    const catId = meta?.[1] ?? '';
    const expiresAt = Date.now() + this.tombstoneGcTtlMs;
    const result = (await this.redis.eval(
      COMMIT_AUTH_TERMINAL_LUA,
      3,
      KEY_INV(input.invocationId),
      KEY_MSGS(input.invocationId),
      KEY_LATEST(threadId, catId),
      input.invocationId,
      input.disposition,
      String(input.endedAt),
      input.endReason,
      input.terminalRef ?? '',
      String(expiresAt),
    )) as [string, string[]];
    if (result?.[0] === 'not_found') return { outcome: 'not_found', record: null };
    const record = authRecordFromRedisHash(parseRedisHashArray(result?.[1]), new Set<string>());
    if (!record) throw new Error(`callback auth terminal CAS returned a corrupt record: ${input.invocationId}`);
    return { outcome: result[0] === 'committed' ? 'committed' : 'already_terminal', record };
  }

  async getRecord(invocationId: string): Promise<InvocationRecord | null> {
    const raw = await this.redis.hgetall(KEY_INV(invocationId));
    if (!raw || Object.keys(raw).length === 0) return null;
    const record = authRecordFromRedisHash(raw, new Set<string>());
    if (!record) throw new Error(`corrupt callback auth record: ${invocationId}`);
    if (record.state === 'active') await this.redis.persist(KEY_INV(invocationId));
    return record;
  }

  async peekRecord(invocationId: string): Promise<InvocationRecord | null> {
    const raw = await this.redis.hgetall(KEY_INV(invocationId));
    if (!raw || Object.keys(raw).length === 0) return null;
    return authRecordFromRedisHash(raw, new Set<string>());
  }

  async listActiveRecords(): Promise<InvocationRecord[]> {
    const records: InvocationRecord[] = [];
    for (const key of await this.scanInvocationKeys()) {
      const raw = await this.redis.hgetall(key);
      const record = authRecordFromRedisHash(raw, new Set<string>());
      if (!record) throw new Error(`corrupt callback auth record during startup scan: ${key}`);
      if (record.state === 'active') records.push(record);
    }
    return records;
  }

  async migrateLegacyRecords(): Promise<AuthInvocationMigrationResult> {
    const keys = await this.scanInvocationKeys();
    const records = await this.loadMigrationRecords(keys);
    let persistedActive = 0;
    let replaced = 0;
    let rebuiltLatest = 0;
    for (const values of this.groupActiveRecordsBySlot(records).values()) {
      const result = await this.migrateActiveSlot(values);
      persistedActive += result.persistedActive;
      replaced += result.replaced;
      rebuiltLatest += result.rebuiltLatest;
    }

    return { scanned: records.length, persistedActive, replaced, rebuiltLatest };
  }

  async isLatest(invocationId: string): Promise<boolean> {
    const record = await this.getRecord(invocationId);
    if (!record || record.state !== 'active') return false;
    return (await this.redis.get(KEY_LATEST(record.threadId, record.catId as string))) === invocationId;
  }

  async getLatestId(threadId: string, catId: string): Promise<string | undefined> {
    const key = KEY_LATEST(threadId, catId);
    const invocationId = await this.redis.get(key);
    if (!invocationId) return undefined;
    if ((await this.redis.exists(KEY_INV(invocationId))) === 1) return invocationId;
    await this.redis.del(key);
    return undefined;
  }

  async claimClientMessageId(invocationId: string, clientMessageId: string): Promise<boolean> {
    const claimed = Number(
      await this.redis.eval(
        CLAIM_AUTH_MESSAGE_ID_LUA,
        2,
        KEY_INV(invocationId),
        KEY_MSGS(invocationId),
        clientMessageId,
        String(MAX_CLIENT_MESSAGE_IDS),
      ),
    );
    return claimed === 1;
  }

  async tryClaimRefreshCooldown(invocationId: string, cooldownMs: number): Promise<boolean> {
    return (await this.redis.set(KEY_REFRESH_COOLDOWN(invocationId), '1', 'PX', cooldownMs, 'NX')) === 'OK';
  }

  async setTraceContext(invocationId: string, ctx: CallerTraceContext): Promise<void> {
    const key = KEY_INV(invocationId);
    if ((await this.redis.hget(key, 'state')) !== 'active') return;
    await this.redis.hset(key, 'traceId', ctx.traceId, 'spanId', ctx.spanId, 'traceFlags', String(ctx.traceFlags));
  }

  private async verifyWithLua(
    invocationId: string,
    callbackToken: string,
    requireLatest: boolean,
  ): Promise<VerifyResult> {
    const meta = await this.redis.hmget(KEY_INV(invocationId), 'threadId', 'catId');
    const threadId = meta?.[0];
    const catId = meta?.[1];
    if (!threadId || !catId) return { ok: false, reason: 'unknown_invocation' };
    const result = (await this.redis.eval(
      VERIFY_AUTH_INVOCATION_LUA,
      3,
      KEY_INV(invocationId),
      KEY_MSGS(invocationId),
      KEY_LATEST(threadId, catId),
      callbackToken,
      invocationId,
      requireLatest ? '1' : '0',
    )) as [string, string | string[]];
    if (!Array.isArray(result) || result.length < 2) return { ok: false, reason: 'unknown_invocation' };
    if (result[0] === 'fail') {
      const reason = result[1];
      if (
        reason === 'invalid_token' ||
        reason === 'unknown_invocation' ||
        reason === 'stale_invocation' ||
        isAuthTerminalState(reason)
      ) {
        return { ok: false, reason: reason as VerifyResult extends { ok: false; reason: infer R } ? R : never };
      }
      return { ok: false, reason: 'unknown_invocation' };
    }
    const record = authRecordFromRedisHash(parseRedisHashArray(result[1]), new Set<string>());
    return record ? { ok: true, record } : { ok: false, reason: 'unknown_invocation' };
  }

  private verifyHash(raw: Record<string, string>, callbackToken: string): VerifyResult {
    if (!raw || Object.keys(raw).length === 0) return { ok: false, reason: 'unknown_invocation' };
    if (raw.callbackToken !== callbackToken) return { ok: false, reason: 'invalid_token' };
    const record = authRecordFromRedisHash(raw, new Set<string>());
    if (!record) return { ok: false, reason: 'unknown_invocation' };
    return record.state === 'active' ? { ok: true, record } : { ok: false, reason: record.state };
  }

  private async scanInvocationKeys(): Promise<string[]> {
    const prefix = this.redis.options.keyPrefix ?? '';
    const match = `${prefix}auth:inv:*`;
    const logicalKeys: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      for (const rawKey of keys) {
        const key = prefix && rawKey.startsWith(prefix) ? rawKey.slice(prefix.length) : rawKey;
        if (!key.endsWith(':msgs')) logicalKeys.push(key);
      }
    } while (cursor !== '0');
    return logicalKeys;
  }

  private async loadMigrationRecords(keys: string[]): Promise<InvocationRecord[]> {
    const records: InvocationRecord[] = [];
    for (const key of keys) {
      const record = authRecordFromRedisHash(await this.redis.hgetall(key), new Set<string>());
      if (!record) throw new Error(`corrupt callback auth record during migration: ${key}`);
      records.push(record);
    }
    return records;
  }

  private groupActiveRecordsBySlot(records: InvocationRecord[]): Map<string, InvocationRecord[]> {
    const slots = new Map<string, InvocationRecord[]>();
    for (const record of records) {
      if (record.state !== 'active') continue;
      const slot = `${record.threadId}\u0000${record.catId as string}`;
      const values = slots.get(slot) ?? [];
      values.push(record);
      slots.set(slot, values);
    }
    return slots;
  }

  private async migrateActiveSlot(
    values: InvocationRecord[],
  ): Promise<{ persistedActive: number; replaced: number; rebuiltLatest: number }> {
    values.sort(
      (left, right) => left.createdAt - right.createdAt || left.invocationId.localeCompare(right.invocationId),
    );
    const sample = values[0];
    const latestKey = KEY_LATEST(sample.threadId, sample.catId as string);
    const recordKeys = values.flatMap((record) => [KEY_INV(record.invocationId), KEY_MSGS(record.invocationId)]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const expectedLatest = (await this.redis.get(latestKey)) ?? '';
      const now = Date.now();
      const result = (await this.redis.eval(
        MIGRATE_AUTH_SLOT_LUA,
        2 + recordKeys.length,
        latestKey,
        expectedLatest ? KEY_INV(expectedLatest) : latestKey,
        ...recordKeys,
        expectedLatest,
        String(now),
        String(now + this.tombstoneGcTtlMs),
        String(values.length),
        sample.threadId,
        sample.catId as string,
        ...values.map((record) => record.invocationId),
      )) as [string, string, string, string];
      if (result?.[0] === 'ok') {
        return {
          persistedActive: values.length,
          replaced: Number(result[2]),
          rebuiltLatest: Number(result[3]),
        };
      }
      if (result?.[0] !== 'retry') throw new Error('callback auth slot migration returned an invalid response');
    }
    throw new Error('callback auth slot migration contention exceeded retry budget');
  }
}
