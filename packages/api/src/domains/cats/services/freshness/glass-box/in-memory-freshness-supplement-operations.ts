import type { FreshnessSupplementAggregate, FreshnessSupplementFailureReason } from '@cat-cafe/shared';
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

function clone(supplement: FreshnessSupplementAggregate): FreshnessSupplementAggregate {
  return structuredClone(supplement);
}

export class InMemoryFreshnessSupplementOperations {
  private readonly supplements = new Map<string, FreshnessSupplementAggregate>();
  private readonly idsByLineage = new Map<string, Set<string>>();
  private readonly idsByThread = new Map<string, Set<string>>();
  private readonly runningByLineage = new Map<string, string>();

  get(supplementId: string): FreshnessSupplementAggregate | null {
    const supplement = this.supplements.get(supplementId);
    return supplement ? clone(supplement) : null;
  }

  listByLineage(lineageId: string): FreshnessSupplementAggregate[] {
    return this.readIds(this.idsByLineage.get(lineageId)).sort((left, right) => left.seq - right.seq);
  }

  listByThread(threadId: string): FreshnessSupplementAggregate[] {
    return this.readIds(this.idsByThread.get(threadId)).sort(
      (left, right) => left.createdAt - right.createdAt || left.seq - right.seq,
    );
  }

  listRecoverable(): FreshnessSupplementAggregate[] {
    return [...this.supplements.values()]
      .filter((supplement) => supplement.status === 'pending' || supplement.status === 'running')
      .sort((left, right) => left.createdAt - right.createdAt || left.seq - right.seq)
      .map(clone);
  }

  offer(input: FreshnessSupplementOfferInput): OfferFreshnessSupplementResult {
    const supplements = this.listByLineage(input.lineageId);
    const pending = supplements.find((supplement) => supplement.status === 'pending');
    if (pending) {
      const advanced = advanceFreshnessSupplement(this.require(pending.id), input);
      this.supplements.set(advanced.id, advanced);
      return { kind: 'offered', supplement: clone(advanced) };
    }

    // Every durable attempt consumes a sequence, including failed/declined attempts. Counting
    // terminal attempts keeps retries bounded and prevents an unhealthy provider from looping.
    const nextSeq = supplements.length + 1;
    if (nextSeq <= MAX_AUTOMATIC_SUPPLEMENTS_PER_LINEAGE) {
      const created = createFreshnessSupplement({ ...input, seq: nextSeq as 1 | 2 });
      this.supplements.set(created.id, created);
      this.addIndex(this.idsByLineage, created.lineageId, created.id);
      this.addIndex(this.idsByThread, created.threadId, created.id);
      return { kind: 'offered', supplement: clone(created) };
    }

    const finalSupplement = supplements.find((supplement) => supplement.seq === MAX_AUTOMATIC_SUPPLEMENTS_PER_LINEAGE);
    if (!finalSupplement) throw new Error('freshness supplement lineage sequence gap');
    const exhausted = markFreshnessSupplementBudgetExhausted(this.require(finalSupplement.id), {
      unseenMessageIds: input.requiredMessageIds,
      observedAt: input.now,
    });
    this.supplements.set(exhausted.id, exhausted);
    return { kind: 'budget_exhausted', supplement: clone(exhausted) };
  }

  claim(supplementId: string, input: { invocationId: string; now: number }): FreshnessSupplementAggregate {
    const current = this.require(supplementId);
    const leaseOwner = this.runningByLineage.get(current.lineageId);
    if (leaseOwner && leaseOwner !== supplementId) {
      throw new Error(`freshness lineage already has a running supplement: ${leaseOwner}`);
    }
    const next = claimFreshnessSupplement(current, input);
    this.supplements.set(next.id, next);
    this.runningByLineage.set(next.lineageId, next.id);
    return clone(next);
  }

  commit(
    supplementId: string,
    input: { invocationId: string; messageId: string; now: number },
  ): FreshnessSupplementAggregate {
    return this.update(supplementId, (current) => commitFreshnessSupplement(current, input));
  }

  decline(supplementId: string, input: { invocationId: string; now: number }): FreshnessSupplementAggregate {
    return this.update(supplementId, (current) => declineFreshnessSupplement(current, input));
  }

  fail(
    supplementId: string,
    input: { invocationId?: string; reason: FreshnessSupplementFailureReason; now: number },
  ): FreshnessSupplementAggregate {
    return this.update(supplementId, (current) => failFreshnessSupplement(current, input));
  }

  deleteByThread(threadId: string): number {
    const ids = [...(this.idsByThread.get(threadId) ?? new Set<string>())];
    for (const id of ids) {
      const supplement = this.supplements.get(id);
      if (!supplement) continue;
      this.supplements.delete(id);
      this.idsByLineage.get(supplement.lineageId)?.delete(id);
      if (this.runningByLineage.get(supplement.lineageId) === id) this.runningByLineage.delete(supplement.lineageId);
    }
    this.idsByThread.delete(threadId);
    return ids.length;
  }

  private require(id: string): FreshnessSupplementAggregate {
    const supplement = this.supplements.get(id);
    if (!supplement) throw new Error(`freshness supplement not found: ${id}`);
    return supplement;
  }

  private update(
    id: string,
    transition: (supplement: FreshnessSupplementAggregate) => FreshnessSupplementAggregate,
  ): FreshnessSupplementAggregate {
    const current = this.require(id);
    const next = transition(current);
    this.supplements.set(id, next);
    if (
      current.status === 'running' &&
      next.status !== 'running' &&
      this.runningByLineage.get(current.lineageId) === id
    ) {
      this.runningByLineage.delete(current.lineageId);
    }
    return clone(next);
  }

  private readIds(ids: Set<string> | undefined): FreshnessSupplementAggregate[] {
    return [...(ids ?? new Set<string>())]
      .map((id) => this.supplements.get(id))
      .filter((item): item is FreshnessSupplementAggregate => item !== undefined)
      .map(clone);
  }

  private addIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    const ids = index.get(key) ?? new Set<string>();
    ids.add(id);
    index.set(key, ids);
  }
}
