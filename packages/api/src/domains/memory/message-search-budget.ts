import type { MessageSearchInput, MessageSearchResponse } from '@cat-cafe/shared';
import type { MessagePassageSearchExecution } from './message-passage-search-types.js';

export const MESSAGE_SEARCH_RESPONSE_BUDGET = 24_000;

/** Bound whole canonical rows so neither consumer silently invents a shorter source title/body. */
export function boundMessageSearchResponse(response: MessageSearchResponse): MessageSearchResponse {
  const out = {
    ...response,
    results: [...response.results],
    meta: {
      ...response.meta,
      response: {
        budgetChars: MESSAGE_SEARCH_RESPONSE_BUDGET,
        serializedChars: 0,
        truncated: false,
        continuation: 'unavailable' as const,
      },
    },
  };
  for (;;) {
    let length = JSON.stringify(out).length;
    while (out.meta.response.serializedChars !== length) {
      out.meta.response.serializedChars = length;
      length = JSON.stringify(out).length;
    }
    if (length <= MESSAGE_SEARCH_RESPONSE_BUDGET) return out;
    if (out.results.length === 0) throw new Error('Message search response metadata exceeds its budget');
    out.results.pop();
    out.meta.hasMore = true;
    out.meta.response.truncated = true;
  }
}

export function messageSearchMeta(
  input: MessageSearchInput,
  execution: MessagePassageSearchExecution,
  count: number,
  limit: number,
): MessageSearchResponse['meta'] {
  return {
    scope: input.threadId ? 'thread' : 'global',
    ...(input.threadId ? { threadId: input.threadId } : {}),
    sort: input.sort ?? 'time',
    requestedMode: input.mode ?? 'hybrid',
    effectiveMode: execution.meta.effectiveMode,
    degraded: execution.meta.degraded,
    ...(execution.meta.degradeReason ? { degradeReason: execution.meta.degradeReason } : {}),
    hasMore: count > limit,
    partial: true,
    candidateLimit: execution.meta.candidateLimit,
    semanticCandidatesLimited: execution.meta.semanticCandidatesLimited,
    sourceCoverage: 'unknown',
    freshness: 'unknown',
    response: {
      budgetChars: MESSAGE_SEARCH_RESPONSE_BUDGET,
      serializedChars: 0,
      truncated: false,
      continuation: 'unavailable',
    },
  };
}
