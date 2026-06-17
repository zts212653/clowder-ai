import { createHash } from 'node:crypto';
import type { AgentKeyRecord, AgentKeyVerifyResult, CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { AgentKeyInput, IAgentKeyBackend } from './IAgentKeyBackend.js';

const KEY_RECORD = (agentKeyId: string) => `auth:agent-key:${agentKeyId}`;
const KEY_INDEX = 'auth:agent-key:index';
const KEY_CLIENT_MESSAGE_ID = (agentKeyId: string, clientMessageId: string) =>
  `auth:agent-key:${agentKeyId}:client-message-id:${hashClientMessageId(clientMessageId)}`;
const REDIS_REAPER_GRACE_MS = 60_000;
const CLIENT_MESSAGE_ID_TTL_MS = 60 * 60 * 1000;

function hashClientMessageId(clientMessageId: string): string {
  return createHash('sha256').update(clientMessageId).digest('hex');
}

function ttlCutoff(record: Pick<AgentKeyRecord, 'expiresAt' | 'graceUntil'>): number {
  return (record.graceUntil ?? record.expiresAt) + REDIS_REAPER_GRACE_MS;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recordFromHash(fields: Record<string, string>): AgentKeyRecord | null {
  if (!fields.agentKeyId || !fields.catId || !fields.userId || !fields.secretHash || !fields.salt) return null;
  if (fields.scope !== 'user-bound') return null;
  const issuedAt = Number(fields.issuedAt ?? 0);
  const expiresAt = Number(fields.expiresAt ?? 0);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;

  const record: AgentKeyRecord = {
    agentKeyId: fields.agentKeyId,
    catId: fields.catId as CatId,
    userId: fields.userId,
    secretHash: fields.secretHash,
    salt: fields.salt,
    scope: fields.scope,
    issuedAt,
    expiresAt,
  };

  if (fields.rotatedFrom) record.rotatedFrom = fields.rotatedFrom;
  const graceUntil = optionalNumber(fields.graceUntil);
  if (graceUntil !== undefined) record.graceUntil = graceUntil;
  const lastUsedAt = optionalNumber(fields.lastUsedAt);
  if (lastUsedAt !== undefined) record.lastUsedAt = lastUsedAt;
  const revokedAt = optionalNumber(fields.revokedAt);
  if (revokedAt !== undefined) record.revokedAt = revokedAt;
  if (fields.revokedReason) record.revokedReason = fields.revokedReason;

  return record;
}

function fieldsFromRecord(record: AgentKeyInput | AgentKeyRecord): string[] {
  const fields = [
    'agentKeyId',
    record.agentKeyId,
    'catId',
    record.catId as string,
    'userId',
    record.userId,
    'secretHash',
    record.secretHash,
    'salt',
    record.salt,
    'scope',
    record.scope,
    'issuedAt',
    String(record.issuedAt),
    'expiresAt',
    String(record.expiresAt),
  ];

  if (record.rotatedFrom) fields.push('rotatedFrom', record.rotatedFrom);
  if (record.graceUntil !== undefined) fields.push('graceUntil', String(record.graceUntil));
  if ('lastUsedAt' in record && record.lastUsedAt !== undefined) fields.push('lastUsedAt', String(record.lastUsedAt));
  if (record.revokedAt !== undefined) fields.push('revokedAt', String(record.revokedAt));
  if (record.revokedReason) fields.push('revokedReason', record.revokedReason);

  return fields;
}

export class RedisAgentKeyBackend implements IAgentKeyBackend {
  constructor(private readonly redis: RedisClient) {}

  async create(input: AgentKeyInput): Promise<void> {
    await this.redis.hset(KEY_RECORD(input.agentKeyId), ...fieldsFromRecord(input));
    await this.redis.sadd(KEY_INDEX, input.agentKeyId);
    await this.redis.pexpireat(KEY_RECORD(input.agentKeyId), ttlCutoff(input));
  }

  async verify(secret: string): Promise<AgentKeyVerifyResult> {
    const ids = await this.redis.smembers(KEY_INDEX);
    for (const agentKeyId of ids) {
      const record = await this.get(agentKeyId);
      if (!record) {
        await this.redis.srem(KEY_INDEX, agentKeyId);
        continue;
      }
      const hash = createHash('sha256')
        .update(secret + record.salt)
        .digest('hex');
      if (hash === record.secretHash) return this.verifyRecord(record);
    }
    return { ok: false, reason: 'agent_key_unknown' };
  }

  async get(agentKeyId: string): Promise<AgentKeyRecord | null> {
    const raw = await this.redis.hgetall(KEY_RECORD(agentKeyId));
    if (!raw || Object.keys(raw).length === 0) return null;
    return recordFromHash(raw);
  }

  async list(filter: { catId?: string; userId?: string; includeRevoked?: boolean }): Promise<AgentKeyRecord[]> {
    const ids = await this.redis.smembers(KEY_INDEX);
    const results: AgentKeyRecord[] = [];
    for (const agentKeyId of ids) {
      const record = await this.get(agentKeyId);
      if (!record) {
        await this.redis.srem(KEY_INDEX, agentKeyId);
        continue;
      }
      if (filter.catId && record.catId !== filter.catId) continue;
      if (filter.userId && record.userId !== filter.userId) continue;
      if (!filter.includeRevoked && record.revokedAt) continue;
      results.push(record);
    }
    return results;
  }

  async revoke(agentKeyId: string, reason: string): Promise<boolean> {
    const exists = await this.redis.exists(KEY_RECORD(agentKeyId));
    if (exists === 0) return false;
    await this.redis.hset(KEY_RECORD(agentKeyId), 'revokedAt', String(Date.now()), 'revokedReason', reason);
    return true;
  }

  async updateGrace(agentKeyId: string, graceUntil: number): Promise<boolean> {
    const exists = await this.redis.exists(KEY_RECORD(agentKeyId));
    if (exists === 0) return false;
    await this.redis.hset(KEY_RECORD(agentKeyId), 'graceUntil', String(graceUntil));
    await this.redis.pexpireat(KEY_RECORD(agentKeyId), graceUntil + REDIS_REAPER_GRACE_MS);
    return true;
  }

  async touchLastUsed(agentKeyId: string, timestamp: number): Promise<void> {
    const exists = await this.redis.exists(KEY_RECORD(agentKeyId));
    if (exists !== 0) await this.redis.hset(KEY_RECORD(agentKeyId), 'lastUsedAt', String(timestamp));
  }

  async claimClientMessageId(agentKeyId: string, clientMessageId: string): Promise<boolean> {
    const record = await this.get(agentKeyId);
    if (!record || record.revokedAt) return false;
    const now = Date.now();
    if (record.graceUntil && now > record.graceUntil) return false;
    if (!record.graceUntil && now > record.expiresAt) return false;

    const result = await this.redis.set(
      KEY_CLIENT_MESSAGE_ID(agentKeyId, clientMessageId),
      '1',
      'PX',
      CLIENT_MESSAGE_ID_TTL_MS,
      'NX',
    );
    return result === 'OK';
  }

  private async verifyRecord(record: AgentKeyRecord): Promise<AgentKeyVerifyResult> {
    if (record.revokedAt) return { ok: false, reason: 'agent_key_revoked' };
    const now = Date.now();
    if (record.graceUntil && now > record.graceUntil) return { ok: false, reason: 'agent_key_expired' };
    if (!record.graceUntil && now > record.expiresAt) return { ok: false, reason: 'agent_key_expired' };
    await this.touchLastUsed(record.agentKeyId, now);
    return { ok: true, record: { ...record, lastUsedAt: now } };
  }
}
