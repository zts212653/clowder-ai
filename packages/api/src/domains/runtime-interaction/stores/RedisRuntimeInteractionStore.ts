import type {
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionStatus,
  RuntimeInteractionTerminal,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  CreateRuntimeInteractionInput,
  InvalidateRuntimeInteractionInput,
  RuntimeInteractionStore,
  SettleRuntimeInteractionInput,
} from '../ports/RuntimeInteractionStore.js';

export const RuntimeInteractionKeys = {
  detail: (interactionId: string) => `runtime-interaction:${interactionId}`,
  active: () => 'runtime-interaction:active',
  pendingByUser: (userId: string) => `runtime-interaction:user:${userId}:pending`,
  activeByInvocation: (invocationId: string) => `runtime-interaction:invocation:${invocationId}:active`,
} as const;

const CREATE_STAGED_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1],
  'request', ARGV[1],
  'status', 'staged',
  'hostEpoch', ARGV[2],
  'updatedAt', ARGV[3])
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('SADD', KEYS[3], ARGV[4])
return 1
`;

const ANCHOR_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
local hostEpoch = redis.call('HGET', KEYS[1], 'hostEpoch')
if status ~= 'staged' or hostEpoch ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', 'pending', 'cardRef', ARGV[2], 'updatedAt', ARGV[3])
redis.call('ZADD', KEYS[2], tonumber(ARGV[4]), ARGV[5])
return 1
`;

const SETTLE_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
local hostEpoch = redis.call('HGET', KEYS[1], 'hostEpoch')
if status ~= 'pending' or hostEpoch ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'terminal', ARGV[3], 'updatedAt', ARGV[4])
redis.call('ZREM', KEYS[2], ARGV[5])
redis.call('SREM', KEYS[3], ARGV[5])
redis.call('SREM', KEYS[4], ARGV[5])
return 1
`;

const INVALIDATE_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'staged' and status ~= 'pending' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'invalidated', 'terminal', ARGV[1], 'updatedAt', ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('SREM', KEYS[3], ARGV[3])
redis.call('SREM', KEYS[4], ARGV[3])
return 1
`;

export class RedisRuntimeInteractionStore implements RuntimeInteractionStore {
  constructor(private readonly redis: RedisClient) {}

  async createStaged(input: CreateRuntimeInteractionInput): Promise<RuntimeInteractionRecord> {
    const record: RuntimeInteractionRecord = {
      request: structuredClone(input.request),
      status: 'staged',
      hostEpoch: input.hostEpoch,
      updatedAt: input.now,
    };
    const created = await this.redis.eval(
      CREATE_STAGED_LUA,
      3,
      RuntimeInteractionKeys.detail(input.request.interactionId),
      RuntimeInteractionKeys.active(),
      RuntimeInteractionKeys.activeByInvocation(input.request.owner.invocationId),
      JSON.stringify(record.request),
      record.hostEpoch,
      String(record.updatedAt),
      input.request.interactionId,
    );
    if (Number(created) !== 1) {
      throw new Error(`runtime interaction already exists: ${input.request.interactionId}`);
    }
    return record;
  }

  async anchor(
    interactionId: string,
    hostEpoch: string,
    cardRef: RuntimeInteractionCardRef,
    now: number,
  ): Promise<RuntimeInteractionRecord | null> {
    const existing = await this.get(interactionId);
    if (!existing) return null;
    const transitioned = await this.redis.eval(
      ANCHOR_LUA,
      2,
      RuntimeInteractionKeys.detail(interactionId),
      RuntimeInteractionKeys.pendingByUser(existing.request.owner.userId),
      hostEpoch,
      JSON.stringify(cardRef),
      String(now),
      String(existing.request.createdAt),
      interactionId,
    );
    return Number(transitioned) === 1 ? this.get(interactionId) : null;
  }

  async settle(input: SettleRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null> {
    const existing = await this.get(input.interactionId);
    if (!existing) return null;
    const transitioned = await this.redis.eval(
      SETTLE_LUA,
      4,
      RuntimeInteractionKeys.detail(input.interactionId),
      RuntimeInteractionKeys.pendingByUser(existing.request.owner.userId),
      RuntimeInteractionKeys.active(),
      RuntimeInteractionKeys.activeByInvocation(existing.request.owner.invocationId),
      input.hostEpoch,
      input.terminal.status,
      JSON.stringify(input.terminal),
      String(input.now),
      input.interactionId,
    );
    return Number(transitioned) === 1 ? this.get(input.interactionId) : null;
  }

  async invalidate(input: InvalidateRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null> {
    const existing = await this.get(input.interactionId);
    if (!existing) return null;
    return this.invalidateKnown(existing, input.reasonCode, input.now);
  }

  async invalidateByInvocation(
    invocationId: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]> {
    const ids = await this.redis.smembers(RuntimeInteractionKeys.activeByInvocation(invocationId));
    const records = await this.readMany(ids);
    return this.invalidateRecords(records, reasonCode, now);
  }

  async invalidateActiveFromOtherHostEpoch(
    hostEpoch: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]> {
    const ids = await this.redis.smembers(RuntimeInteractionKeys.active());
    const records = (await this.readMany(ids)).filter((record) => record.hostEpoch !== hostEpoch);
    return this.invalidateRecords(records, reasonCode, now);
  }

  async get(interactionId: string): Promise<RuntimeInteractionRecord | null> {
    return parseRecord(await this.redis.hgetall(RuntimeInteractionKeys.detail(interactionId)));
  }

  async listPendingByUser(userId: string): Promise<RuntimeInteractionRecord[]> {
    const ids = await this.redis.zrevrange(RuntimeInteractionKeys.pendingByUser(userId), 0, -1);
    return (await this.readMany(ids)).filter(
      (record) => record.status === 'pending' && record.request.owner.userId === userId,
    );
  }

  private async invalidateRecords(
    records: RuntimeInteractionRecord[],
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]> {
    const results = await Promise.all(records.map((record) => this.invalidateKnown(record, reasonCode, now)));
    return results.filter((record): record is RuntimeInteractionRecord => record !== null);
  }

  private async invalidateKnown(
    existing: RuntimeInteractionRecord,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord | null> {
    const terminal: RuntimeInteractionTerminal = { status: 'invalidated', reasonCode, settledAt: now };
    const id = existing.request.interactionId;
    const transitioned = await this.redis.eval(
      INVALIDATE_LUA,
      4,
      RuntimeInteractionKeys.detail(id),
      RuntimeInteractionKeys.pendingByUser(existing.request.owner.userId),
      RuntimeInteractionKeys.active(),
      RuntimeInteractionKeys.activeByInvocation(existing.request.owner.invocationId),
      JSON.stringify(terminal),
      String(now),
      id,
    );
    return Number(transitioned) === 1 ? this.get(id) : null;
  }

  private async readMany(ids: string[]): Promise<RuntimeInteractionRecord[]> {
    if (ids.length === 0) return [];
    const pipeline = this.redis.multi();
    for (const id of ids) pipeline.hgetall(RuntimeInteractionKeys.detail(id));
    const results = await pipeline.exec();
    if (!results) return [];
    return results.flatMap((result) => {
      const raw = result?.[1];
      const record = raw && typeof raw === 'object' ? parseRecord(raw as Record<string, string>) : null;
      return record ? [record] : [];
    });
  }
}

function parseRecord(raw: Record<string, string>): RuntimeInteractionRecord | null {
  if (!raw.request || !raw.status || !raw.hostEpoch || !raw.updatedAt) return null;
  return {
    request: JSON.parse(raw.request) as RuntimeInteractionRecord['request'],
    status: raw.status as RuntimeInteractionStatus,
    hostEpoch: raw.hostEpoch,
    ...(raw.cardRef ? { cardRef: JSON.parse(raw.cardRef) as RuntimeInteractionCardRef } : {}),
    ...(raw.terminal ? { terminal: JSON.parse(raw.terminal) as RuntimeInteractionTerminal } : {}),
    updatedAt: Number(raw.updatedAt),
  };
}
