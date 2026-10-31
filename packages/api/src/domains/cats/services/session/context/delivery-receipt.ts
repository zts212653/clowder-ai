/**
 * F296 B3a gate 2: a delivery receipt only a provider adapter can mint.
 *
 * Consuming dedupe is the one irreversible act in the ledger: once a projection
 * is marked delivered, the cat will not see it again in this epoch. B2b's
 * receipt was a plain `{ promptGenerationId, providerReceivedAt }` struct, which
 * any renderer or route could construct — so "the provider received this" was an
 * assertion with nothing behind it, exactly the class of unearned authority F296
 * exists to remove.
 *
 * The proof is structural at two levels, because a TypeScript brand alone
 * evaporates at runtime:
 *
 *  - **Compile time**: the brand is a module-private `unique symbol` whose
 *    property the type requires. The symbol is unreachable from outside, so no
 *    object literal elsewhere can type-check as a receipt.
 *  - **Run time**: the brand is a non-enumerable symbol-keyed property, so it
 *    survives neither spread, nor JSON, nor `structuredClone` — the three ways a
 *    forgery realistically appears — and {@link isProviderMintedReceipt} is
 *    checked at the ledger boundary.
 *
 * This module is the provider-adapter seam. Only code that has actually observed
 * the provider accept a prompt generation may import `mintDeliveryReceipt`.
 */

/**
 * Module-private on purpose (kimi review, PR #3783).
 *
 * This used to be exported, which made the header's claim — "only this module
 * can produce a value satisfying it" — false: any caller could import the symbol
 * and `defineProperty` a passing receipt. Unexporting it is what turns that
 * sentence back into a structural fact rather than a comment.
 */
const PROVIDER_ADAPTER_RECEIPT_BRAND: unique symbol = Symbol('f296.providerAdapterReceipt');

export interface DeliveryReceipt {
  /** Prompt generation the projection was part of — a self-healed retry differs. */
  readonly promptGenerationId: string;
  readonly providerReceivedAt: number;
  /** Which adapter observed the acceptance; a coordinate, never payload. */
  readonly providerAdapterId: string;
  readonly [PROVIDER_ADAPTER_RECEIPT_BRAND]: true;
}

export interface DeliveryReceiptInput {
  readonly promptGenerationId: string;
  readonly providerReceivedAt: number;
  readonly providerAdapterId: string;
}

/**
 * Mint a receipt. Call this only after the provider has actually accepted the
 * prompt generation — not at render time, not at invoke-start.
 */
export function mintDeliveryReceipt(input: DeliveryReceiptInput): DeliveryReceipt {
  if (!input.promptGenerationId) {
    throw new Error('delivery_receipt_invalid: promptGenerationId is required');
  }
  if (!input.providerAdapterId) {
    throw new Error('delivery_receipt_invalid: providerAdapterId is required');
  }
  if (!Number.isFinite(input.providerReceivedAt) || input.providerReceivedAt <= 0) {
    throw new Error('delivery_receipt_invalid: providerReceivedAt must be a positive timestamp');
  }

  const receipt = {
    promptGenerationId: input.promptGenerationId,
    providerReceivedAt: input.providerReceivedAt,
    providerAdapterId: input.providerAdapterId,
  };
  // Non-enumerable on purpose: `{ ...receipt }` and `JSON.stringify` must both
  // drop the brand, so an accidental copy degrades to "unproven" rather than
  // silently inheriting proof it never earned.
  Object.defineProperty(receipt, PROVIDER_ADAPTER_RECEIPT_BRAND, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  // Frozen so a receipt cannot be retargeted at another generation after minting.
  return Object.freeze(receipt) as DeliveryReceipt;
}

export function isProviderMintedReceipt(value: unknown): value is DeliveryReceipt {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[PROVIDER_ADAPTER_RECEIPT_BRAND] === true
  );
}
