import type { CatId } from '@cat-cafe/shared';

export interface ParsedMention {
  targetCatId: CatId;
  matched: boolean;
}

// ASCII + CJK full-width punctuation + brackets that can follow a mention
const MENTION_BOUNDARY_RIGHT = '[\\s,.:;!?，。！？；：、)\\]）】」』]';
// Left boundary: @ must not be preceded by word chars or dots (rejects email/domain)
const MENTION_BOUNDARY_LEFT = '(?<!\\w)';

/**
 * Parse @-mentions from external platform message text.
 * Returns the **first-in-text** matched cat or defaultCatId.
 *
 * @param text — inbound message text
 * @param allPatterns — Map<CatId, mentionPatterns[]> from catRegistry
 * @param defaultCatId — fallback when no mention found
 */
export function parseMentions(text: string, allPatterns: Map<string, string[]>, defaultCatId: CatId): ParsedMention {
  let bestIndex = Infinity;
  let bestCatId: string | undefined;

  for (const [catId, patterns] of allPatterns) {
    for (const pattern of patterns) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`${MENTION_BOUNDARY_LEFT}${escaped}(?=${MENTION_BOUNDARY_RIGHT}|$)`, 'i');
      const match = regex.exec(text);
      if (match && match.index < bestIndex) {
        bestIndex = match.index;
        bestCatId = catId;
      }
    }
  }

  return { targetCatId: (bestCatId ?? defaultCatId) as CatId, matched: Boolean(bestCatId) };
}
