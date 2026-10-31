import { z } from 'zod';
import { bindMcpImplementation, defineMcpTool } from '../tool-governance.js';
import { callbackGet } from './callback-tools.js';
import { errorResult, type ToolResult } from './file-tools.js';

export const recallMetricsInputSchema = {
  days: z.number().int().min(1).max(90).default(30).describe('Window in days (1–90, default 30)'),
  catId: z.string().min(1).max(128).optional().describe('Aggregate cat filter; not an identity selector'),
  toolName: z.string().min(1).max(128).optional().describe('Aggregate tool filter; not an arbitrary route'),
};
const schema = z.object(recallMetricsInputSchema).strict();

export async function handleGetRecallMetrics(input: unknown, extra?: { signal?: AbortSignal }): Promise<ToolResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return errorResult('Invalid recall metrics parameters');
  const { days, catId, toolName } = parsed.data;
  return callbackGet(
    '/api/callbacks/get-recall-metrics',
    {
      days: String(days),
      ...(catId ? { catId } : {}),
      ...(toolName ? { toolName } : {}),
    },
    { readBudget: { timeoutMs: 10_000, maxResponseBytes: 65_536, ...(extra?.signal ? { signal: extra.signal } : {}) } },
  );
}

const sourceRef = 'file:packages/mcp-server/src/tools/recall-metrics-tool.ts' as const;
export const recallMetricsTools = [
  defineMcpTool({
    name: 'cat_cafe_get_recall_metrics',
    description:
      'Read the current installation’s aggregate recall metrics through the authenticated Host. ' +
      'Use when: checking recall consumption, reformulation, abandonment or graph statistics for a bounded 1–90 day window. ' +
      'NOT for: raw queries/messages, user-isolated analytics, cross-installation data or arbitrary HTTP/shell requests. ' +
      'Output: the canonical period, filters, event count and core/extended/graph aggregate report. ' +
      'GOTCHA: these are installation-wide, cross-cat statistics; catId/toolName only filter the report. Invocation credentials are required. ' +
      'The fixed GET has a 10-second total transport deadline and a 64 KiB success/error body limit, with no redirect or retry.',
    operation: {
      kind: 'single',
      action: 'read',
      inputSchema: recallMetricsInputSchema,
      boundary: {
        authorizationPaths: [
          {
            principal: 'invocation-cat',
            credentialSource: 'invocation-record',
            scope: { kind: 'local-runtime' },
            enforcementRef: 'file:packages/api/src/routes/callback-recall-metrics.ts',
          },
        ],
        risk: { level: 'read', openWorld: false },
      },
    },
    implementation: bindMcpImplementation(
      'module:./tools/recall-metrics-tool.js#handleGetRecallMetrics',
      handleGetRecallMetrics,
      handleGetRecallMetrics,
    ),
    policy: {
      resourceFamily: 'recall-metrics',
      schemaDelivery: { policy: 'host-default', evidenceRef: sourceRef },
      runtimeProfiles: ['full', 'readonly'],
      owner: { domainCell: 'architecture-cell:memory', surface: 'mcp-surface-governance' },
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/features/F306-codex-app-capability-parity.md',
      },
      activeState: 'canonical',
      cognitiveEntryPoints: [{ kind: 'tool-description', ref: sourceRef }],
      verification: [{ kind: 'test', ref: 'test:packages/mcp-server/test/recall-metrics-tool.test.js' }],
    },
  }),
] as const;
