/**
 * F296 B2b: the presentation ledger.
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
 */

import type { ContextPresentation, PresentationKind, SourceRevision } from './context-presentation.js';

export interface PresentationLedgerKey {
  readonly scopeKey: string;
  readonly contextEpoch: number;
  readonly subjectKey: string;
  readonly asOf: SourceRevision;
  readonly presentation: PresentationKind;
}

/** Proof the provider actually received the prompt carrying this projection. */
export interface DeliveryReceipt {
  /** Prompt generation the projection was part of — a self-healed retry differs. */
  readonly promptGenerationId: string;
  readonly providerReceivedAt: number;
}

export interface LedgerEntry {
  readonly key: string;
  readonly deliveredAt: number;
  readonly promptGenerationId: string;
}

export interface IPresentationLedgerStore {
  has(key: string): boolean | Promise<boolean>;
  put(entry: LedgerEntry): void | Promise<void>;
}

export class InMemoryPresentationLedgerStore implements IPresentationLedgerStore {
  private readonly entries = new Map<string, LedgerEntry>();

  has(key: string): boolean {
    return this.entries.has(key);
  }

  put(entry: LedgerEntry): void {
    this.entries.set(entry.key, entry);
  }
}

/**
 * Explicit escape, never a raw literal: an invisible control character pasted
 * into source is unreviewable, and F296 already lost time to exactly that
 * (B1's scope key silently used NUL). `\u001f` is chosen over a printable
 * separator because `subjectKey` is externally shaped (`pr:owner/repo#42`,
 * `subject:task:…`) and must not be able to forge a field boundary.
 */
export const LEDGER_KEY_SEPARATOR = '\u001f';

function revisionToken(asOf: SourceRevision): string {
  return asOf.kind === 'version' ? `v:${asOf.value}` : `t:${asOf.value}`;
}

/**
 * Content-free by construction: only coordinates go in, so the key cannot leak
 * candidate text into storage or telemetry.
 */
export function presentationLedgerKey(key: PresentationLedgerKey): string {
  return [key.scopeKey, String(key.contextEpoch), key.subjectKey, revisionToken(key.asOf), key.presentation].join(
    LEDGER_KEY_SEPARATOR,
  );
}

export type AdmissionOutcome =
  | { readonly admit: true; readonly key: string }
  | {
      readonly admit: false;
      readonly reason: 'already_delivered_this_epoch' | 'omitted_by_mapper';
      readonly key: string;
    };

export class PresentationLedger {
  constructor(private readonly store: IPresentationLedgerStore) {}

  /**
   * Decide whether a mapped projection may enter this prompt.
   *
   * Note what this does NOT do: it does not mark anything delivered. Admission
   * and delivery are deliberately two steps, because everything between them
   * (render, budget trim, provider launch) can still drop the projection.
   */
  async admit(
    presentation: ContextPresentation,
    scope: { readonly scopeKey: string; readonly contextEpoch: number },
  ): Promise<AdmissionOutcome> {
    const key = presentationLedgerKey({
      scopeKey: scope.scopeKey,
      contextEpoch: scope.contextEpoch,
      subjectKey: presentation.subjectKey,
      asOf: presentation.asOf,
      presentation: presentation.presentation,
    });

    // `omit` is a real decision, not a delivery. Recording it as delivered would
    // block a future *valid* revision of the same subject.
    if (presentation.presentation === 'omit') {
      return { admit: false, reason: 'omitted_by_mapper', key };
    }

    if (await Promise.resolve(this.store.has(key))) {
      return { admit: false, reason: 'already_delivered_this_epoch', key };
    }
    return { admit: true, key };
  }

  /**
   * Consume dedupe — only with a provider receipt in hand.
   *
   * There is no overload that takes "we think it probably went out".
   */
  async recordDelivered(key: string, receipt: DeliveryReceipt): Promise<void> {
    await Promise.resolve(
      this.store.put({
        key,
        deliveredAt: receipt.providerReceivedAt,
        promptGenerationId: receipt.promptGenerationId,
      }),
    );
  }
}
