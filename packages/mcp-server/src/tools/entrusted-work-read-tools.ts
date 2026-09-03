import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('entrusted-work-read-tools.ts', undefined, {
  resourceFamily: 'task-workflow',
  authority: 'callback-owner',
});

export const readEntrustedWorkInputSchema = {
  taskId: z.string().trim().min(1).max(1_000).describe('Canonical entrusted-work Task ID'),
  observedRevision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Previously observed Task contract revision; stale reads return no executable producer action'),
  agentKeyCatId: z.string().min(1).optional(),
};

export async function handleReadEntrustedWork(input: {
  taskId: string;
  observedRevision?: number | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost(
    '/api/callbacks/read-entrusted-work',
    {
      taskId: input.taskId,
      ...(input.observedRevision !== undefined ? { observedRevision: input.observedRevision } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const entrustedWorkReadTools = [
  defineTool({
    name: 'cat_cafe_read_entrusted_work',
    description:
      'Read canonical entrusted-work owner truth for the current Task without mutating it. ' +
      'Web and cats receive the same refs/revisions/Artifact/time serializer. ' +
      'Producer receipts are discovered only through the closed F246/F292/F306 owner adapters; stale Task reads are inert and never expose actions.',
    inputSchema: readEntrustedWorkInputSchema,
    handler: handleReadEntrustedWork,
    governance: {
      implementationExport: 'handleReadEntrustedWork',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly', 'agent-key'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'progressive-disclosure',
        admissionRef: 'file:docs/features/F310-growing-real-delegation.md',
      },
    },
  }),
] as const;
