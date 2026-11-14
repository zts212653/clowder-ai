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
  defineTool({
    name: 'cat_cafe_write_memory_matter',
    description:
      'Create, append to, correct or retire a shared matter page using exact original message selections. Use when related statements/decisions across threads should remain findable together, or a sourced correction replaces an entry. NOT for personal profiles, people or tastes (use their proposal tools), editing source messages, or authorizing work. Output: durable matterId/revision receipt. description is cat-written contextual interpretation: background, the core issue, subsequent action, and applicable/inapplicable scope; it is optional for simple facts, not a mandatory four-part template. When useful, include one brief, source-grounded way this matter might be asked about in the interpretation; it is only a retrieval clue, not a new fact, applicability rule or instruction. sources retain exact original speech coordinates, never reconstructed speech or hidden reasoning. Reuse requestId only for the exact change; updates need expectedRevision from a fresh read. Selections use raw UTF-16 start/end (end exclusive), body/quote_comment/quote_text; quote attachments need contentBlockIndex and attachmentId. Recheck the interpretation after source correction; current user instructions take precedence within their scope. Owner forgetting is in the memory UI.',
    inputSchema: {
      change: agentChange.describe(
        'One exact change. description is optional cat-written context and applicability; sources preserve exact original threadId/messageId, segment, raw start/end and selected quote.',
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
