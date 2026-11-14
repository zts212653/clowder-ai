import type { CollectionSensitivity } from './collection-types.js';
import type { EvidenceItem, IEvidenceStore, SearchExecutionMeta, SearchOptions } from './interfaces.js';
import type { KnowledgeDiscoverySource } from './knowledge-discovery.js';
import { hasIndexedMatchEvidence } from './knowledge-match-evidence.js';
import { redactForTranscript } from './privacy-redactor.js';
import { isGenericRecallEligible } from './recall-delivery-eligibility.js';

/** Adapts indexed rows, never a previously formatted search response. */
export function documentDiscoverySource(input: {
  id: string;
  store: Pick<IEvidenceStore, 'searchWithMeta'> & Partial<Pick<IEvidenceStore, 'search'>>;
  options?: SearchOptions;
  generic?: boolean;
  requireMatchEvidence?: string;
  sensitivity?: CollectionSensitivity;
  tolerateError?: boolean;
  onMeta?(meta: SearchExecutionMeta): void;
}): KnowledgeDiscoverySource<EvidenceItem, EvidenceItem> {
  return {
    id: input.id,
    tolerateError: input.tolerateError,
    read: async ({ query, cursor, limit, signal, deadlineAt }) => {
      const offset = cursor ? Number(cursor) : 0;
      const window = offset + (input.generic ? limit : Math.min(limit, input.options?.limit ?? limit));
      const options = { ...input.options, limit: window, signal, deadlineAt };
      const execution = input.store.searchWithMeta
        ? await input.store.searchWithMeta(query, options)
        : { items: await input.store.search!(query, options), meta: legacyStoreMeta(options) };
      input.onMeta?.(execution.meta);
      return {
        candidates: execution.items.slice(offset, window),
        ...(execution.items.length >= window ? { nextCursor: String(window) } : {}),
      };
    },
    eligible: (item) =>
      (!input.generic || isGenericRecallEligible(item)) &&
      (!input.requireMatchEvidence ||
        item.matchReason === 'semantic' ||
        hasIndexedMatchEvidence(item, input.requireMatchEvidence)) &&
      (!input.options?.threadId || item.anchor === `thread-${input.options.threadId}`),
    project: async (item) => (input.sensitivity ? (redactForTranscript([item], input.sensitivity)[0] ?? null) : item),
    key: (item) => item.anchor,
    candidateKey: (item) => item.anchor,
  };
}

export function legacyStoreMeta(options?: SearchOptions): SearchExecutionMeta {
  return options?.depth === 'raw' && (options.mode ?? 'lexical') !== 'lexical'
    ? { degraded: true, degradeReason: 'raw_lexical_only', effectiveMode: 'lexical' }
    : { degraded: false };
}

export function combineSearchMeta(metas: readonly SearchExecutionMeta[]): SearchExecutionMeta {
  const priorities = {
    evidence_store_error: 4,
    passage_vector_search_error: 3,
    passage_embedding_unavailable: 2,
    raw_lexical_only: 1,
  };
  const degraded = metas
    .filter((meta) => meta.degraded)
    .sort(
      (a, b) =>
        (b.degradeReason ? priorities[b.degradeReason] : 0) - (a.degradeReason ? priorities[a.degradeReason] : 0),
    );
  const selected = degraded[0];
  return selected ? { ...selected } : { degraded: false };
}
