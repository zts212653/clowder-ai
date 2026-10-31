import type { CatData, useCatData } from '@/hooks/useCatData';
import { knownCatName } from './shell/ShellCatAvatar';

type CatLookup = ReturnType<typeof useCatData>['getCatById'];

/** Human-facing composer name; the internal id is never a UI fallback. */
export function composerCatName(catId: string, getCatById: CatLookup, fallback: string): string {
  const cat = getCatById(catId);
  return cat?.nickname ?? knownCatName(catId, getCatById) ?? fallback;
}

export interface ComposerRecipientIdentity {
  label: string;
  /** Registered mention that resolves to only this cat; null means the menu must not offer insertion. */
  insert: string | null;
}

const registeredMention = (pattern: string) => `@${pattern.replace(/^@/, '')}`;
const normalizedMention = (pattern: string) => registeredMention(pattern).toLocaleLowerCase();
const normalizedName = (name: string) => name.trim().toLocaleLowerCase();
const recipientName = (cat: CatData) => cat.nickname?.trim() || cat.displayName?.trim() || cat.name?.trim() || cat.id;

/**
 * One identity projection for every composer surface that names or inserts a cat.
 * A shared nickname is presentation-only; routing must use an alias that belongs
 * to exactly one cat.
 */
export function buildComposerRecipientIdentities(
  cats: readonly CatData[],
): ReadonlyMap<string, ComposerRecipientIdentity> {
  const nameCounts = new Map<string, number>();
  const mentionCounts = new Map<string, number>();

  for (const cat of cats) {
    const name = recipientName(cat);
    const nameKey = normalizedName(name);
    nameCounts.set(nameKey, (nameCounts.get(nameKey) ?? 0) + 1);
    for (const pattern of new Set(cat.mentionPatterns.map(normalizedMention))) {
      mentionCounts.set(pattern, (mentionCounts.get(pattern) ?? 0) + 1);
    }
  }

  return new Map(
    cats.map((cat) => {
      const name = recipientName(cat);
      const duplicateName = (nameCounts.get(normalizedName(name)) ?? 0) > 1;
      const patterns = cat.mentionPatterns.map(registeredMention);
      const uniquePatterns = patterns.filter((pattern) => mentionCounts.get(pattern.toLocaleLowerCase()) === 1);
      const exactHandle = uniquePatterns.find(
        (pattern) => pattern.toLocaleLowerCase() === `@${cat.id}`.toLocaleLowerCase(),
      );
      const nicknameMention = uniquePatterns.find(
        (pattern) => pattern.toLocaleLowerCase() === `@${name}`.toLocaleLowerCase(),
      );
      const insert = duplicateName
        ? (exactHandle ?? uniquePatterns[0] ?? null)
        : (nicknameMention ?? exactHandle ?? uniquePatterns[0] ?? null);
      const discriminator = cat.variantLabel?.trim() || cat.defaultModel?.trim() || cat.id;
      return [
        cat.id,
        {
          label: duplicateName ? `${name} · ${discriminator}` : name,
          insert: insert ? `${insert} ` : null,
        },
      ] as const;
    }),
  );
}
