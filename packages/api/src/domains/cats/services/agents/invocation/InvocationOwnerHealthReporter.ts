import type { IInvocationRecordStore } from '../../stores/ports/InvocationRecordStore.js';
import {
  type InvocationOwnerHealthFacts,
  type InvocationOwnerHealthInput,
  type InvocationOwnerHealthReceipt,
  observeInvocationOwnerHealth,
} from '../../stores/ports/invocation-owner-health.js';

/** Diagnostic publication only. Durable observation facts/budgets remain in the original InvocationRecord owner. */
export class InvocationOwnerHealthReporter {
  private readonly local = new Map<string, InvocationOwnerHealthFacts>();
  private readonly seen = new Set<string>();
  constructor(
    private readonly store: Partial<Pick<IInvocationRecordStore, 'observeOwnerRecovery'>>,
    private readonly log: { warn(obj: unknown, message?: string): void },
  ) {}
  startRound(): void {
    this.seen.clear();
  }
  endRound(): void {
    for (const key of this.local.keys()) if (!this.seen.has(key)) this.local.delete(key);
  }
  private observeLocal(key: string, input: InvocationOwnerHealthInput): InvocationOwnerHealthReceipt {
    this.seen.add(key);
    let facts = this.local.get(key);
    if (!facts) {
      facts = { scope: key, failures: 0 };
      this.local.set(key, facts);
    }
    return observeInvocationOwnerHealth(facts, input);
  }
  async observe(id: string, input: InvocationOwnerHealthInput): Promise<InvocationOwnerHealthReceipt> {
    // Missing records/read-only diagnostic adapters own no durable facts. Their process-local leases
    // may only deduplicate local logs, never certify execution or mutate responsibility.
    if (this.store.observeOwnerRecovery) {
      try {
        const receipt = await this.store.observeOwnerRecovery(id, input);
        if (receipt) return receipt;
      } catch (err) {
        if (
          this.observeLocal(`storage:${id}`, {
            signature: 'observation_store_unavailable',
            silence: false,
            failed: false,
          }).changed
        )
          this.log.warn(
            {
              event: 'invocation_owner_observation_failed',
              executionId: id,
              err: err instanceof Error ? err.message : String(err),
            },
            '[F118] owner observation could not be persisted',
          );
      }
    }
    return this.observeLocal(id, input);
  }
  warnLocalUnknown(fields: Record<string, unknown>): void {
    const key = JSON.stringify([fields.threadId, fields.catId, fields.reason]);
    if (this.observeLocal(key, { signature: key, silence: false, failed: false }).changed)
      this.log.warn(
        { event: 'invocation_owner_reaper_deferred_unknown', ...fields },
        '[F118] stale owner retained because independent liveness is unknown',
      );
  }
}
