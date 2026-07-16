import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const singleLine = (label: string) =>
  z
    .string()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value), `${label} must be a single-line value`);

export const previewSessionRecoveryTrialsInputSchema = {
  windowStartMs: z.number().finite().nonnegative().describe('Inclusive source transition time, epoch milliseconds.'),
  windowEndMs: z
    .number()
    .finite()
    .nonnegative()
    .describe('Exclusive source transition time, epoch milliseconds; must be after windowStartMs, max 31 days.'),
  catId: singleLine('catId').optional().describe('Optional cat identity filter.'),
  threadId: singleLine('threadId').optional().describe('Optional thread filter.'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum projected trials; defaults to 50.'),
  agentKeyCatId: singleLine('agentKeyCatId')
    .optional()
    .describe('Persistent-agent identity selector. Required for shared Antigravity MCP.'),
};

export interface PreviewSessionRecoveryTrialsInput {
  windowStartMs: number;
  windowEndMs: number;
  catId?: string;
  threadId?: string;
  limit?: number;
  agentKeyCatId?: string;
}

export async function handlePreviewSessionRecoveryTrials(
  input: PreviewSessionRecoveryTrialsInput,
): Promise<ToolResult> {
  return callbackPost(
    `/api/eval-domains/${encodeURIComponent('eval:session-recovery')}/preview-trials`,
    {
      selector: {
        kind: 'session-recovery-window',
        windowStartMs: input.windowStartMs,
        windowEndMs: input.windowEndMs,
        ...(input.catId ? { catId: input.catId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const sessionRecoveryEvalTools = [
  {
    name: 'cat_cafe_preview_session_recovery_trials',
    description:
      'Preview replayable eval:session-recovery trials for a bounded owner-scoped window. ' +
      'Returns compact source/target/invocation/event anchors and structural grading; it never returns transcript bodies. ' +
      'Use these anchors to inspect relevant sealed sessions, form per-trial semantic assessments, then pass the assessments only to cat_cafe_publish_verdict. ' +
      'This tool is read-only and does not save assessments. Window maximum is 31 days; result limit maximum is 200.',
    inputSchema: previewSessionRecoveryTrialsInputSchema,
    handler: handlePreviewSessionRecoveryTrials,
  },
] as const;
