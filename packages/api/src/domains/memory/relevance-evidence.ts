import type { EvidenceItem } from './interfaces.js';

/** Observed textual support, not calibrated confidence or source authority. */
export interface RelevanceEvidence {
  state: 'exact_anchor' | 'exact_title' | 'phrase' | 'unknown';
}

export function normalizeRecallText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function relevanceEvidence(
  item: Pick<EvidenceItem, 'anchor' | 'title' | 'summary' | 'keywords' | 'passages'>,
  query: string,
): RelevanceEvidence {
  const q = normalizeRecallText(query);
  if (!q) return { state: 'unknown' };
  const anchor = normalizeRecallText(item.anchor);
  const queryTokens = q.split(/[^\p{L}\p{N}:._/-]+/u);
  if (anchor === q || queryTokens.includes(anchor)) return { state: 'exact_anchor' };
  if (normalizeRecallText(item.title) === q) return { state: 'exact_title' };
  const fields = [
    item.title,
    item.summary ?? '',
    ...(item.keywords ?? []),
    ...(item.passages ?? []).map((p) => p.content),
  ];
  return {
    state: q.length >= 2 && fields.some((text) => normalizeRecallText(text).includes(q)) ? 'phrase' : 'unknown',
  };
}
