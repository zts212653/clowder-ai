/**
 * Unified sender resolution — co-creator is a first-class member.
 *
 * Replaces the repeated `senderCatId === null ? coCreator : getCatById(...)` branching
 * scattered across ReplyPill, ReplyPreviewBar, SummaryCard, MessageNavigator, etc.
 *
 * Usage:
 *   const sender = resolveSender(senderCatId, getCatById, coCreator);
 *   // sender.label  → "@宪宪" | "始皇帝" | "@unknown-cat"
 *   // sender.color  → resolved primary color, always non-null
 */

import type { CoCreatorConfig } from '@/components/config-viewer-types';
import type { CatData } from '@/hooks/useCatData';
import { CO_CREATOR_COLOR, UNKNOWN_CAT_COLOR } from '@/lib/color-defaults';

export interface SenderMeta {
  /** Display label: "@猫名" for cats, co-creator name for user, "@rawId" for unknown */
  label: string;
  /** Resolved primary color — always a valid hex string */
  color: string;
  /** true when sender is the co-creator (senderCatId was null) */
  isCoCreator: boolean;
}

/**
 * Resolve any senderCatId to display metadata.
 *
 * - `null` → co-creator (co-creator is a member too)
 * - known catId → cat display name + cat color
 * - unknown catId → raw ID + fallback color
 */
export function resolveSender(
  senderCatId: string | null,
  getCatById: (id: string) => CatData | undefined,
  coCreator: CoCreatorConfig,
): SenderMeta {
  // Co-creator — first-class member, not a "null fallback"
  if (senderCatId === null) {
    return {
      label: coCreator.name,
      color: coCreator.color?.primary ?? CO_CREATOR_COLOR.primary,
      isCoCreator: true,
    };
  }

  // Known cat
  const cat = getCatById(senderCatId);
  if (cat) {
    return {
      label: `@${cat.displayName}`,
      color: cat.color.primary,
      isCoCreator: false,
    };
  }

  // Unknown cat ID
  return {
    label: `@${senderCatId}`,
    color: UNKNOWN_CAT_COLOR.primary,
    isCoCreator: false,
  };
}
