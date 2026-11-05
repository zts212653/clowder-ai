import { type MatterWriteInput, matterWriteInputSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackGet, callbackPost } from './callback-tools.js';

const defineTool = defineMcpCanonicalFactory('matter-memory-tools.ts', undefined, {
  resourceFamily: 'memory-matter',
  authority: 'callback-owner-private',
});
const cursor = z.string().max(2000).optional().describe('Opaque nextCursor returned by the same catalogue or page.');
const limit = z.number().int().min(1).max(30).optional().describe('Maximum entries per page; default 12, maximum 30.');
const operations = matterWriteInputSchema.options;
const agentChange = z.discriminatedUnion('operation', [
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
export function handleWriteMemoryMatter(input: { change: MatterWriteInput }) {
  return callbackPost('/api/callbacks/memory-matters/write', input.change);
}
export const matterMemoryTools = [
  defineTool({
    name: 'cat_cafe_list_memory_matters',
    description:
      'Find shared memory pages about a matter (事情/跨线原话). Use when opening or resuming work, finding what was already discussed or decided, or continuing a paged directory. NOT for reading source messages or proving that a cat has read them; use read_memory_matter. Output: currently readable page titles, IDs, revisions, entry counts and nextCursor; no read receipt. The optional query matches page titles/descriptions; empty does not prove no relevant past conversation exists.',
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
      'Read current original messages linked to one shared matter page. Use when a matter is relevant to this turn, including after resume or a correction; reread even if an older version is in context. NOT for granting execution authority or reporting adoption. Output: raw quotes, separate authors/quoted speakers, source coordinates, page/source revisions and pagination; changed sources are marked without substituting new text. A successful nonempty read records a durable explicit-read receipt for this authenticated invocation/cat. Directory, empty and failed reads do not count.',
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
  defineTool({
    name: 'cat_cafe_write_memory_matter',
    description:
      'Create, append to, correct or retire a shared matter page using exact original message selections. Use when related statements/decisions in different threads should remain findable together, or when a new sourced correction replaces an entry. NOT for personal profiles, people or tastes (use their proposal tools), editing source messages, or authorizing work. Output: durable matterId/revision receipt. Reuse requestId only for the exact same change; updates require expectedRevision from a fresh read. Source selections use raw UTF-16 start/end (end exclusive), segment body/quote_comment/quote_text, and quote attachments require contentBlockIndex and attachmentId. Titles/descriptions are cat-written interpretation, not original speech; owner forgetting is in the memory UI.',
    inputSchema: {
      change: agentChange.describe(
        'One exact change. Sources include threadId/messageId, segment, raw start/end and the exact selected quote.',
      ),
    },
    handler: handleWriteMemoryMatter,
    governance: {
      implementationExport: 'handleWriteMemoryMatter',
      action: 'write',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/architecture/f332-matter-memory-contract.md',
      },
    },
  }),
] as const;
