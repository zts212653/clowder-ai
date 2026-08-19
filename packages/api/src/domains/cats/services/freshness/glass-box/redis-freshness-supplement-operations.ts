import type { FreshnessSupplementAggregate, FreshnessSupplementFailureReason } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { FreshnessSupplementKeys } from '../../stores/redis-keys/freshness-closure-keys.js';
import type { OfferFreshnessSupplementResult } from '../freshness-closure-store-types.js';
import {
  advanceFreshnessSupplement,
  claimFreshnessSupplement,
  commitFreshnessSupplement,
  createFreshnessSupplement,
  declineFreshnessSupplement,
  type FreshnessSupplementOfferInput,
  failFreshnessSupplement,
  MAX_AUTOMATIC_SUPPLEMENTS_PER_LINEAGE,
  markFreshnessSupplementBudgetExhausted,
} from './FreshnessSupplementStateMachine.js';

const OPEN_SUPPLEMENT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('SADD', KEYS[4], ARGV[1])
return 1
`;

const CAS_SUPPLEMENT_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if tonumber(current.revision) ~= tonumber(ARGV[1]) then return -1 end
local lease = redis.call('GET', KEYS[2])
if ARGV[5] == 'running' and lease and lease ~= ARGV[2] then return -3 end
if ARGV[5] == 'running' then redis.call('SET', KEYS[2], ARGV[2]) end
if ARGV[4] == 'running' and ARGV[5] ~= 'running' and lease == ARGV[2] then
  redis.call('DEL', KEYS[2])
end
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;

const DELETE_SUPPLEMENT_LUA = `
redis.call('SREM', KEYS[2], ARGV[1])
if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
redis.call('SREM', KEYS[4], ARGV[1])
redis.call('SREM', KEYS[5], ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`;

const MAX_CAS_ATTEMPTS = 20;

function parseSupplement(raw: string | null): FreshnessSupplementAggregate | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as FreshnessSupplementAggregate;
  if (
    !parsed.id ||
    !parsed.lineageId ||
    !parsed.originalMessageId ||
    (parsed.seq !== 1 && parsed.seq !== 2) ||
    typeof parsed.revision !== 'number'
  ) {
    throw new Error('invalid persisted freshness supplement');
  }
  return parsed;
}

export class RedisFreshnessSupplementOperations {
  constructor(private readonly redis: RedisClient) {}

  async get(supplementId: string): Promise<FreshnessSupplementAggregate | null> {
    return parseSupplement(await this.redis.get(FreshnessSupplementKeys.detail(supplementId)));
  }

  async listByLineage(lineageId: string): Promise<FreshnessSupplementAggregate[]> {
    const ids = await this.redis.smembers(FreshnessSupplementKeys.lineage(lineageId));
    return (await this.readMany(ids)).sort((left, right) => left.seq - right.seq);
  }

  async listByThread(threadId: string): Promise<FreshnessSupplementAggregate[]> {
    const ids = await this.redis.smembers(FreshnessSupplementKeys.thread(threadId));
    return (await this.readMany(ids)).sort((left, right) => left.createdAt - right.createdAt || left.seq - right.seq);
  }

  async listRecoverable(): Promise<FreshnessSupplementAggregate[]> {
    const ids = await this.redis.smembers(FreshnessSupplementKeys.ALL);
    const supplements = await this.readMany(ids);
    return supplements
      .filter((supplement) => supplement.status === 'pending' || supplement.status === 'running')
      .sort((left, right) => left.createdAt - right.createdAt || left.seq - right.seq);
  }

  async offer(input: FreshnessSupplementOfferInput): Promise<OfferFreshnessSupplementResult> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const supplements = await this.listByLineage(input.lineageId);
      const pending = supplements.find((supplement) => supplement.status === 'pending');
      if (pending) {
        const advanced = await this.tryAdvancePending(pending, input);
        if (advanced) return advanced;
        continue;
      }
      const openedOrExhausted = await this.tryOpenOrExhaust(supplements, input);
      if (openedOrExhausted) return openedOrExhausted;
    }
    throw new Error(`freshness supplement offer CAS exhausted: ${input.lineageId}`);
  }

  claim(supplementId: string, input: { invocationId: string; now: number }): Promise<FreshnessSupplementAggregate> {
    return this.mutate(supplementId, (supplement) => claimFreshnessSupplement(supplement, input));
  }

  commit(
    supplementId: string,
    input: { invocationId: string; messageId: string; now: number },
  ): Promise<FreshnessSupplementAggregate> {
    return this.mutate(supplementId, (supplement) => commitFreshnessSupplement(supplement, input));
  }

  decline(supplementId: string, input: { invocationId: string; now: number }): Promise<FreshnessSupplementAggregate> {
    return this.mutate(supplementId, (supplement) => declineFreshnessSupplement(supplement, input));
  }

  fail(
    supplementId: string,
    input: { invocationId?: string; reason: FreshnessSupplementFailureReason; now: number },
  ): Promise<FreshnessSupplementAggregate> {
    return this.mutate(supplementId, (supplement) => failFreshnessSupplement(supplement, input));
  }

  async deleteByThread(threadId: string): Promise<number> {
    const ids = await this.redis.smembers(FreshnessSupplementKeys.thread(threadId));
    let deleted = 0;
    for (const id of ids) {
      const supplement = await this.get(id);
      if (!supplement) {
        await this.redis.srem(FreshnessSupplementKeys.thread(threadId), id);
        await this.redis.srem(FreshnessSupplementKeys.ALL, id);
        continue;
      }
      await this.redis.eval(
        DELETE_SUPPLEMENT_LUA,
        5,
        FreshnessSupplementKeys.detail(id),
        FreshnessSupplementKeys.lineage(supplement.lineageId),
        FreshnessSupplementKeys.runningLease(supplement.lineageId),
        FreshnessSupplementKeys.thread(threadId),
        FreshnessSupplementKeys.ALL,
        id,
      );
      deleted += 1;
    }
    return deleted;
  }

  private async open(candidate: FreshnessSupplementAggregate): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          OPEN_SUPPLEMENT_LUA,
          4,
          FreshnessSupplementKeys.detail(candidate.id),
          FreshnessSupplementKeys.lineage(candidate.lineageId),
          FreshnessSupplementKeys.thread(candidate.threadId),
          FreshnessSupplementKeys.ALL,
          candidate.id,
          JSON.stringify(candidate),
        ),
      ) === 1
    );
  }

  private async tryAdvancePending(
    pending: FreshnessSupplementAggregate,
    input: FreshnessSupplementOfferInput,
  ): Promise<OfferFreshnessSupplementResult | null> {
    try {
      const advanced = await this.mutate(pending.id, (current) => advanceFreshnessSupplement(current, input));
      return { kind: 'offered', supplement: advanced };
    } catch (error) {
      if (error instanceof Error && error.message.includes('only a pending freshness supplement')) return null;
      throw error;
    }
  }

  private async tryOpenOrExhaust(
    supplements: FreshnessSupplementAggregate[],
    input: FreshnessSupplementOfferInput,
  ): Promise<OfferFreshnessSupplementResult | null> {
    // Every durable attempt consumes a sequence, including failed/declined attempts. Counting
    // terminal attempts keeps retries bounded and prevents an unhealthy provider from looping.
    const nextSeq = supplements.length + 1;
    if (nextSeq <= MAX_AUTOMATIC_SUPPLEMENTS_PER_LINEAGE) {
      const candidate = createFreshnessSupplement({ ...input, seq: nextSeq as 1 | 2 });
      return (await this.open(candidate)) ? { kind: 'offered', supplement: candidate } : null;
    }

    const finalSupplement = supplements.find((supplement) => supplement.seq === MAX_AUTOMATIC_SUPPLEMENTS_PER_LINEAGE);
    if (!finalSupplement) throw new Error('freshness supplement lineage sequence gap');
    const exhausted = await this.mutate(finalSupplement.id, (current) =>
      markFreshnessSupplementBudgetExhausted(current, {
        unseenMessageIds: input.requiredMessageIds,
        observedAt: input.now,
      }),
    );
    return { kind: 'budget_exhausted', supplement: exhausted };
  }

  private async mutate(
    supplementId: string,
    transition: (supplement: FreshnessSupplementAggregate) => FreshnessSupplementAggregate,
  ): Promise<FreshnessSupplementAggregate> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.get(supplementId);
      if (!current) throw new Error(`freshness supplement not found: ${supplementId}`);
      const next = transition(current);
      const result = Number(
        await this.redis.eval(
          CAS_SUPPLEMENT_LUA,
          2,
          FreshnessSupplementKeys.detail(supplementId),
          FreshnessSupplementKeys.runningLease(current.lineageId),
          String(current.revision),
          supplementId,
          JSON.stringify(next),
          current.status,
          next.status,
        ),
      );
      if (result === 1) return next;
      if (result === 0) throw new Error(`freshness supplement not found: ${supplementId}`);
      if (result === -3) throw new Error('freshness lineage already has a running supplement');
    }
    throw new Error(`freshness supplement CAS exhausted: ${supplementId}`);
  }

  private async readMany(ids: string[]): Promise<FreshnessSupplementAggregate[]> {
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => FreshnessSupplementKeys.detail(id)));
    return raws.map(parseSupplement).filter((item): item is FreshnessSupplementAggregate => item !== null);
  }
}
