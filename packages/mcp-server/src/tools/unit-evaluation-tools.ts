import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('unit-evaluation-tools.ts', undefined, {
  resourceFamily: 'harness-evaluation',
  authority: 'eval-callback',
});

const retrieveInputSchema = {
  jobId: z.string().min(1).describe('Immutable Unit semantic evaluation job id from the eval packet.'),
  cursor: z.number().int().nonnegative().describe('Exact nextCursor returned by the previous retrieval batch.'),
  limit: z.number().int().min(1).max(25).describe('Number of additional frozen raw traces to retrieve (1-25).'),
};

const submitInputSchema = {
  jobId: z.string().min(1).describe('Immutable Unit semantic evaluation job id from the eval packet.'),
  labels: z
    .record(z.string().min(1), z.number().int().nonnegative())
    .describe('Semantic label counts derived from the raw traces actually inspected.'),
  explanation: z.string().trim().min(1).describe('Evidence-grounded explanation of the Unit-level judgment.'),
};

interface RetrieveInput extends Record<string, unknown> {
  jobId: string;
  cursor: number;
  limit: number;
}

interface SubmitInput extends Record<string, unknown> {
  jobId: string;
  labels: Record<string, number>;
  explanation: string;
}

export async function handleRetrieveUnitEvaluationTracesTool(input: RetrieveInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/retrieve-unit-evaluation-traces', input, {
    retryDelaysMs: [],
  });
}

export async function handleSubmitUnitEvaluationTool(input: SubmitInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/submit-unit-evaluation', input, { retryDelaysMs: [] });
}

export const unitEvaluationTools = [
  defineTool({
    name: 'cat_cafe_retrieve_unit_evaluation_traces',
    description:
      'Retrieve the next bounded batch from an immutable F257 Unit trace corpus. The server enforces owner/eval-cat custody, exact cursor continuity, and records every returned invocation as evaluation provenance. Structured counterexamples only affect priority order.',
    inputSchema: retrieveInputSchema,
    handler: handleRetrieveUnitEvaluationTracesTool,
    governance: {
      implementationExport: 'handleRetrieveUnitEvaluationTracesTool',
      action: 'retrieve-unit-evaluation-traces',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
  defineTool({
    name: 'cat_cafe_submit_unit_evaluation',
    description:
      'Submit one semantic MetricResult for the exact F257 Unit snapshot assigned to the current eval cat. The server derives retrieval provenance from batches it actually returned and resumes the all-metrics Unit commit atomically.',
    inputSchema: submitInputSchema,
    handler: handleSubmitUnitEvaluationTool,
    governance: {
      implementationExport: 'handleSubmitUnitEvaluationTool',
      action: 'submit-unit-evaluation',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
] as const;
