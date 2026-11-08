import type { MessageSearchResult } from '@cat-cafe/shared';
import { matchedLiteralTerms } from './literal-term-coverage.js';

/** Explain lexical overlap in canonical text. It is not a relevance gate or score. */
export function messageSearchMatchEvidence(
  query: string,
  content: string,
  match: MessageSearchResult['match'],
): NonNullable<MessageSearchResult['matchEvidence']> {
  const body = content.toLocaleLowerCase();
  const words = [...new Set(query.trim().split(/\s+/u).filter(Boolean))];
  const latin = new Set(
    words.filter((word) => /^[\p{Script=Latin}\p{M}\p{N}_-]+$/u.test(word)).map((word) => word.toLocaleLowerCase()),
  );
  const matched = new Set(
    matchedLiteralTerms(
      words.filter((word) => !latin.has(word.toLocaleLowerCase())).map((word) => word.toLocaleLowerCase()),
    )(body),
  );
  for (const word of body.matchAll(/[\p{Script=Latin}\p{M}\p{N}_-]+/gu)) if (latin.has(word[0])) matched.add(word[0]);
  const terms = words.filter((word) => matched.has(word.toLocaleLowerCase()));
  return { kind: terms.length ? 'literal' : match === 'lexical' ? 'lexical' : 'semantic', terms };
}
