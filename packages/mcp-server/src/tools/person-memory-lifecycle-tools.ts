import { randomUUID } from 'node:crypto';
import { captureCandidateIdSchema, personIdSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';

import type { ToolResult } from './file-tools.js';
import { createPersonMemoryRevisionTool } from './person-memory-revision-tool.js';

const defineTool = defineMcpMigrationFactory('person-memory-lifecycle-tools.ts', './tools/callback-tools.js', {
  resourceFamily: 'person-memory',
  authority: 'callback-owner-private',
});

type CallbackPost = (
  path: string,
  body: Record<string, unknown>,
  options?: { agentKeyCatId?: string },
) => Promise<ToolResult>;
type CallbackGet = (
  path: string,
  params?: Record<string, string>,
  options?: { agentKeyCatId?: string },
) => Promise<ToolResult>;

const agentKeyCatIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared Antigravity MCP when CAT_CAFE_AGENT_KEY_FILES is configured; ignored when invocation credentials are present.',
  );
const agentKeyOptions = (input: { agentKeyCatId?: string }) => ({ agentKeyCatId: input.agentKeyCatId });

export const recallPersonRelationshipInputSchema = {
  alias: z.string().trim().min(1).max(160).describe('Exact private alias mentioned in the current owner context.'),
  agentKeyCatId: agentKeyCatIdSchema,
};
export const getPersonMemoryProposalStatusInputSchema = {
  proposalId: captureCandidateIdSchema.describe('Exact F276 candidate ID returned by the proposal tool or card.'),
  agentKeyCatId: agentKeyCatIdSchema,
};
export const drillPersonMemoryInputSchema = {
  personId: personIdSchema.describe('Exact active private person ID returned by an authorized relationship card.'),
  item: z
    .object({ kind: z.enum(['claim', 'relationship', 'event']), id: z.string().trim().min(1).max(200) })
    .strict()
    .describe('One exact card item. Whole-dossier reads are intentionally unsupported.'),
  timeWindow: z
    .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
    .strict()
    .describe('Required inclusive recorded-at window in epoch milliseconds.'),
  agentKeyCatId: agentKeyCatIdSchema,
};
export function createPersonMemoryLifecycleTools(callbackPost: CallbackPost, callbackGet: CallbackGet) {
  const revision = createPersonMemoryRevisionTool(callbackPost);
  const handleGetPersonMemoryProposalStatus = (input: {
    proposalId: z.infer<typeof captureCandidateIdSchema>;
    agentKeyCatId?: string;
  }) =>
    callbackGet(
      `/api/callbacks/person-memory/proposals/${encodeURIComponent(input.proposalId)}/status`,
      undefined,
      agentKeyOptions(input),
    );

  const handleRecallPersonRelationship = (input: { alias: string; agentKeyCatId?: string }) =>
    callbackPost(
      '/api/callbacks/person-memory/recall',
      { alias: input.alias, readRequestId: `person_read_${randomUUID()}` },
      agentKeyOptions(input),
    );

  const handleDrillPersonMemory = (input: {
    personId: z.infer<typeof personIdSchema>;
    item: { kind: 'claim' | 'relationship' | 'event'; id: string };
    timeWindow: { from: number; to: number };
    agentKeyCatId?: string;
  }) =>
    callbackPost(
      '/api/callbacks/person-memory/drill',
      {
        personId: input.personId,
        item: input.item,
        timeWindow: input.timeWindow,
        readRequestId: `person_drill_${randomUUID()}`,
      },
      agentKeyOptions(input),
    );

  return {
    handleGetPersonMemoryProposalStatus,
    handleRecallPersonRelationship,
    handleDrillPersonMemory,
    handleRevisePersonMemory: revision.handleRevisePersonMemory,
    tools: [
      defineTool({
        name: 'cat_cafe_get_person_memory_proposal_status',
        description:
          'Read the authoritative live status of one exact owner-private F276 proposal. Use when: before reporting that a proposal is pending, approved, materialized, withdrawn, or rejected whenever the owner may have acted since creation. NOT for: editing, approving, undoing, or reading a person dossier; this tool is read-only and candidate-specific. Output: the authenticated owner-scoped status, remaining draft IDs, publication/card reference, and latest decision or undo receipts when present; no writes. GOTCHA: never infer current status from the original proposal response or chat history.',
        inputSchema: getPersonMemoryProposalStatusInputSchema,
        handler: handleGetPersonMemoryProposalStatus,
        governance: {
          implementationExport: 'handleGetPersonMemoryProposalStatus',
          action: 'read',
          risk: { level: 'read', openWorld: false },
          runtimeProfiles: ['full', 'agent-key'],
        },
      }),
      defineTool({
        name: 'cat_cafe_recall_person_relationship',
        description:
          'Resolve one owner-private active person by alias and return a bounded relationship card (F276). Never recall pending/not-now/rejected proposals, workspace-only entities, whole dossiers, or ambiguous aliases.',
        inputSchema: recallPersonRelationshipInputSchema,
        handler: handleRecallPersonRelationship,
        governance: {
          implementationExport: 'handleRecallPersonRelationship',
          action: 'read',
          risk: { level: 'read', openWorld: false },
          runtimeProfiles: ['full', 'agent-key', 'desktop:live-companion'],
        },
      }),
      defineTool({
        name: 'cat_cafe_drill_person_memory',
        description:
          'Drill one exact item from an authorized F276 card with a required time window. Returns a bounded projection plus at most one source ref; whole-dossier reads are unsupported.',
        inputSchema: drillPersonMemoryInputSchema,
        handler: handleDrillPersonMemory,
        governance: {
          implementationExport: 'handleDrillPersonMemory',
          action: 'read',
          risk: { level: 'read', openWorld: false },
          runtimeProfiles: ['full', 'agent-key', 'desktop:live-companion'],
        },
      }),
      revision.tool,
    ],
  };
}
