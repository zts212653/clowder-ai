import type { MaterializationAuthority } from '@cat-cafe/shared';

export interface SourceMaterializationHistory {
  ownerUserId: string;
  recordedAt?: number;
  materializedBy?: MaterializationAuthority;
}

// First main introduction of quote-aware digests: a2e68aaf0f3b29ab6b707152ceab2d4f9b06204d.
// Only an immutable approval already materialized before that release can prove the old format.
const QUOTE_AWARE_MAIN_INTRODUCED_AT = Date.parse('2026-09-25T00:46:36.000Z');

/** History must come from the canonical stored item, never a message timestamp or browser input. */
export function hasHistoricalBodyApproval(
  history: SourceMaterializationHistory | undefined,
  ownerUserId: string,
): boolean {
  const authority = history?.materializedBy;
  if (history?.ownerUserId !== ownerUserId || authority?.kind !== 'card_approval') return false;
  return (
    Number.isSafeInteger(history.recordedAt) &&
    Number.isSafeInteger(authority.authorizedAt) &&
    authority.authorizedAt > 0 &&
    authority.authorizedAt < QUOTE_AWARE_MAIN_INTRODUCED_AT &&
    history.recordedAt === authority.authorizedAt
  );
}
