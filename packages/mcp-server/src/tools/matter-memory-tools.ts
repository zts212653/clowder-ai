import { matterWriteInputSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackGet } from './callback-tools.js';

const defineTool = defineMcpCanonicalFactory('matter-memory-tools.ts', undefined, {
  resourceFamily: 'memory-matter',
  authority: 'callback-owner-private',
});
const cursor = z.string().max(2000).optional().describe('Opaque nextCursor returned by the same catalogue or page.');
const limit = z.number().int().min(1).max(30).optional().describe('Maximum entries per page; default 12, maximum 30.');
const operations = matterWriteInputSchema.options;
export const matterAgentChangeSchema = z.discriminatedUnion('operation', [
  operations[0],
  operations[1],
  operations[2],
  operations[3],
  operations[4],
  operations[5],
]);

export function handleListMemoryMatters(input: { query?: string; cursor?: string; limit?: number }) {
  return callbackGet('/api/callbacks/memory-matters', {
    ...(input.query ? { query: input.query } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit ? { limit: String(input.limit) } : {}),
  });
}
export function handleReadMemoryMatter(input: {
  matterId: string;
  cursor?: string;
  limit?: number;
  history?: boolean;
}) {
  return callbackGet(`/api/callbacks/memory-matters/${encodeURIComponent(input.matterId)}`, {
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit ? { limit: String(input.limit) } : {}),
    ...(input.history ? { history: 'true' } : {}),
  });
}

export const matterMemoryTools = [
  defineTool({
    name: 'cat_cafe_list_memory_matters',
    description:
      'Find shared memory pages about a matter (事情/跨线原话). Use when opening/resuming work, finding prior discussion or continuing an opening directory. NOT for proving a real read; use read_memory_matter. Output: currently readable titles, IDs, revisions, entry counts, source/summary status and nextCursor; no read receipt. Pages with active unchanged sources from this authenticated invocation thread come first, then updatedAt and stable ID. hasThreadSource means source location, not applicability or authorization. Reuse a cursor with the same reader, thread and query. The optional query matches titles/descriptions; empty does not prove no relevant history exists.',
    inputSchema: {
      query: z.string().max(200).optional().describe('Literal title/description clue, e.g. 守望猫; omit to browse.'),
      cursor,
      limit,
    },
    handler: handleListMemoryMatters,
    governance: {
      implementationExport: 'handleListMemoryMatters',
      action: 'list',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/architecture/f332-matter-memory-contract.md',
      },
    },
  }),
  defineTool({
    name: 'cat_cafe_read_memory_matter',
    description:
      'Read one shared matter page: description is the cat-written contextual interpretation; entries provide exact raw quotes and sources. Use when a matter is relevant to this turn, including after resume or correction; reread its current version. NOT for granting execution authority or proving adoption. Output: interpretation, raw quotes, separate authors/quoted speakers, source coordinates, page/source revisions and pagination. Changed active sources mark the interpretation unverified (summaryStatus=sources_changed); do not treat it as a current conclusion or silently substitute new speech. A successful nonempty read records a durable explicit-read receipt for this invocation/cat. Directory, context hints, empty and failed reads do not count. Verify applicability from the full page; current user instructions take precedence within their scope.',
    inputSchema: {
      matterId: z.string().min(1).max(200).describe('Stable matterId from the directory or an earlier page.'),
      cursor,
      limit,
      history: z
        .boolean()
        .optional()
        .describe('Include superseded/retired entries, still subject to current source permissions.'),
    },
    handler: handleReadMemoryMatter,
    governance: {
      implementationExport: 'handleReadMemoryMatter',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/architecture/f332-matter-memory-contract.md',
      },
    },
  }),
] as const;
