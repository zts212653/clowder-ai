import { randomUUID } from 'node:crypto';
import { type RememberItem, rememberItemSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';

const defineTool = defineMcpCanonicalFactory('remember-tool.ts', undefined, {
  resourceFamily: 'memory',
  authority: 'callback-owner',
});
export function handleRemember(input: { items: RememberItem[]; clientRequestId?: string }) {
  return callbackPost('/api/callbacks/remember', { ...input, clientRequestId: input.clientRequestId ?? randomUUID() });
}
export const rememberTools = [
  defineTool({
    name: 'cat_cafe_remember',
    description:
      'Submit 1–4 memory items through their existing domain entry points. Use when a person asks to remember profile context, taste, a person, an entity, an event correction or a shared matter. NOT for reading memory, approving proposals or forgetting data. Output: each original proposal/result or rejection, plus a groupId and a persistent Chat group. Existing approval, source checks, deduplication and direct-write rules still apply to each item; one refusal does not undo another item. payload uses the corresponding original submission fields; person_revision additionally names action correct_claim, retire_claim or amend_event. Keep clientRequestId for the same request when retrying.',
    inputSchema: {
      clientRequestId: z
        .string()
        .min(1)
        .max(160)
        .optional()
        .describe('Request key for the same set of items; one is generated when omitted.'),
      items: z
        .array(rememberItemSchema)
        .min(1)
        .max(4)
        .describe(
          '1–4 items with distinct itemId, a target and the original submission payload. profile uses targetLayer; matter uses operation; person_revision uses action. Original payload requestId/clientRequestId is preserved when supplied.',
        ),
    },
    handler: handleRemember,
    governance: {
      implementationExport: 'handleRemember',
      action: 'write',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/architecture/memory/remember-entry.md',
      },
    },
  }),
];
