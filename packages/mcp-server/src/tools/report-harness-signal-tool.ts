import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('report-harness-signal-tool.ts', undefined, {
  resourceFamily: 'harness-evaluation',
  authority: 'callback-owner',
});

/**
 * Marks the current invocation for post-terminal trace attribution.
 * KEEP IN SYNC with reportHarnessSignalBodySchema in the API package.
 */
const unitRefShape = z.object({
  unitType: z.literal('segment').describe("Evaluation unit type (currently 'segment')."),
  unitId: z.string().min(1).describe('Segment id, for example S13.'),
  clauseId: z.string().min(1).optional().describe('Stable clause anchor for a compound segment.'),
});

export const reportHarnessSignalInputSchema = {
  objectiveId: z.string().min(1).describe('Registered Objective slug. Use cat_cafe_list_objectives; never invent one.'),
  metricId: z.string().min(1).describe('Metric id declared by that Objective evaluation model.'),
  unitRefs: z.array(unitRefShape).min(1).describe('Segments/clauses whose behavior triggered the marker.'),
  polarity: z
    .enum(['counterexample', 'positive', 'candidate'])
    .default('counterexample')
    .describe('counterexample/positive when clear; candidate when semantic review is still needed.'),
  note: z.string().min(1).optional().describe('Short reason for the marker; not itself a verdict.'),
  idempotencyKey: z.string().min(1).optional().describe('Reuse only when retrying this exact marker call.'),
};

interface ReportHarnessSignalToolInput extends Record<string, unknown> {
  objectiveId: string;
  metricId: string;
  unitRefs: Array<{ unitType: 'segment'; unitId: string; clauseId?: string }>;
  polarity?: 'counterexample' | 'positive' | 'candidate';
  note?: string;
  idempotencyKey?: string;
}

export async function handleReportHarnessSignalTool(input: ReportHarnessSignalToolInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/report', input, { retryDelaysMs: [] });
}

export const reportHarnessSignalTools = [
  defineTool({
    name: 'cat_cafe_report_harness_signal',
    description:
      'F257: mark THIS authenticated invocation for Harness evaluation. This tool is a trigger, not a verdict writer: ' +
      'the API waits until the current response reaches its terminal tracing seam, binds the marker to that exact TraceEpisode, ' +
      'and then emits the same TraceAnnotation shape used by structured rules and periodic semantic analysis. ' +
      'Use counterexample for a clear rule breach, positive for a clear success, and candidate when later semantic evaluation is needed. ' +
      'The marker does not increment any metric before terminal binding. Counterexample metrics may be count-only: distinct episodes ' +
      'reach their configured threshold without requiring a denominator or synthetic violation rate. ' +
      'Invocation callback auth is required; persistent agent-key auth is intentionally unsupported because it has no current trace.',
    inputSchema: reportHarnessSignalInputSchema,
    handler: handleReportHarnessSignalTool,
    governance: {
      implementationExport: 'handleReportHarnessSignalTool',
      action: 'create-marker',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
] as const;
