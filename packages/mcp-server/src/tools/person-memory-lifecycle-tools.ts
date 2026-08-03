import { randomUUID } from 'node:crypto';
import {
  candidateInteractionDraftSchema,
  captureCandidateIdSchema,
  interactionEventIdSchema,
  materializableClaimPayloadSchema,
  personClaimIdSchema,
  personIdSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { ToolResult } from './file-tools.js';

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
const exactSourceMutationSchema = {
  personId: personIdSchema,
  sourceMessageId: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .optional()
    .describe('Optional assertion; when supplied it must equal the authenticated invocation origin.'),
  clientRequestId: z.string().trim().min(1).max(200).optional(),
};

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
export const correctPersonClaimInputSchema = {
  ...exactSourceMutationSchema,
  expectedCurrentClaimId: personClaimIdSchema.describe('Exact current claim anchor; stale anchors fail closed.'),
  payload: materializableClaimPayloadSchema.describe(
    'Replacement owner fact or assessment. Agent inference is rejected.',
  ),
};
export const retirePersonClaimInputSchema = {
  ...exactSourceMutationSchema,
  expectedCurrentClaimId: personClaimIdSchema.describe('Exact current claim anchor; stale anchors fail closed.'),
};
export const amendPersonInteractionInputSchema = {
  ...exactSourceMutationSchema,
  expectedEventId: interactionEventIdSchema.describe('Exact source event anchor; the original is never overwritten.'),
  payload: candidateInteractionDraftSchema.shape.payload.describe(
    'Replacement bounded event projection with typed approximate or conflicting time preserved.',
  ),
};
export const redactPersonMemoryItemInputSchema = {
  personId: personIdSchema.describe('Exact active private person ID containing the item.'),
  item: z
    .object({ kind: z.enum(['claim', 'event']), id: z.string().trim().min(1).max(200) })
    .strict()
    .describe('Exact item whose payload and source refs must be purged.'),
  clientRequestId: z.string().trim().min(1).max(200).optional(),
};
export const forgetPersonInputSchema = {
  personId: personIdSchema.describe('Exact active private person ID to purge. This is a destructive owner action.'),
  clientRequestId: z.string().trim().min(1).max(140).optional(),
};
export const forgetPersonMemoryProposalInputSchema = {
  proposalId: captureCandidateIdSchema.describe(
    'Exact terminal F276 proposal ID to purge. Person-bound proposals fail closed and require cat_cafe_forget_person.',
  ),
  clientRequestId: z.string().trim().min(1).max(140).optional(),
};

type ExactSourceInput = {
  personId: z.infer<typeof personIdSchema>;
  sourceMessageId?: string;
  clientRequestId?: string;
};

export function createPersonMemoryLifecycleTools(callbackPost: CallbackPost, callbackGet: CallbackGet) {
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
    callbackPost('/api/callbacks/person-memory/recall', { alias: input.alias }, agentKeyOptions(input));

  const handleDrillPersonMemory = (input: {
    personId: z.infer<typeof personIdSchema>;
    item: { kind: 'claim' | 'relationship' | 'event'; id: string };
    timeWindow: { from: number; to: number };
    agentKeyCatId?: string;
  }) =>
    callbackPost(
      '/api/callbacks/person-memory/drill',
      { personId: input.personId, item: input.item, timeWindow: input.timeWindow },
      agentKeyOptions(input),
    );

  const handleCorrectPersonClaim = (
    input: ExactSourceInput & {
      expectedCurrentClaimId: z.infer<typeof personClaimIdSchema>;
      payload: z.infer<typeof materializableClaimPayloadSchema>;
    },
  ) =>
    callbackPost('/api/callbacks/person-memory/correct-claim', {
      personId: input.personId,
      expectedCurrentClaimId: input.expectedCurrentClaimId,
      payload: input.payload,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      requestId: input.clientRequestId ?? `correction_${randomUUID()}`,
    });

  const handleRetirePersonClaim = (
    input: ExactSourceInput & { expectedCurrentClaimId: z.infer<typeof personClaimIdSchema> },
  ) =>
    callbackPost('/api/callbacks/person-memory/retire-claim', {
      personId: input.personId,
      expectedCurrentClaimId: input.expectedCurrentClaimId,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      requestId: input.clientRequestId ?? `retirement_${randomUUID()}`,
    });

  const handleAmendPersonInteraction = (
    input: ExactSourceInput & {
      expectedEventId: z.infer<typeof interactionEventIdSchema>;
      payload: z.infer<typeof candidateInteractionDraftSchema.shape.payload>;
    },
  ) =>
    callbackPost('/api/callbacks/person-memory/amend-event', {
      personId: input.personId,
      expectedEventId: input.expectedEventId,
      payload: input.payload,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      requestId: input.clientRequestId ?? `amendment_${randomUUID()}`,
    });

  const handleRedactPersonMemoryItem = (input: {
    personId: z.infer<typeof personIdSchema>;
    item: { kind: 'claim' | 'event'; id: string };
    clientRequestId?: string;
  }) =>
    callbackPost('/api/callbacks/person-memory/redact', {
      personId: input.personId,
      item: input.item,
      requestId: input.clientRequestId ?? `redaction_${randomUUID()}`,
    });

  const handleForgetPerson = (input: { personId: z.infer<typeof personIdSchema>; clientRequestId?: string }) =>
    callbackPost('/api/callbacks/person-memory/forget', {
      personId: input.personId,
      requestId: `person_forget_${input.clientRequestId ?? randomUUID()}`,
    });

  const handleForgetPersonMemoryProposal = (input: {
    proposalId: z.infer<typeof captureCandidateIdSchema>;
    clientRequestId?: string;
  }) =>
    callbackPost('/api/callbacks/person-memory/forget-proposal', {
      proposalId: input.proposalId,
      requestId: `person_forget_proposal_${input.clientRequestId ?? randomUUID()}`,
    });

  return {
    handleGetPersonMemoryProposalStatus,
    handleRecallPersonRelationship,
    handleDrillPersonMemory,
    handleCorrectPersonClaim,
    handleRetirePersonClaim,
    handleAmendPersonInteraction,
    handleRedactPersonMemoryItem,
    handleForgetPerson,
    handleForgetPersonMemoryProposal,
    tools: [
      {
        name: 'cat_cafe_get_person_memory_proposal_status',
        description:
          'Read the authoritative live status of one exact owner-private F276 proposal. Use when: before reporting that a proposal is pending, approved, materialized, withdrawn, or rejected whenever the owner may have acted since creation. NOT for: editing, approving, undoing, or reading a person dossier; this tool is read-only and candidate-specific. Output: the authenticated owner-scoped status, remaining draft IDs, publication/card reference, and latest decision or undo receipts when present; no writes. GOTCHA: never infer current status from the original proposal response or chat history.',
        inputSchema: getPersonMemoryProposalStatusInputSchema,
        handler: handleGetPersonMemoryProposalStatus,
      },
      {
        name: 'cat_cafe_recall_person_relationship',
        description:
          'Resolve one owner-private active person by alias and return a bounded relationship card (F276). Never recall pending/not-now/rejected proposals, workspace-only entities, whole dossiers, or ambiguous aliases.',
        inputSchema: recallPersonRelationshipInputSchema,
        handler: handleRecallPersonRelationship,
      },
      {
        name: 'cat_cafe_drill_person_memory',
        description:
          'Drill one exact item from an authorized F276 card with a required time window. Returns a bounded projection plus at most one source ref; whole-dossier reads are unsupported.',
        inputSchema: drillPersonMemoryInputSchema,
        handler: handleDrillPersonMemory,
      },
      {
        name: 'cat_cafe_correct_person_claim',
        description:
          'Append an owner-authorized replacement for one exact current claim and supersede the anchored version atomically. Stale anchors and agent inference fail closed.',
        inputSchema: correctPersonClaimInputSchema,
        handler: handleCorrectPersonClaim,
      },
      {
        name: 'cat_cafe_retire_person_claim',
        description:
          'Retire one exact current F276 claim from an authenticated owner source. Appends a retirement version; stale anchors fail closed.',
        inputSchema: retirePersonClaimInputSchema,
        handler: handleRetirePersonClaim,
      },
      {
        name: 'cat_cafe_amend_person_interaction',
        description:
          'Amend one exact interaction event without overwriting it. The new event links to the source and preserves approximate or conflicting time.',
        inputSchema: amendPersonInteractionInputSchema,
        handler: handleAmendPersonInteraction,
      },
      {
        name: 'cat_cafe_redact_person_memory_item',
        description:
          'Destructively purge payload and source refs from one exact claim or event while retaining a redacted lifecycle marker. Requires an explicit owner request.',
        inputSchema: redactPersonMemoryItemInputSchema,
        handler: handleRedactPersonMemoryItem,
      },
      {
        name: 'cat_cafe_forget_person',
        description:
          'Permanently hard-forget one exact owner-private person and all canonical/private derived surfaces. Destructive; requires an explicit owner request.',
        inputSchema: forgetPersonInputSchema,
        handler: handleForgetPerson,
      },
      {
        name: 'cat_cafe_forget_person_memory_proposal',
        description:
          'Permanently purge one exact owner-private terminal F276 proposal lineage, including producer feedback and matching F281 episode indexes. Use when: the owner explicitly asks to delete an unbound rejected or withdrawn proposal by its exact proposalId. NOT for: active, pending, or person-bound proposals; person-bound memory must use cat_cafe_forget_person. Output: a content-free deletion receipt or an equalized absent result. GOTCHA: destructive and owner-authenticated; aliases, names, and inferred person IDs are never accepted.',
        inputSchema: forgetPersonMemoryProposalInputSchema,
        handler: handleForgetPersonMemoryProposal,
      },
    ],
  };
}
