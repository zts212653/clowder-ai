import type {
  FreshnessClosureAggregate,
  FreshnessSupplementAggregate,
  FreshnessSupplementFailureReason,
} from '@cat-cafe/shared';
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
import type {
  BlockFreshnessClosureInput,
  BlockFreshnessClosureRecoveryInput,
  ClaimFreshnessClosureInput,
  CommitFreshnessClosureInput,
  FreshnessClosureScope,
  FreshnessClosureStore,
  MigrateLegacyFreshnessClosureInput,
  OfferFreshnessSupplementResult,
  OpenOrAdvanceFreshnessClosureInput,
  RefreshFreshnessClosureFrontierInput,
  SupersedeFreshnessClosureInput,
} from './freshness-closure-store-types.js';
import type { FreshnessSupplementOfferInput } from './glass-box/FreshnessSupplementStateMachine.js';
import { InMemoryFreshnessSupplementOperations } from './glass-box/in-memory-freshness-supplement-operations.js';

export type {
  BlockFreshnessClosureInput,
  BlockFreshnessClosureRecoveryInput,
  ClaimFreshnessClosureInput,
  CommitFreshnessClosureInput,
  FreshnessClosureScope,
  FreshnessClosureStore,
  MigrateLegacyFreshnessClosureInput,
  OfferFreshnessSupplementResult,
  OpenOrAdvanceFreshnessClosureInput,
  RefreshFreshnessClosureFrontierInput,
  SupersedeFreshnessClosureInput,
} from './freshness-closure-store-types.js';

function scopeKey(scope: FreshnessClosureScope): string {
  return JSON.stringify([scope.userId, scope.threadId, scope.catId]);
}

function clone(closure: FreshnessClosureAggregate): FreshnessClosureAggregate {
  return structuredClone(closure);
}

/** Test/local contract implementation. Production wiring must use RedisFreshnessClosureStore. */
export class InMemoryFreshnessClosureStore implements FreshnessClosureStore {
  private readonly closures = new Map<string, FreshnessClosureAggregate>();
  private readonly activeByScope = new Map<string, Set<string>>();
  private readonly runningByScope = new Map<string, string>();
  private readonly supplementOperations = new InMemoryFreshnessSupplementOperations();

  async get(closureId: string): Promise<FreshnessClosureAggregate | null> {
    const closure = this.closures.get(closureId);
    return closure ? clone(closure) : null;
  }

  async getActiveByScope(scope: FreshnessClosureScope): Promise<FreshnessClosureAggregate | null> {
    const active = await this.listActiveByScope(scope);
    return active.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async listActiveByScope(scope: FreshnessClosureScope): Promise<FreshnessClosureAggregate[]> {
    const ids = this.activeByScope.get(scopeKey(scope));
    if (!ids) return [];
    return [...ids]
      .map((id) => this.closures.get(id))
      .filter((closure): closure is FreshnessClosureAggregate => closure !== undefined)
      .filter((closure) => closure.status !== 'committed' && closure.status !== 'disposed')
      .map(clone);
  }

  async openOrAdvance(input: OpenOrAdvanceFreshnessClosureInput): Promise<FreshnessClosureAggregate> {
    const key = scopeKey(input);
    const existing = this.closures.get(input.closureId);
    if (existing) {
      const advanced = advanceFreshnessClosure(existing, input);
      this.closures.set(existing.id, advanced);
      return clone(advanced);
    }
    const created = createFreshnessClosure({ id: input.closureId, ...input });
    this.closures.set(created.id, created);
    const active = this.activeByScope.get(key) ?? new Set<string>();
    active.add(created.id);
    this.activeByScope.set(key, active);
    return clone(created);
  }

  async claimAttempt(closureId: string, input: ClaimFreshnessClosureInput): Promise<FreshnessClosureAggregate> {
    const current = this.require(closureId);
    const key = scopeKey(current);
    const leaseOwner = this.runningByScope.get(key);
    if (leaseOwner && leaseOwner !== closureId) {
      throw new Error(`freshness closure scope already has a running lease: ${leaseOwner}`);
    }
    const next = claimFreshnessClosureAttempt(current, input);
    this.closures.set(closureId, next);
    if (next.status === 'running') this.runningByScope.set(key, closureId);
    return clone(next);
  }

  async supersedeAttempt(closureId: string, input: SupersedeFreshnessClosureInput): Promise<FreshnessClosureAggregate> {
    return this.update(closureId, (closure) => supersedeFreshnessClosureAttempt(closure, input));
  }

  async blockAttempt(closureId: string, input: BlockFreshnessClosureInput): Promise<FreshnessClosureAggregate> {
    return this.update(closureId, (closure) => blockFreshnessClosureAttempt(closure, input));
  }

  async blockPreflight(
    closureId: string,
    input: { evidenceRefs: string[]; now: number },
  ): Promise<FreshnessClosureAggregate> {
    return this.update(closureId, (closure) => blockFreshnessClosurePreflight(closure, input));
  }

  async refreshFrontier(
    closureId: string,
    input: RefreshFreshnessClosureFrontierInput,
  ): Promise<FreshnessClosureAggregate> {
    return this.update(closureId, (closure) => refreshFreshnessClosureFrontier(closure, input));
  }

  async blockRecovery(
    closureId: string,
    input: BlockFreshnessClosureRecoveryInput,
  ): Promise<FreshnessClosureAggregate> {
    return this.update(closureId, (closure) => blockFreshnessClosureRecovery(closure, input));
  }

  async commit(closureId: string, input: CommitFreshnessClosureInput): Promise<FreshnessClosureAggregate> {
    return this.update(closureId, (closure) => commitFreshnessClosureAttempt(closure, input), true);
  }

  async recoverAttempt(
    closureId: string,
    input: { evidenceRef: string; now: number },
  ): Promise<FreshnessClosureAggregate> {
    return this.update(closureId, (closure) => recoverFreshnessClosureAttempt(closure, input));
  }

  async retry(
    closureId: string,
    input: { actorId: string; evidenceRef: string; now: number },
  ): Promise<FreshnessClosureAggregate> {
    return this.update(closureId, (closure) => retryFreshnessClosure(closure, input));
  }

  async migrateLegacy(
    closureId: string,
    input: MigrateLegacyFreshnessClosureInput,
  ): Promise<FreshnessClosureAggregate> {
    return this.update(closureId, (closure) => migrateLegacyFreshnessClosure(closure, input), true);
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
    return this.update(closureId, (closure) => disposeFreshnessClosure(closure, input), true);
  }

  async listActiveByThread(threadId: string): Promise<FreshnessClosureAggregate[]> {
    return [...this.activeByScope.values()]
      .flatMap((ids) => [...ids])
      .map((id) => this.closures.get(id))
      .filter((closure): closure is FreshnessClosureAggregate => closure?.threadId === threadId)
      .map(clone);
  }

  async listAllActive(): Promise<FreshnessClosureAggregate[]> {
    return [...this.closures.values()]
      .filter((closure) => closure.status !== 'committed' && closure.status !== 'disposed')
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(clone);
  }

  async listRecoverable(): Promise<FreshnessClosureAggregate[]> {
    return [...this.closures.values()]
      .filter((closure) => closure.status === 'pending' || closure.status === 'running')
      .map(clone);
  }

  async listUpdatedBetween(fromInclusive: number, toExclusive: number): Promise<FreshnessClosureAggregate[]> {
    return [...this.closures.values()]
      .filter((closure) => closure.updatedAt >= fromInclusive && closure.updatedAt < toExclusive)
      .map(clone);
  }

  async getSupplement(supplementId: string): Promise<FreshnessSupplementAggregate | null> {
    return this.supplementOperations.get(supplementId);
  }

  async listSupplementsByLineage(lineageId: string): Promise<FreshnessSupplementAggregate[]> {
    return this.supplementOperations.listByLineage(lineageId);
  }

  async listSupplementsByThread(threadId: string): Promise<FreshnessSupplementAggregate[]> {
    return this.supplementOperations.listByThread(threadId);
  }

  async listRecoverableSupplements(): Promise<FreshnessSupplementAggregate[]> {
    return this.supplementOperations.listRecoverable();
  }

  async offerSupplement(input: FreshnessSupplementOfferInput): Promise<OfferFreshnessSupplementResult> {
    return this.supplementOperations.offer(input);
  }

  async claimSupplement(
    supplementId: string,
    input: { invocationId: string; now: number },
  ): Promise<FreshnessSupplementAggregate> {
    return this.supplementOperations.claim(supplementId, input);
  }

  async commitSupplement(
    supplementId: string,
    input: { invocationId: string; messageId: string; now: number },
  ): Promise<FreshnessSupplementAggregate> {
    return this.supplementOperations.commit(supplementId, input);
  }

  async declineSupplement(
    supplementId: string,
    input: { invocationId: string; now: number },
  ): Promise<FreshnessSupplementAggregate> {
    return this.supplementOperations.decline(supplementId, input);
  }

  async failSupplement(
    supplementId: string,
    input: { invocationId?: string; reason: FreshnessSupplementFailureReason; now: number },
  ): Promise<FreshnessSupplementAggregate> {
    return this.supplementOperations.fail(supplementId, input);
  }

  async deleteByThread(threadId: string): Promise<number> {
    const ids = [...this.closures.values()]
      .filter((closure) => closure.threadId === threadId)
      .map((closure) => closure.id);
    for (const id of ids) {
      const closure = this.closures.get(id);
      if (!closure) continue;
      this.removeActive(closure);
      if (this.runningByScope.get(scopeKey(closure)) === id) this.runningByScope.delete(scopeKey(closure));
      this.closures.delete(id);
    }
    return ids.length + this.supplementOperations.deleteByThread(threadId);
  }

  private require(closureId: string): FreshnessClosureAggregate {
    const closure = this.closures.get(closureId);
    if (!closure) throw new Error(`freshness closure not found: ${closureId}`);
    return closure;
  }

  private async update(
    closureId: string,
    transition: (closure: FreshnessClosureAggregate) => FreshnessClosureAggregate,
    terminal = false,
  ): Promise<FreshnessClosureAggregate> {
    const current = this.require(closureId);
    const next = transition(current);
    this.closures.set(closureId, next);
    const key = scopeKey(current);
    if (current.status === 'running' && next.status !== 'running' && this.runningByScope.get(key) === closureId) {
      this.runningByScope.delete(key);
    }
    if (terminal) this.removeActive(current);
    return clone(next);
  }

  private removeActive(closure: FreshnessClosureAggregate): void {
    const key = scopeKey(closure);
    const active = this.activeByScope.get(key);
    if (!active) return;
    active.delete(closure.id);
    if (active.size === 0) this.activeByScope.delete(key);
  }
}
