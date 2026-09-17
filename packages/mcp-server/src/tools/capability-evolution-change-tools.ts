import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

/**
 * Cat-facing entry to the Phase 4 owner lifecycle. This is deliberately one operation-only tool:
 * F246/F266/F313 and the asset owner resolve every Approval, target, dispatch, receipt and outcome.
 */

const defineTool = defineMcpCanonicalFactory('capability-evolution-change-tools.ts', undefined, {
  resourceFamily: 'evolution-program',
  authority: 'callback-owner',
});

const bounded = (max: number) => z.string().trim().min(1).max(max);
const programId = z.string().regex(/^evolution-program:[0-9a-f]{32}$/);
const agentKeyCatId = bounded(120)
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared agent-key MCP variants; ignored under invocation auth.',
  );
const changeAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('propose') }).strict(),
  z.object({ kind: z.literal('sync') }).strict(),
  z
    .object({
      kind: z.literal('decide'),
      decision: z.enum(['keep', 'tune', 'rollback', 'sunset', 'no_change']),
    })
    .strict(),
]);

export const advanceEvolutionProgramChangeInputSchema = {
  programId: programId.describe('Exact canonical Evolution Program id.'),
  expectedSequence: z.number().int().nonnegative().describe('Current Program sequence for CAS.'),
  clientMessageId: bounded(240).describe('Stable idempotency id for this owner lifecycle operation.'),
  action: changeAction.describe(
    'Operation only: request a canonical proposal, sync owner progress, or record an explicit metabolism decision.',
  ),
  agentKeyCatId,
};

export interface AdvanceEvolutionProgramChangeInput {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  action: z.infer<typeof changeAction>;
  agentKeyCatId?: string;
}

export function handleAdvanceEvolutionProgramChange(input: AdvanceEvolutionProgramChangeInput): Promise<ToolResult> {
  return callbackPost(
    `/api/callbacks/evolution-programs/${encodeURIComponent(input.programId)}/changes`,
    {
      expectedSequence: input.expectedSequence,
      clientMessageId: input.clientMessageId,
      action: input.action,
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const capabilityEvolutionChangeTools = [
  defineTool({
    name: 'cat_cafe_advance_evolution_program_change',
    description:
      'Advance the governed Change & Learn lane of a canonical Evolution Program with one operation-only action. ' +
      'Use propose only for an actionable intervention and from an authenticated invocation with an exact source message; use sync to import canonical Approval/dispatch/mutation/outcome progress; use decide only after a merged-and-loaded fresh outcome and an explicit value-owner/operator disposition. ' +
      'NOT for: sending an Approval, owner identity, target/version, Task/lease, mutation receipt or outcome — F246/F266/F313 and the asset owner resolve and own all of those. ' +
      'Output: appended/duplicate/conflict/waiting/blocked plus the ref-only Program projection. Rejected, withdrawn, superseded and drifted attempts require a fresh propose operation and remain side-effect-ineligible. ' +
      'GOTCHA: agent-key callers may only sync. Proposal and metabolism decisions fail closed without an invocation-bound owner source or a direct owner session.',
    inputSchema: advanceEvolutionProgramChangeInputSchema,
    handler: handleAdvanceEvolutionProgramChange,
    governance: {
      implementationExport: 'handleAdvanceEvolutionProgramChange',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/features/F311-capability-evolution-workspace.md',
      },
    },
  }),
] as const;
