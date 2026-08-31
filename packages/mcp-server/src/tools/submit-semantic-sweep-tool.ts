import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('submit-semantic-sweep-tool.ts', undefined, {
  resourceFamily: 'harness-evaluation',
  authority: 'eval-callback',
});

const unitRefShape = z.object({
  unitType: z.literal('segment'),
  unitId: z.string().min(1),
  clauseId: z.string().min(1).optional(),
});

const matchShape = z.object({
  objectiveId: z.string().min(1),
  metricId: z.string().min(1),
  unitRefs: z.array(unitRefShape).min(1),
  polarity: z.enum(['counterexample', 'positive']),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
});

const decisionShape = z.object({
  invocationId: z.string().min(1),
  status: z.enum(['matched', 'irrelevant', 'unscorable']),
  matches: z.array(matchShape),
});

export const submitSemanticSweepInputSchema = {
  jobId: z.string().min(1).describe('Immutable semantic sweep job id supplied by the eval packet.'),
  decisions: z
    .array(decisionShape)
    .min(1)
    .describe('One structured decision per reviewed frozen invocation; omit an invocation to leave it retryable.'),
};

interface SubmitSemanticSweepInput extends Record<string, unknown> {
  jobId: string;
  decisions: z.infer<typeof decisionShape>[];
}

export async function handleSubmitSemanticSweepTool(input: SubmitSemanticSweepInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/submit-semantic-sweep', input, { retryDelaysMs: [] });
}

export const submitSemanticSweepTools = [
  defineTool({
    name: 'cat_cafe_submit_semantic_sweep',
    description:
      'F257 eval-worker writeback. Submit structured decisions for the exact immutable trace batch in a semantic sweep packet. ' +
      'Only the eval cat assigned to that job may submit it. This never starts tracing and cannot name episodes outside the frozen batch. ' +
      'The API validates Objective/Metric/unit coordinates, appends unified TraceAnnotations, and lets metric thresholds/cadence react.',
    inputSchema: submitSemanticSweepInputSchema,
    handler: handleSubmitSemanticSweepTool,
    governance: {
      implementationExport: 'handleSubmitSemanticSweepTool',
      action: 'submit-semantic-sweep',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
] as const;
