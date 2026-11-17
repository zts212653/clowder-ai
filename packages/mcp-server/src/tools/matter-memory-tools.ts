import { matterWriteInputSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { callbackGet } from './callback-tools.js';

const operations = matterWriteInputSchema.options;
// remember's original forwarding route generates a stable per-item requestId when omitted.
const requestId = { requestId: z.string().trim().min(1).max(200).optional() };
export const matterAgentChangeSchema = z.discriminatedUnion('operation', [
  operations[0].extend(requestId),
  operations[1].extend(requestId),
  operations[2].extend(requestId),
  operations[3].extend(requestId),
  operations[4].extend(requestId),
  operations[5].extend(requestId),
]);

/**
 * Original matter directory callback. Cats reach it through cat_cafe_search_evidence's matters group
 * (F332 find unification); the route, owner projection, cursor and visibility stay with MatterMemoryService.
 */
export function handleListMemoryMatters(
  input: { query?: string; cursor?: string; limit?: number },
  options?: { signal?: AbortSignal },
) {
  return callbackGet(
    '/api/callbacks/memory-matters',
    {
      ...(input.query ? { query: input.query } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: String(input.limit) } : {}),
    },
    options?.signal ? { signal: options.signal } : undefined,
  );
}
export function handleReadMemoryMatter(input: {
  matterId: string;
  expectedRevision?: number;
  cursor?: string;
  limit?: number;
  history?: boolean;
}) {
  return callbackGet(`/api/callbacks/memory-matters/${encodeURIComponent(input.matterId)}`, {
    ...(input.expectedRevision !== undefined ? { expectedRevision: String(input.expectedRevision) } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit ? { limit: String(input.limit) } : {}),
    ...(input.history ? { history: 'true' } : {}),
  });
}
