import { createHash } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  type RequestReviewOwnerEvent,
  type RequestReviewOwnerLedger,
  type RequestReviewOwnerLedgerAppendResult,
  requestReviewOwnerEventSchema,
} from './request-review-owner-ledger-contract.js';

const KEYSPACE = 'capability-evolution:f100:request-review-owner';

export const RequestReviewOwnerLedgerKeys = {
  events: `${KEYSPACE}:events`,
  eventDigests: `${KEYSPACE}:event-digests`,
} as const;

const APPEND_LUA = `
local current = redis.call('HGET', KEYS[2], ARGV[1])
if current then
  if current == ARGV[2] then return 0 end
  return -1
end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('RPUSH', KEYS[1], ARGV[3])
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
return 1
`;

function digest(event: RequestReviewOwnerEvent): string {
  const { occurredAt: _firstObservedAt, ...ownerFact } = event;
  return createHash('sha256').update(JSON.stringify(ownerFact)).digest('hex');
}

export class RedisRequestReviewOwnerLedger implements RequestReviewOwnerLedger {
  constructor(private readonly redis: RedisClient) {}

  async append(raw: RequestReviewOwnerEvent): Promise<RequestReviewOwnerLedgerAppendResult> {
    const event = requestReviewOwnerEventSchema.parse(raw);
    const result = (await this.redis.eval(
      APPEND_LUA,
      2,
      RequestReviewOwnerLedgerKeys.events,
      RequestReviewOwnerLedgerKeys.eventDigests,
      event.eventId,
      digest(event),
      JSON.stringify(event),
    )) as number;
    if (result === 0) return { outcome: 'duplicate' };
    if (result === -1) return { outcome: 'idempotency_collision' };
    return { outcome: 'appended' };
  }

  async read(): Promise<RequestReviewOwnerEvent[]> {
    const encoded = await this.redis.lrange(RequestReviewOwnerLedgerKeys.events, 0, -1);
    return encoded.map((value) => requestReviewOwnerEventSchema.parse(JSON.parse(value)));
  }
}

export class MemoryRequestReviewOwnerLedger implements RequestReviewOwnerLedger {
  private readonly events: RequestReviewOwnerEvent[] = [];
  private readonly digests = new Map<string, string>();

  async append(raw: RequestReviewOwnerEvent): Promise<RequestReviewOwnerLedgerAppendResult> {
    const event = requestReviewOwnerEventSchema.parse(raw);
    const nextDigest = digest(event);
    const currentDigest = this.digests.get(event.eventId);
    if (currentDigest) {
      return { outcome: currentDigest === nextDigest ? 'duplicate' : 'idempotency_collision' };
    }
    this.digests.set(event.eventId, nextDigest);
    this.events.push(event);
    return { outcome: 'appended' };
  }

  async read(): Promise<RequestReviewOwnerEvent[]> {
    return structuredClone(this.events);
  }
}

export * from './request-review-owner-ledger-contract.js';
