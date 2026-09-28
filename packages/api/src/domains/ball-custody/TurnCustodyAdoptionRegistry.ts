import type { TurnCustodyWakeProvenance } from './TurnCustodyProjectionService.js';

type AdoptionCommit = () => void;
type AdoptionHandler = (wakes: readonly TurnCustodyWakeProvenance[]) => Promise<void | AdoptionCommit>;
export type AdoptedManagedHold = Extract<TurnCustodyWakeProvenance, { kind: 'structured'; protocol: 'hold' }>;

export interface TurnCustodyAdoptionReservation {
  /** Publish the already-prepared route-local adoption. This boundary must be synchronous and infallible. */
  commit(): void;
  /** Release the route owner without publishing an adoption when durable exposure did not commit. */
  abort(): void;
}

interface AdoptionEntry {
  readonly handler: AdoptionHandler;
  accepting: boolean;
  tail: Promise<void>;
  readonly wakes: Map<string, AdoptedManagedHold>;
}

/**
 * Process-local bridge from an invocation-authenticated tool read back to the
 * route generator that owns the same child. Queue custody remains durable; the
 * bridge only ensures the stop-gate baseline is opened before the tool returns
 * the newly exposed body to the provider.
 */
export class TurnCustodyAdoptionRegistry {
  private readonly handlers = new Map<string, AdoptionEntry>();

  register(invocationId: string, handler: AdoptionHandler): () => Promise<void> {
    if (!invocationId || this.handlers.has(invocationId)) {
      throw new Error(`turn custody adoption handler already registered for ${invocationId || '<empty>'}`);
    }
    const entry: AdoptionEntry = { handler, accepting: true, tail: Promise.resolve(), wakes: new Map() };
    this.handlers.set(invocationId, entry);
    return async () => {
      if (!entry.accepting) {
        await entry.tail;
        return;
      }
      // Refuse new reservations immediately, but keep discovery alive until every
      // already-admitted transaction either commits or aborts.
      entry.accepting = false;
      await entry.tail;
      if (this.handlers.get(invocationId) === entry) this.handlers.delete(invocationId);
    };
  }

  /**
   * Prepare every fallible route-local adoption before append-only Queue exposure
   * is written. The returned commit holds the registry owner through route teardown,
   * so a terminal race cannot turn a successful exposure into a later 409.
   */
  async prepare(
    invocationId: string,
    wakes: readonly TurnCustodyWakeProvenance[],
  ): Promise<TurnCustodyAdoptionReservation | null> {
    if (wakes.length === 0) return { commit() {}, abort() {} };
    const entry = this.handlers.get(invocationId);
    if (!entry?.accepting) return null;

    const predecessor = entry.tail.catch(() => undefined);
    let releaseExclusive: () => void = () => undefined;
    const exclusive = new Promise<void>((resolve) => {
      releaseExclusive = resolve;
    });
    entry.tail = predecessor.then(() => exclusive);
    await predecessor;

    if (this.handlers.get(invocationId) !== entry) {
      releaseExclusive();
      return null;
    }

    let publish: void | AdoptionCommit;
    try {
      publish = await entry.handler(wakes);
    } catch (error) {
      releaseExclusive();
      throw error;
    }

    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      releaseExclusive();
      return true;
    };
    return {
      commit: () => {
        if (settled) return;
        try {
          // Existing handlers adopted eagerly and therefore return void (some
          // JavaScript callers incidentally return Array#push's number). Only
          // the new prepared form supplies a deferred publication closure.
          if (typeof publish === 'function') publish();
          for (const wake of wakes) {
            if (wake.kind === 'structured' && wake.protocol === 'hold') {
              entry.wakes.set(wake.sourceMessageId, { ...wake });
            }
          }
        } finally {
          settle();
        }
      },
      abort: () => {
        settle();
      },
    };
  }

  async adopt(invocationId: string, wakes: readonly TurnCustodyWakeProvenance[]): Promise<boolean> {
    const reservation = await this.prepare(invocationId, wakes);
    if (!reservation) return false;
    reservation.commit();
    return true;
  }

  /** Discovery only: the disposition owner must recheck durable identity and exposure. */
  snapshot(invocationId: string): readonly AdoptedManagedHold[] {
    const entry = this.handlers.get(invocationId);
    return entry ? [...entry.wakes.values()].map((wake) => ({ ...wake })) : [];
  }

  resetForTest(): void {
    for (const entry of this.handlers.values()) entry.accepting = false;
    this.handlers.clear();
  }
}

export const turnCustodyAdoptionRegistry = new TurnCustodyAdoptionRegistry();
