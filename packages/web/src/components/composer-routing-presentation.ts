import { buildCatMentionIdentities } from '@cat-cafe/shared';
import type { CatData, useCatData } from '@/hooks/useCatData';
import { getCoCreatorMentionPatterns } from '@/lib/mention-highlight';
import { knownCatName } from './shell/ShellCatAvatar';

type CatLookup = ReturnType<typeof useCatData>['getCatById'];

/** Human-facing composer name; the internal id is never a UI fallback. */
export function composerCatName(catId: string, getCatById: CatLookup, fallback: string): string {
  return knownCatName(catId, getCatById) ?? fallback;
}

export interface ComposerRecipientIdentity {
  label: string;
  /** Registered mention that resolves to only this cat; null means the menu must not offer insertion. */
  insert: string | null;
}

/**
 * One identity projection for every composer surface that names or inserts a cat.
 * A shared nickname is presentation-only; routing must use an alias that belongs
 * to exactly one cat.
 */
export function buildComposerRecipientIdentities(
  cats: readonly CatData[],
  reservedMentionPatterns: readonly string[] = getCoCreatorMentionPatterns(),
): ReadonlyMap<string, ComposerRecipientIdentity> {
  return buildCatMentionIdentities(cats, reservedMentionPatterns);
}
