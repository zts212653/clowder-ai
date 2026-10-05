import type { MessageSearchResponse } from '@cat-cafe/shared';

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
