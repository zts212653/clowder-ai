import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('paw-feel-inbox-audit-scan-tool.ts', undefined, {
  resourceFamily: 'eval-feedback',
  authority: 'callback-owner',
});
const auditScanAdmissionReason = {
  disposition: 'accepted-boundary',
  kind: 'progressive-disclosure',
  admissionRef: 'file:docs/features/F278-paw-feel-disposition-inbox.md',
} as const;
const agentKeyCatIdSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared agent-key MCP variants; ignored under invocation auth.',
  );

export const scanPawFeelInboxInputSchema = {
  limit: z.number().int().min(1).max(50).optional().describe('Signal rows per page; defaults to 50.'),
  cursor: z
    .string()
    .trim()
    .min(1)
    .max(100_000)
    .optional()
    .describe('Signed nextCursor from the immediately preceding audit scan page.'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export interface ScanPawFeelInboxInput {
  limit?: number;
  cursor?: string;
  agentKeyCatId?: string;
}

export async function handleScanPawFeelInbox(input: ScanPawFeelInboxInput): Promise<ToolResult> {
  return callbackPost(
    '/api/callbacks/paw-feel-inbox-audit-scan',
    {
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const pawFeelInboxAuditScanTools = [
  defineTool({
    name: 'cat_cafe_scan_paw_feel_inbox',
    description:
      'Scan the canonical F278 signal ledger as bounded, page-local audit rows. ' +
      'Use when: a full audit, export, or census must traverse every raw signal without recomputing global bundle, count, issue, or responsibility projections on each page. ' +
      'NOT for: interactive duty review or authoritative global summaries; use cat_cafe_list_paw_feel_inbox for those. ' +
      'Output: at most 50 canonical disposition and source-preview rows plus startedAt, generatedAt, page and running scan counts, and a signed nextCursor; no bundles, issues, responsibilities, or global aggregates. ' +
      'GOTCHA: traversal is live and not a frozen snapshot; pass nextCursor unchanged with the original limit, then deduplicate or group only after completing the traversal.',
    inputSchema: scanPawFeelInboxInputSchema,
    handler: handleScanPawFeelInbox,
    governance: {
      implementationExport: 'handleScanPawFeelInbox',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: auditScanAdmissionReason,
    },
  }),
] as const;
