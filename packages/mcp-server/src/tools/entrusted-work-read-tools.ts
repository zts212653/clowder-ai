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
  includeCompleted: z
    .boolean()
    .optional()
    .describe('Read satisfied completed work as inert history; does not revive it or expose judgment actions'),
};

export async function handleReadEntrustedWork(input: {
  taskId: string;
  observedRevision?: number | undefined;
  includeCompleted?: boolean | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost(
    '/api/callbacks/read-entrusted-work',
    {
      taskId: input.taskId,
      ...(input.includeCompleted !== undefined ? { includeCompleted: input.includeCompleted } : {}),
      ...(input.observedRevision !== undefined ? { observedRevision: input.observedRevision } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const entrustedWorkReadTools = [
  defineTool({
    name: 'cat_cafe_read_entrusted_work',
    description:
      'Read canonical entrusted-work owner truth without mutation. Use when: inspecting the current Task, its progress, time or delivered material; set includeCompleted for satisfied history. ' +
      'NOT for: resuming or changing terminal work, cross-thread access, or nominating producer receipts. ' +
      'Output: the same owner refs/revisions, typed dates/progress and prepared Artifact as Web; completed work carries closure evidence without attention actions. ' +
      'GOTCHA: history opens only the sealed, still-current owner-issued material; unsealed legacy results remain unavailable. Stale reads expose no executable actions; authorization stays user/thread-scoped.',
    inputSchema: readEntrustedWorkInputSchema,
    handler: handleReadEntrustedWork,
    governance: {
      implementationExport: 'handleReadEntrustedWork',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['collective-work', 'full', 'readonly', 'agent-key'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'progressive-disclosure',
        admissionRef: 'file:docs/features/F310-growing-real-delegation.md',
      },
    },
  }),
] as const;
