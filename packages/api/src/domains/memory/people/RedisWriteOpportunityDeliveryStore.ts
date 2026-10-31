import { type DeliveredWriteOpportunityRecordV1, deliveredWriteOpportunityRecordV1Schema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  WriteOpportunityDeliveryConflictError,
  type WriteOpportunityDeliveryStore,
} from './WriteOpportunityDeliveryStore.js';

function encode(value: string): string {
  return encodeURIComponent(value);
}

export const WriteOpportunityDeliveryKeys = {
  delivered: (ownerUserId: string, opportunityId: string) =>
    `person-memory:write-opportunity-delivered:${encode(ownerUserId)}:${encode(opportunityId)}`,
  /** Reverse index so an invalidated lineage can purge every generation's evidence in one pass. */
  lineage: (ownerUserId: string, dedupeLineage: string) =>
    `person-memory:write-opportunity-delivered-lineage:${encode(ownerUserId)}:${encode(dedupeLineage)}`,
  invocation: (ownerUserId: string, invocationId: string) =>
    `person-memory:write-opportunity-delivered-invocation:${encode(ownerUserId)}:${encode(invocationId)}`,
} as const;

/**
 * Store the record and register it in the lineage index atomically.
 *
 * A later invocation may retry the same immutable opportunity generation after cat absence. The
 * compare-and-set replaces only presentation-attempt fields and removes the old invocation reverse
 * index, so a late callback from that attempt fails closed. Any lineage/source/scope drift conflicts.
 */
const RECORD_DELIVERED_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then
  if ARGV[3] == '' or existing ~= ARGV[3] then return 'CONFLICT' end
elseif ARGV[3] ~= '' then
  return 'CONFLICT'
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('SREM', KEYS[3], ARGV[2])
redis.call('SADD', KEYS[4], ARGV[2])
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
redis.call('PERSIST', KEYS[3])
redis.call('PERSIST', KEYS[4])
return 'OK'
`;

function immutableDeliveryFacts(record: DeliveredWriteOpportunityRecordV1): string {
  const {
    invocationId: _invocationId,
    presentedAt: _presentedAt,
    generationId: _generationId,
    evidenceRef: _evidenceRef,
    continuityDispositionRef: _continuityDispositionRef,
    ...facts
  } = record;
  return JSON.stringify(facts);
}

export class RedisWriteOpportunityDeliveryStore implements WriteOpportunityDeliveryStore {
  constructor(private readonly redis: RedisClient) {}

  async recordDelivered(record: DeliveredWriteOpportunityRecordV1): Promise<void> {
    const parsed = deliveredWriteOpportunityRecordV1Schema.parse(record);
    const serialized = JSON.stringify(parsed);
    const existingRaw = await this.redis.get(
      WriteOpportunityDeliveryKeys.delivered(parsed.ownerUserId, parsed.opportunityId),
    );
    const existing = existingRaw ? deliveredWriteOpportunityRecordV1Schema.safeParse(JSON.parse(existingRaw)) : null;
    if (existing && (!existing.success || immutableDeliveryFacts(existing.data) !== immutableDeliveryFacts(parsed))) {
      throw new WriteOpportunityDeliveryConflictError(parsed.opportunityId);
    }
    const previousInvocationId = existing?.success ? existing.data.invocationId : parsed.invocationId;
    const result = String(
      await this.redis.eval(
        RECORD_DELIVERED_LUA,
        4,
        WriteOpportunityDeliveryKeys.delivered(parsed.ownerUserId, parsed.opportunityId),
        WriteOpportunityDeliveryKeys.lineage(parsed.ownerUserId, parsed.dedupeLineage),
        WriteOpportunityDeliveryKeys.invocation(parsed.ownerUserId, previousInvocationId),
        WriteOpportunityDeliveryKeys.invocation(parsed.ownerUserId, parsed.invocationId),
        serialized,
        parsed.opportunityId,
        existingRaw ?? '',
      ),
    );
    if (result === 'CONFLICT') {
      throw new WriteOpportunityDeliveryConflictError(parsed.opportunityId);
    }
  }

  async get(ownerUserId: string, opportunityId: string): Promise<DeliveredWriteOpportunityRecordV1 | null> {
    const raw = await this.redis.get(WriteOpportunityDeliveryKeys.delivered(ownerUserId, opportunityId));
    if (!raw) return null;
    const parsed = deliveredWriteOpportunityRecordV1Schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  async listInvocationOpportunityIds(ownerUserId: string, invocationId: string): Promise<readonly string[]> {
    return this.redis.smembers(WriteOpportunityDeliveryKeys.invocation(ownerUserId, invocationId));
  }

  async purgeLineage(ownerUserId: string, dedupeLineage: string): Promise<number> {
    const lineageKey = WriteOpportunityDeliveryKeys.lineage(ownerUserId, dedupeLineage);
    const opportunityIds = await this.redis.smembers(lineageKey);
    if (opportunityIds.length === 0) {
      await this.redis.del(lineageKey);
      return 0;
    }
    const records = await Promise.all(opportunityIds.map((opportunityId) => this.get(ownerUserId, opportunityId)));
    const pipeline = this.redis.pipeline();
    opportunityIds.forEach((opportunityId, index) => {
      pipeline.del(WriteOpportunityDeliveryKeys.delivered(ownerUserId, opportunityId));
      const record = records[index];
      if (record) {
        pipeline.srem(WriteOpportunityDeliveryKeys.invocation(ownerUserId, record.invocationId), opportunityId);
      }
    });
    pipeline.del(lineageKey);
    await pipeline.exec();
    return opportunityIds.length;
  }
}
