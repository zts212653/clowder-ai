import { randomUUID } from 'node:crypto';
import { type MemoryCueDocumentWindowRequest, memoryCueDocumentWindowRequestSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory, defineMcpMigrationFactory } from '../tool-governance-migration.js';

import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('memory-cue-tools.ts', './tools/callback-tools.js', {
  resourceFamily: 'memory-cue',
  authority: 'callback-owner-private',
});
const defineDocumentDrill = defineMcpCanonicalFactory('memory-cue-tools.ts', './tools/callback-tools.js', {
  resourceFamily: 'memory-cue',
  authority: 'callback-owner-private',
});

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
  window: memoryCueDocumentWindowRequestSchema
    .optional()
    .describe(
      'Canonical project documents only: locate a phrase with query, or continue with nextOffset as offset. Omit for the initial window. Never changes source or revision.',
    ),
};

export const recordMemoryCueOutcomeInputSchema = {
  handle: opaqueHandleSchema,
  outcome: z.enum(['applied', 'dismissed']).describe('Whether the presented cue affected this invocation.'),
  clientRequestId: clientRequestIdSchema,
};

export function createMemoryCueTools(callbackPost: CallbackPost) {
  const handleDrillMemoryCue = (input: {
    handle: string;
    clientRequestId?: string;
    window?: MemoryCueDocumentWindowRequest;
  }) =>
    callbackPost('/api/callbacks/memory-cues/drill', {
      handle: input.handle,
      requestId: input.clientRequestId ?? `memory-cue-drill-${randomUUID()}`,
      ...(input.window ? { window: input.window } : {}),
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
      defineDocumentDrill({
        name: 'cat_cafe_drill_memory_cue',
        description:
          'Read the current canonical source behind an owner-authenticated CueEnvelope. ' +
          'Use when its bounded projection is insufficient, or to locate a heading/phrase and continue a long project document. ' +
          'Output: owner-visible payload; canonical project documents include sourcePath/sourceRevision, contentRange (UTF-16 code units, end exclusive), contentTruncated, nextOffset and location status. ' +
          'Use window.query for case-insensitive literal lookup, or window.offset=nextOffset to continue with the same handle; each page contains at most 4000 code units. A not_found lookup returns the initial window honestly; nextOffset=null means end. ' +
          'not_available if gone or revoked; retryable source_read_failed on reader failure. ' +
          'NOT for raw search, bulk recall, caller-supplied coordinates, or cross-thread replay. ' +
          'GOTCHA: window is supported only for canonical project document cues; omit it for other families. Owner/thread/invocation scope, visibility, expiry, and current source revision are revalidated for every page; restart, correction, or forget closes the handle.',
        inputSchema: drillMemoryCueInputSchema,
        handler: handleDrillMemoryCue,
        governance: {
          implementationExport: 'handleDrillMemoryCue',
          action: 'read',
          risk: { level: 'read', openWorld: false },
          runtimeProfiles: ['full'],
        },
      }),
      defineTool({
        name: 'cat_cafe_record_memory_cue_outcome',
        description:
          'Record applied or dismissed for one authenticated, presented memory cue. ' +
          'Use after this invocation makes that consumption decision. ' +
          'Output: a content-free outcome reference; safe post-expiry writes add settlement=late_after_drill. ' +
          'NOT for source mutation/invalidation or unpresented cues. ' +
          'GOTCHA: no rationale is stored. Expired handles settle only after this exact owner/thread/invocation/cat recorded a successful drill and the current revision and visibility revalidate; otherwise 410 expired. Transient reader failures return retryable source_read_failed; corrected, forgotten, or revoked sources stay closed.',
        inputSchema: recordMemoryCueOutcomeInputSchema,
        handler: handleRecordMemoryCueOutcome,
        governance: {
          implementationExport: 'handleRecordMemoryCueOutcome',
          action: 'update',
          risk: { level: 'write', openWorld: false },
          runtimeProfiles: ['full'],
        },
      }),
    ],
  };
}
