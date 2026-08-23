/**
 * F296 B3a gates 3 + 4: persistence port for the presentation ledger.
 *
 * The port exposes three *atomic* operations rather than `has`/`put`, because
 * the honesty of the state machine lives entirely in their atomicity. A
 * read-then-write pair at this boundary would let two prompts both observe
 * "not delivered" and both present the same projection — the bug B2b had.
 *
 * The record is content-free: coordinates, a reservation token, an expiry and a
 * delivery timestamp. Never payload, never canonical state, never an
 * Opportunity's business disposition.
 */

import { InMemoryContextEpochStore } from './ContextEpochStore.js';

/** Where an entry lives: the generation container, and the entry within it. */
export interface PresentationLedgerAddress {
  /** `scopeKey + contextEpoch`, encoded — one container per generation. */
  readonly scopeKey: string;
  /** Raw ContextEpochStore scope. The epoch owner remains the only truth source. */
  readonly contextScopeKey: string;
  /** Epoch this write was rendered against; reserve/commit are fenced by it. */
  readonly writeEpoch: number;
  /** `subjectKey + revision + presentation`, encoded. */
  readonly entryField: string;
}

export type ReserveResult =
  | 'reserved'
  | 'already_delivered_this_epoch'
  | 'reserved_by_concurrent_prompt'
  | 'context_epoch_retired';

export type CommitResult = 'committed' | 'reservation_superseded' | 'context_epoch_retired';

export interface ReserveInput {
  readonly token: string;
  /** Wall clock used to judge whether an existing reservation has lapsed. */
  readonly nowMs: number;
  /** After this instant the reservation is reclaimable — this is crash recovery. */
  readonly expiresAtMs: number;
  readonly promptGenerationId: string;
}

export interface CommitInput {
  readonly token: string;
  readonly deliveredAtMs: number;
  readonly promptGenerationId: string;
  readonly providerAdapterId: string;
}

export interface IPresentationLedgerStore {
  /**
   * Atomically take the entry if it is neither delivered nor actively reserved.
   *
   * An *expired* reservation counts as free: the process holding it is presumed
   * dead, and wedging the projection forever would suppress content the cat
   * never saw.
   */
  reserve(address: PresentationLedgerAddress, input: ReserveInput): Promise<ReserveResult>;

  /**
   * Atomically turn our own live reservation into a delivery.
   *
   * Idempotent for the same token, because at-least-once transports retry. Any
   * other token means we were superseded and must not overwrite the holder.
   *
   * A lapsed expiry is deliberately NOT rejected here. Expiry exists so that
   * *others* may reclaim an abandoned reservation; if nobody did, the entry is
   * still ours and the provider genuinely received the projection. Refusing that
   * commit would discard a true fact and force a duplicate presentation. The only
   * case that must lose is one where someone else took over — and that is already
   * caught by the token check, whose result is `reservation_superseded`.
   */
  commit(address: PresentationLedgerAddress, input: CommitInput): Promise<CommitResult>;

  /**
   * Drop our own pending reservation (render failure, budget trim, launch
   * failure). A stale token is a no-op: a dead prompt must not release the
   * reservation of the live one that replaced it.
   *
   * @returns true when this call actually released a reservation
   */
  release(address: PresentationLedgerAddress, token: string): Promise<boolean>;
}

type EntryState =
  | {
      readonly state: 'pending';
      readonly token: string;
      readonly expiresAtMs: number;
      readonly promptGenerationId: string;
    }
  | {
      readonly state: 'delivered';
      readonly token: string;
      readonly deliveredAtMs: number;
      readonly promptGenerationId: string;
      readonly providerAdapterId: string;
    };

/**
 * Single-process implementation for unit tests.
 *
 * Deliberately NOT a production default: AC-B6 is a promise about a scope, and a
 * process-local Map cannot keep it across a restart or a second API instance.
 * Production wiring uses the Redis store.
 */
export class InMemoryPresentationLedgerStore implements IPresentationLedgerStore {
  private readonly containers = new Map<string, Map<string, EntryState>>();
  private readonly generationCoordinates = new Map<
    string,
    { readonly contextScopeKey: string; readonly writeEpoch: number }
  >();

  constructor(private readonly contextEpochStore?: InMemoryContextEpochStore) {
    contextEpochStore?.onGenerationRetired((contextScopeKey, retiredEpoch) => {
      for (const [encodedScopeKey, coordinate] of this.generationCoordinates) {
        if (coordinate.contextScopeKey !== contextScopeKey || coordinate.writeEpoch !== retiredEpoch) continue;
        this.containers.delete(encodedScopeKey);
        this.generationCoordinates.delete(encodedScopeKey);
      }
    });
  }

  private isCurrent(address: PresentationLedgerAddress): boolean {
    if (!this.contextEpochStore) return true;
    return this.contextEpochStore.get(address.contextScopeKey)?.contextEpoch === address.writeEpoch;
  }

  private entry(address: PresentationLedgerAddress): EntryState | undefined {
    return this.containers.get(address.scopeKey)?.get(address.entryField);
  }

  private write(address: PresentationLedgerAddress, entry: EntryState): void {
    let container = this.containers.get(address.scopeKey);
    if (!container) {
      container = new Map<string, EntryState>();
      this.containers.set(address.scopeKey, container);
    }
    this.generationCoordinates.set(address.scopeKey, {
      contextScopeKey: address.contextScopeKey,
      writeEpoch: address.writeEpoch,
    });
    container.set(address.entryField, entry);
  }

  async reserve(address: PresentationLedgerAddress, input: ReserveInput): Promise<ReserveResult> {
    if (!this.isCurrent(address)) return 'context_epoch_retired';
    const existing = this.entry(address);
    if (existing?.state === 'delivered') return 'already_delivered_this_epoch';
    if (existing?.state === 'pending' && existing.expiresAtMs > input.nowMs) {
      return 'reserved_by_concurrent_prompt';
    }
    this.write(address, {
      state: 'pending',
      token: input.token,
      expiresAtMs: input.expiresAtMs,
      promptGenerationId: input.promptGenerationId,
    });
    return 'reserved';
  }

  async commit(address: PresentationLedgerAddress, input: CommitInput): Promise<CommitResult> {
    if (!this.isCurrent(address)) return 'context_epoch_retired';
    const existing = this.entry(address);
    if (!existing) return 'reservation_superseded';
    if (existing.token !== input.token) return 'reservation_superseded';
    if (existing.state === 'delivered') return 'committed'; // idempotent retry
    this.write(address, {
      state: 'delivered',
      token: input.token,
      deliveredAtMs: input.deliveredAtMs,
      promptGenerationId: input.promptGenerationId,
      providerAdapterId: input.providerAdapterId,
    });
    return 'committed';
  }

  async release(address: PresentationLedgerAddress, token: string): Promise<boolean> {
    const existing = this.entry(address);
    if (!existing || existing.state !== 'pending' || existing.token !== token) return false;
    this.containers.get(address.scopeKey)?.delete(address.entryField);
    return true;
  }

  /** Test-only introspection; asserts the ledger stays content-free. */
  snapshot(): Record<string, Record<string, EntryState>> {
    return Object.fromEntries(
      [...this.containers].map(([scope, entries]) => [scope, Object.fromEntries(entries)] as const),
    );
  }
}
