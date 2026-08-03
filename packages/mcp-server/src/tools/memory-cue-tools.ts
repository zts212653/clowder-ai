import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolResult } from './file-tools.js';

type CallbackPost = (path: string, body: Record<string, unknown>) => Promise<ToolResult>;

const opaqueHandleSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .describe('Opaque handle from a CueEnvelope in this authenticated invocation.');
const clientRequestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe('Optional stable retry key; generated when omitted.');

export const drillMemoryCueInputSchema = {
  handle: opaqueHandleSchema,
  clientRequestId: clientRequestIdSchema,
};

export const recordMemoryCueOutcomeInputSchema = {
  handle: opaqueHandleSchema,
  outcome: z.enum(['applied', 'dismissed']).describe('Whether the presented cue affected this invocation.'),
  clientRequestId: clientRequestIdSchema,
};

export function createMemoryCueTools(callbackPost: CallbackPost) {
  const handleDrillMemoryCue = (input: { handle: string; clientRequestId?: string }) =>
    callbackPost('/api/callbacks/memory-cues/drill', {
      handle: input.handle,
      requestId: input.clientRequestId ?? `memory-cue-drill-${randomUUID()}`,
    });

  const handleRecordMemoryCueOutcome = (input: {
    handle: string;
    outcome: 'applied' | 'dismissed';
    clientRequestId?: string;
  }) =>
    callbackPost('/api/callbacks/memory-cues/outcome', {
      handle: input.handle,
      outcome: input.outcome,
      requestId: input.clientRequestId ?? `memory-cue-outcome-${randomUUID()}`,
    });

  return {
    handleDrillMemoryCue,
    handleRecordMemoryCueOutcome,
    tools: [
      {
        name: 'cat_cafe_drill_memory_cue',
        description:
          'Read the exact canonical source behind one owner-authenticated CueEnvelope. ' +
          'Use when a bounded memory cue is relevant but the short projection is insufficient. ' +
          'The server revalidates exact owner/thread/invocation scope, visibility, expiry, and current source revision on every call. ' +
          'Output: the current owner-visible canonical source payload, or not_available with no source body. ' +
          'NOT for raw query search, whole-library recall, caller-supplied source coordinates, or cross-thread handle replay. ' +
          'GOTCHA: handles are process-scoped; after API restart or source correction/forget they fail closed.',
        inputSchema: drillMemoryCueInputSchema,
        handler: handleDrillMemoryCue,
      },
      {
        name: 'cat_cafe_record_memory_cue_outcome',
        description:
          'Record whether one authenticated, already-presented memory cue was applied or dismissed. ' +
          'Use once the current invocation has made that concrete consumption decision. ' +
          'Output: a content-free recorded outcome coordinate; no cue body or private reasoning is stored. ' +
          'NOT for source correction, forgetting, invalidation, or reporting an outcome for a cue that was never presented. ' +
          'GOTCHA: there is intentionally no rationale field; canonical source lifecycle uses its own invalidation axis.',
        inputSchema: recordMemoryCueOutcomeInputSchema,
        handler: handleRecordMemoryCueOutcome,
      },
    ],
  };
}
