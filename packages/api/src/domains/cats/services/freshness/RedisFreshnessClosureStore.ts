import type {
  FreshnessClosureAggregate,
  FreshnessSupplementAggregate,
  FreshnessSupplementFailureReason,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { FreshnessClosureKeys } from '../stores/redis-keys/freshness-closure-keys.js';
import { migrateLegacyFreshnessClosure } from './FreshnessClosureLegacyMigrationState.js';
import {
  blockFreshnessClosureRecovery,
  recoverFreshnessClosureAttempt,
  retryFreshnessClosure,
} from './FreshnessClosureRecoveryState.js';
import {
  advanceFreshnessClosure,
  blockFreshnessClosureAttempt,
  blockFreshnessClosurePreflight,
  claimFreshnessClosureAttempt,
  commitFreshnessClosureAttempt,
  createFreshnessClosure,
  disposeFreshnessClosure,
  refreshFreshnessClosureFrontier,
  supersedeFreshnessClosureAttempt,
} from './FreshnessClosureStateMachine.js';
import {
  type BlockFreshnessClosureInput,
  type BlockFreshnessClosureRecoveryInput,
  type ClaimFreshnessClosureInput,
  type CommitFreshnessClosureInput,
  type FreshnessClosureScope,
  type FreshnessClosureStore,
  type MigrateLegacyFreshnessClosureInput,
  type OfferFreshnessSupplementResult,
  type OpenOrAdvanceFreshnessClosureInput,
  type RefreshFreshnessClosureFrontierInput,
  type SupersedeFreshnessClosureInput,
} from './FreshnessClosureStore.js';
import type { FreshnessSupplementOfferInput } from './glass-box/FreshnessSupplementStateMachine.js';
import { RedisFreshnessSupplementOperations } from './glass-box/redis-freshness-supplement-operations.js';
import { isTerminal, parseClosure } from './redis-freshness-closure-serialization.js';

const OPEN_LINEAGE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('SADD', KEYS[4], ARGV[1])
return 1
`;

const CAS_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if tonumber(current.revision) ~= tonumber(ARGV[1]) then return -1 end
local lease = redis.call('GET', KEYS[3])
if ARGV[6] == 'running' and lease and lease ~= ARGV[2] then return -3 end
if ARGV[6] == 'running' then redis.call('SET', KEYS[3], ARGV[2]) end
if ARGV[5] == 'running' and ARGV[6] ~= 'running' and lease == ARGV[2] then
  redis.call('DEL', KEYS[3])
end
redis.call('SET', KEYS[1], ARGV[3])
if ARGV[4] == '1' then
  redis.call('SREM', KEYS[2], ARGV[2])
  if redis.call('GET', KEYS[4]) == ARGV[2] then redis.call('DEL', KEYS[4]) end
else
  redis.call('SADD', KEYS[2], ARGV[2])
end
return 1
`;

const MIGRATE_SCOPE_LUA = `
local legacy = redis.call('GET', KEYS[1])
if legacy then
  local raw = redis.call('GET', KEYS[4] .. legacy)
  if raw then
    local closure = cjson.decode(raw)
    if closure.status ~= 'committed' and closure.status ~= 'disposed' then
      redis.call('SADD', KEYS[2], legacy)
      if closure.status == 'running' then redis.call('SETNX', KEYS[3], legacy) end
    end
  end
  redis.call('DEL', KEYS[1])
end
return redis.call('SMEMBERS', KEYS[2])
`;

const DELETE_LUA = `
redis.call('SREM', KEYS[2], ARGV[1])
if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
if redis.call('GET', KEYS[4]) == ARGV[1] then redis.call('DEL', KEYS[4]) end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[5], ARGV[1])
redis.call('SREM', KEYS[6], ARGV[1])
return 1
`;

const MAX_CAS_ATTEMPTS = 20;

export class RedisFreshnessClosureStore implements FreshnessClosureStore {
  private readonly supplementOperations: RedisFreshnessSupplementOperations;

  constructor(private readonly redis: RedisClient) {
    this.supplementOperations = new RedisFreshnessSupplementOperations(redis);
  }

  async get(closureId: string): Promise<FreshnessClosureAggregate | null> {
    return parseClosure(await this.redis.get(FreshnessClosureKeys.detail(closureId)));
  }

  async getActiveByScope(scope: FreshnessClosureScope): Promise<FreshnessClosureAggregate | null> {
    const active = await this.listActiveByScope(scope);
    return active.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async listActiveByScope(scope: FreshnessClosureScope): Promise<FreshnessClosureAggregate[]> {
    const ids = (await this.redis.eval(
      MIGRATE_SCOPE_LUA,
      4,
      FreshnessClosureKeys.activeScope(scope),
      FreshnessClosureKeys.lineages(scope),
      FreshnessClosureKeys.runningLease(scope),
      FreshnessClosureKeys.detail(''),
    )) as string[];
    const closures = await this.readMany(ids);
    const active = closures.filter((closure) => !isTerminal(closure));
    const staleIds = ids.filter((id) => !active.some((closure) => closure.id === id));
    if (staleIds.length > 0) await this.redis.srem(FreshnessClosureKeys.lineages(scope), ...staleIds);
    return active;
  }

  async openOrAdvance(input: OpenOrAdvanceFreshnessClosureInput): Promise<FreshnessClosureAggregate> {
    const candidate = createFreshnessClosure({ id: input.closureId, ...input });
    const created = Number(
      await this.redis.eval(
        OPEN_LINEAGE_LUA,
        4,
        FreshnessClosureKeys.detail(candidate.id),
        FreshnessClosureKeys.lineages(input),
        FreshnessClosureKeys.thread(input.threadId),
        FreshnessClosureKeys.ALL,
        candidate.id,
        JSON.stringify(candidate),
      ),
    );
    if (created === 1) return candidate;
    return this.mutate(candidate.id, (closure) => advanceFreshnessClosure(closure, input));
  }

  async claimAttempt(closureId: string, input: ClaimFreshnessClosureInput): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => claimFreshnessClosureAttempt(closure, input));
  }

  async supersedeAttempt(closureId: string, input: SupersedeFreshnessClosureInput): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => supersedeFreshnessClosureAttempt(closure, input));
  }

  async blockAttempt(closureId: string, input: BlockFreshnessClosureInput): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => blockFreshnessClosureAttempt(closure, input));
  }

  async blockPreflight(
    closureId: string,
    input: { evidenceRefs: string[]; now: number },
  ): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => blockFreshnessClosurePreflight(closure, input));
  }

  async refreshFrontier(
    closureId: string,
    input: RefreshFreshnessClosureFrontierInput,
  ): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => refreshFreshnessClosureFrontier(closure, input));
  }

  async blockRecovery(
    closureId: string,
    input: BlockFreshnessClosureRecoveryInput,
  ): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => blockFreshnessClosureRecovery(closure, input));
  }

  async commit(closureId: string, input: CommitFreshnessClosureInput): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => commitFreshnessClosureAttempt(closure, input));
  }

  async recoverAttempt(
    closureId: string,
    input: { evidenceRef: string; now: number },
  ): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => recoverFreshnessClosureAttempt(closure, input));
  }

  async retry(
    closureId: string,
    input: { actorId: string; evidenceRef: string; now: number },
  ): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => retryFreshnessClosure(closure, input));
  }

  async migrateLegacy(
    closureId: string,
    input: MigrateLegacyFreshnessClosureInput,
  ): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => migrateLegacyFreshnessClosure(closure, input));
  }

  async dispose(
    closureId: string,
    input: {
      kind: 'deferred' | 'superseded' | 'dismissed';
      actorId: string;
      evidenceRef: string;
      now: number;
    },
  ): Promise<FreshnessClosureAggregate> {
    return this.mutate(closureId, (closure) => disposeFreshnessClosure(closure, input));
  }

  async listActiveByThread(threadId: string): Promise<FreshnessClosureAggregate[]> {
    const ids = await this.redis.smembers(FreshnessClosureKeys.thread(threadId));
    const closures = await this.readMany(ids);
    return closures.filter((closure) => !isTerminal(closure));
  }

  async listAllActive(): Promise<FreshnessClosureAggregate[]> {
    const ids = await this.redis.smembers(FreshnessClosureKeys.ALL);
    const closures = await this.readMany(ids);
    return closures.filter((closure) => !isTerminal(closure)).sort((left, right) => left.id.localeCompare(right.id));
  }

  async listRecoverable(): Promise<FreshnessClosureAggregate[]> {
    const ids = await this.redis.smembers(FreshnessClosureKeys.ALL);
    const closures = await this.readMany(ids);
    return closures.filter((closure) => closure.status === 'pending' || closure.status === 'running');
  }

  async listUpdatedBetween(fromInclusive: number, toExclusive: number): Promise<FreshnessClosureAggregate[]> {
    const ids = await this.redis.smembers(FreshnessClosureKeys.ALL);
    const closures = await this.readMany(ids);
    return closures.filter((closure) => closure.updatedAt >= fromInclusive && closure.updatedAt < toExclusive);
  }

  getSupplement(supplementId: string): Promise<FreshnessSupplementAggregate | null> {
    return this.supplementOperations.get(supplementId);
  }

  listSupplementsByLineage(lineageId: string): Promise<FreshnessSupplementAggregate[]> {
    return this.supplementOperations.listByLineage(lineageId);
  }

  listSupplementsByThread(threadId: string): Promise<FreshnessSupplementAggregate[]> {
    return this.supplementOperations.listByThread(threadId);
  }

  listRecoverableSupplements(): Promise<FreshnessSupplementAggregate[]> {
    return this.supplementOperations.listRecoverable();
  }

  offerSupplement(input: FreshnessSupplementOfferInput): Promise<OfferFreshnessSupplementResult> {
    return this.supplementOperations.offer(input);
  }

  claimSupplement(
    supplementId: string,
    input: { invocationId: string; now: number },
  ): Promise<FreshnessSupplementAggregate> {
    return this.supplementOperations.claim(supplementId, input);
  }

  commitSupplement(
    supplementId: string,
    input: { invocationId: string; messageId: string; now: number },
  ): Promise<FreshnessSupplementAggregate> {
    return this.supplementOperations.commit(supplementId, input);
  }

  declineSupplement(
    supplementId: string,
    input: { invocationId: string; now: number },
  ): Promise<FreshnessSupplementAggregate> {
    return this.supplementOperations.decline(supplementId, input);
  }

  failSupplement(
    supplementId: string,
    input: { invocationId?: string; reason: FreshnessSupplementFailureReason; now: number },
  ): Promise<FreshnessSupplementAggregate> {
    return this.supplementOperations.fail(supplementId, input);
  }

  async deleteByThread(threadId: string): Promise<number> {
    const ids = await this.redis.smembers(FreshnessClosureKeys.thread(threadId));
    let deleted = 0;
    for (const id of ids) {
      const closure = await this.get(id);
      if (!closure) continue;
      await this.redis.eval(
        DELETE_LUA,
        6,
        FreshnessClosureKeys.detail(id),
        FreshnessClosureKeys.lineages(closure),
        FreshnessClosureKeys.runningLease(closure),
        FreshnessClosureKeys.activeScope(closure),
        FreshnessClosureKeys.thread(threadId),
        FreshnessClosureKeys.ALL,
        id,
      );
      deleted += 1;
    }
    return deleted + (await this.supplementOperations.deleteByThread(threadId));
  }

  private async mutate(
    closureId: string,
    transition: (closure: FreshnessClosureAggregate) => FreshnessClosureAggregate,
  ): Promise<FreshnessClosureAggregate> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.get(closureId);
      if (!current) throw new Error(`freshness closure not found: ${closureId}`);
      const next = transition(current);
      const result = Number(
        await this.redis.eval(
          CAS_LUA,
          4,
          FreshnessClosureKeys.detail(closureId),
          FreshnessClosureKeys.lineages(current),
          FreshnessClosureKeys.runningLease(current),
          FreshnessClosureKeys.activeScope(current),
          String(current.revision),
          closureId,
          JSON.stringify(next),
          isTerminal(next) ? '1' : '0',
          current.status,
          next.status,
        ),
      );
      if (result === 1) return next;
      if (result === 0) throw new Error(`freshness closure not found: ${closureId}`);
      if (result === -3) throw new Error(`freshness closure scope already has a running lease`);
    }
    throw new Error(`freshness closure CAS exhausted: ${closureId}`);
  }

  private async readMany(ids: string[]): Promise<FreshnessClosureAggregate[]> {
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => FreshnessClosureKeys.detail(id)));
    return raws.map(parseClosure).filter((closure): closure is FreshnessClosureAggregate => closure !== null);
  }
}
