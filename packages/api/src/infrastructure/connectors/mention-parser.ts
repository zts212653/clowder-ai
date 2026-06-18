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
 * #969: Strip zero-width Unicode characters that LLMs may insert around mentions.
 * Also strips markdown bold/italic markers (`**`, `*`, `__`, `_`) immediately before `@`.
 */
const ZERO_WIDTH_RE = /(?:​|‌|‍|﻿|­|⁠)/g;
const MD_BEFORE_MENTION_RE = /(?:\*{1,2}|_{1,2})(?=@)/g;
const MD_AFTER_MENTION_RE = /(@\S+?)(?:\*{1,2}|_{1,2})(?=\s|$|[,.:;!?，。！？])/g;

function normalizeMentionNoise(text: string): string {
  return text.replace(ZERO_WIDTH_RE, '').replace(MD_BEFORE_MENTION_RE, '').replace(MD_AFTER_MENTION_RE, '$1');
}

/**
 * Parse @-mentions from external platform message text.
 * Returns the **first-in-text** matched cat or defaultCatId.
 *
 * @param text — inbound message text
 * @param allPatterns — Map<CatId, mentionPatterns[]> from catRegistry
 * @param defaultCatId — fallback when no mention found
 */
export function parseMentions(text: string, allPatterns: Map<string, string[]>, defaultCatId: CatId): ParsedMention {
  // #969: normalize invisible chars and markdown around mentions before matching
  const normalizedText = normalizeMentionNoise(text);
  let bestIndex = Infinity;
  let bestCatId: string | undefined;

  for (const [catId, patterns] of allPatterns) {
    for (const pattern of patterns) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`${MENTION_BOUNDARY_LEFT}${escaped}(?=${MENTION_BOUNDARY_RIGHT}|$)`, 'i');
      const match = regex.exec(normalizedText);
      if (match && match.index < bestIndex) {
        bestIndex = match.index;
        bestCatId = catId;
      }
    }
  }

  return { targetCatId: (bestCatId ?? defaultCatId) as CatId, matched: Boolean(bestCatId) };
}
