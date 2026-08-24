/**
 * F296 B2b/B3a: the presentation ledger.
 *
 * It answers exactly one question: **has this projection already reached the
 * model in this context generation?** It is not a second truth store — it holds
 * content-free keys and a delivery timestamp, never the payload, never canonical
 * state, never an Opportunity's business disposition.
 *
 * Two rules do most of the work:
 *
 *  1. **Only a provider receipt consumes dedupe.** Render failure, invoke-start
 *     failure and cold rebuild must not mark something as delivered — otherwise
 *     a projection the cat never saw would be suppressed forever.
 *  2. **A new epoch is not replay authorization.** The key includes the epoch, so
 *     a new generation naturally has no entries; but that only means "not yet
 *     delivered *this* generation". Whether the object is still valid is the
 *     producer's revalidation, not the ledger's silence.
 *
 * ## B3a: why admission is a reservation, not a flag
 *
 * B2b exposed `admit()` (a read) and `recordDelivered()` (a write) with a gap
 * between them. Two prompts could both pass `admit()` and both present the same
 * projection. The obvious patch — take the entry atomically at admission time —
 * is worse: a render failure or a launch failure would then permanently suppress
 * content the cat never saw.
 *
 * So admission takes a *reservation*: a token with an expiry that must be either
 * committed with a provider receipt, released on failure, or left to lapse if the
 * process dies. See {@link PRESENTATION_DELIVERY_GUARANTEE} for what that does
 * and does not buy.
 */

import { randomUUID } from 'node:crypto';
import type { IPresentationLedgerStore, PresentationLedgerAddress } from '../stores/ports/PresentationLedgerStore.js';
import type { ContextPresentation } from './context-presentation.js';
import { type DeliveryReceipt, isProviderMintedReceipt } from './delivery-receipt.js';
import { presentationLedgerEntryField, presentationLedgerScopeKey } from './ledger-key.js';

export type { IPresentationLedgerStore } from '../stores/ports/PresentationLedgerStore.js';
export { InMemoryPresentationLedgerStore } from '../stores/ports/PresentationLedgerStore.js';
export {
  decodePresentationLedgerKey,
  type PresentationLedgerKey,
  presentationLedgerKey,
} from './ledger-key.js';

/**
 * What this ledger actually guarantees, named so nobody has to infer it.
 *
 * Within one epoch a projection is presented at most once per *successful*
 * delivery. There remains a real window: if the provider accepts the prompt and
 * the process dies before `commit`, the reservation lapses and the projection is
 * presented again. That redelivery is a deliberate choice — re-showing something
 * is recoverable, suppressing something the cat never saw is not.
 *
 * This is NOT exactly-once and nothing downstream may describe it as such.
 * Genuine exactly-once needs the provider to accept an idempotency token we
 * control end-to-end; Wave 1 does not buy that.
 */
export const PRESENTATION_DELIVERY_GUARANTEE = 'at_most_once_per_epoch_with_crash_redelivery' as const;

/**
 * How long a reservation is honoured before another prompt may reclaim it.
 *
 * Sized above a realistic render + provider-launch round trip, and well below
 * "the cat is still waiting": too short double-presents under load, too long
 * wedges a projection behind a dead process.
 */
export const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;

export interface PresentationScope {
  readonly scopeKey: string;
  readonly contextEpoch: number;
}

export interface PresentationReservation {
  readonly address: PresentationLedgerAddress;
  readonly token: string;
  readonly expiresAtMs: number;
  readonly promptGenerationId: string;
}

export type ReserveOutcome =
  | { readonly admitted: true; readonly reservation: PresentationReservation }
  | {
      readonly admitted: false;
      readonly reason:
        | 'omitted_by_mapper'
        | 'already_delivered_this_epoch'
        | 'reserved_by_concurrent_prompt'
        | 'context_epoch_retired';
      readonly address: PresentationLedgerAddress;
    };

export type CommitOutcome =
  | { readonly committed: true }
  | {
      readonly committed: false;
      readonly reason: 'generation_mismatch' | 'reservation_superseded' | 'context_epoch_retired';
    };

export interface PresentationLedgerOptions {
  readonly now?: () => number;
  readonly reservationTtlMs?: number;
  readonly newToken?: () => string;
}

export class PresentationLedger {
  private readonly now: () => number;
  private readonly reservationTtlMs: number;
  private readonly newToken: () => string;

  constructor(
    private readonly store: IPresentationLedgerStore,
    options: PresentationLedgerOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.reservationTtlMs = options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    this.newToken = options.newToken ?? (() => randomUUID());
  }

  private addressOf(presentation: ContextPresentation, scope: PresentationScope): PresentationLedgerAddress {
    return {
      scopeKey: presentationLedgerScopeKey(scope),
      contextScopeKey: scope.scopeKey,
      writeEpoch: scope.contextEpoch,
      entryField: presentationLedgerEntryField({
        subjectKey: presentation.subjectKey,
        asOf: presentation.asOf,
        presentation: presentation.presentation,
      }),
    };
  }

  /**
   * Try to take this projection for the current prompt.
   *
   * Note what this does NOT do: it does not mark anything delivered. Everything
   * between here and the provider (render, budget trim, launch) can still drop
   * the projection, and each of those paths must {@link release} rather than
   * leave the cat owed content.
   */
  async reserve(
    presentation: ContextPresentation,
    scope: PresentationScope,
    prompt: { readonly promptGenerationId: string },
  ): Promise<ReserveOutcome> {
    const address = this.addressOf(presentation, scope);

    // `omit` is a real decision, not a delivery. Reserving it would block a
    // future *valid* revision of the same subject.
    if (presentation.presentation === 'omit') {
      return { admitted: false, reason: 'omitted_by_mapper', address };
    }

    const nowMs = this.now();
    const token = this.newToken();
    const expiresAtMs = nowMs + this.reservationTtlMs;
    const result = await this.store.reserve(address, {
      token,
      nowMs,
      expiresAtMs,
      promptGenerationId: prompt.promptGenerationId,
    });

    if (result !== 'reserved') return { admitted: false, reason: result, address };
    return {
      admitted: true,
      reservation: { address, token, expiresAtMs, promptGenerationId: prompt.promptGenerationId },
    };
  }

  /**
   * Consume dedupe — only with a provider-minted receipt in hand.
   *
   * There is no overload that takes "we think it probably went out".
   */
  async commit(reservation: PresentationReservation, receipt: DeliveryReceipt): Promise<CommitOutcome> {
    if (!isProviderMintedReceipt(receipt)) {
      // Throw rather than return: a caller holding a forged receipt has a bug in
      // its provider seam, and degrading that to a soft `false` would let it ship.
      throw new Error('delivery_receipt_not_provider_minted');
    }

    // A self-heal replaces the prompt generation mid-flight. The generation that
    // was replaced must not collect the receipt of the one that actually shipped.
    if (receipt.promptGenerationId !== reservation.promptGenerationId) {
      return { committed: false, reason: 'generation_mismatch' };
    }

    const result = await this.store.commit(reservation.address, {
      token: reservation.token,
      deliveredAtMs: receipt.providerReceivedAt,
      promptGenerationId: receipt.promptGenerationId,
      providerAdapterId: receipt.providerAdapterId,
    });

    if (result === 'committed') return { committed: true };
    return { committed: false, reason: result };
  }

  /**
   * Give the projection back: this prompt will not deliver it.
   *
   * `reason` is telemetry only — the ledger does not branch on why, because
   * every failure reason has the same correct consequence: the cat is still owed
   * this content.
   */
  async release(reservation: PresentationReservation, _reason: string): Promise<void> {
    await this.store.release(reservation.address, reservation.token);
  }
}
