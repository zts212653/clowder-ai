/**
 * F296 B1: persistence port for the context epoch.
 *
 * This is deliberately NOT a second session store. It holds exactly one small
 * record per `user × cat × thread` scope — the current epoch and what runtime it
 * is bound to — and knows nothing about session lifecycle, transcripts, policy or
 * sealing. Session truth stays in `SessionChainStore`; this record only answers
 * "which projection generation is this scope on".
 *
 * The epoch outlives any single session record (a fresh session is precisely what
 * advances it), which is why it cannot live on `SessionRecord`.
 */

/** One scope's epoch truth. Persisted; never TTL'd (recoverable user-facing state). */
export interface ContextEpochRecord {
  readonly scopeKey: string;
  readonly contextEpoch: number;
  readonly contextMode: 'cold' | 'hot';
  /** Runtime session this epoch is bound to, when the carrier gave us one. */
  readonly boundRuntimeSessionId?: string;
  /** Evidence ref of the transition that produced this state. */
  readonly lastTransitionRef: string;
  /**
   * F296 B2a: authoritative compaction event ids already consumed by this scope.
   *
   * A single "last id" was last-one-wins: `A → B → replay A` re-advanced. This
   * bounded FIFO (newest kept) suppresses replays within the window instead.
   *
   * It is NOT lifecycle-wide exact-once: an id evicted past the bound will
   * advance the epoch again. The bound is stated rather than pretended away —
   * calling a 64-entry eviction window "exact-once" would launder a known
   * unsupported tail into a deterministic contract, which is the exact class of
   * false certainty F296 exists to remove.
   */
  readonly consumedCompactionEventIds?: readonly string[];
  /** F296: epoch whose cold has already been consumed by a projection. */
  readonly coldConsumedAtEpoch?: number;
  /** Optimistic-concurrency version. Every successful write increments it. */
  readonly version: number;
  readonly updatedAt: number;
}

export const CONSUMED_COMPACTION_EVENT_LIMIT = 64;

export interface IContextEpochStore {
  get(scopeKey: string): ContextEpochRecord | null | Promise<ContextEpochRecord | null>;
  /**
   * Write only if the stored version still matches what the caller read.
   *
   * There are genuinely two writers on one scope: the invocation path and the
   * PreCompact hook route (which never takes the invocation's process-local
   * policy mutex). A plain `put` would let both land on the same epoch, and the
   * B2 ledger key would then collide across two different generations.
   *
   * @param expectedVersion version observed by the caller; `0` means "expected absent"
   * @returns true when the write landed, false on conflict (caller must re-read)
   */
  compareAndPut(record: ContextEpochRecord, expectedVersion: number): boolean | Promise<boolean>;
}

/** In-memory implementation (tests, single-process fallback). */
export class InMemoryContextEpochStore implements IContextEpochStore {
  private readonly records = new Map<string, ContextEpochRecord>();
  private readonly generationRetiredObservers = new Set<(scopeKey: string, retiredEpoch: number) => void>();

  /**
   * Single-process equivalent of the Redis CAS retirement side effect.
   * Registration does not create another epoch authority: observers receive an
   * exact generation only after this store has won the version comparison.
   */
  onGenerationRetired(observer: (scopeKey: string, retiredEpoch: number) => void): () => void {
    this.generationRetiredObservers.add(observer);
    return () => this.generationRetiredObservers.delete(observer);
  }

  get(scopeKey: string): ContextEpochRecord | null {
    return this.records.get(scopeKey) ?? null;
  }

  compareAndPut(record: ContextEpochRecord, expectedVersion: number): boolean {
    const current = this.records.get(record.scopeKey);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) return false;
    if (current && record.contextEpoch === current.contextEpoch + 1) {
      for (const observer of this.generationRetiredObservers) {
        observer(record.scopeKey, current.contextEpoch);
      }
    }
    this.records.set(record.scopeKey, { ...record, version: currentVersion + 1 });
    return true;
  }
}
