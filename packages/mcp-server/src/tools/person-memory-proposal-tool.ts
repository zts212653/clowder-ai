import { randomUUID } from 'node:crypto';
import {
  candidateClaimDraftSchema,
  candidateInteractionProposalSchema,
  candidateRelationshipDraftSchema,
  captureCandidateIdSchema,
  createTemporalValueSchema,
  personIdentityDraftSchema,
  personIdSchema,
  personMemorySourceBundleInputSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult } from './file-tools.js';

type CallbackPost = (
  path: string,
  body: Record<string, unknown>,
  options?: { agentKeyCatId?: string },
) => Promise<ToolResult>;

const claimInputSchema = candidateClaimDraftSchema.omit({ draftId: true, decision: true });
const relationshipInputSchema = candidateRelationshipDraftSchema.omit({ draftId: true, decision: true });
const interactionProposalBaseSchema = candidateInteractionProposalSchema.innerType();
const interactionInputSchema = interactionProposalBaseSchema
  .extend({
    payload: interactionProposalBaseSchema.shape.payload.extend({
      occurredAt: createTemporalValueSchema().optional(),
      duration: createTemporalValueSchema().optional(),
    }),
  })
  .superRefine((value, ctx) => {
    const validated = candidateInteractionProposalSchema.safeParse(value);
    if (validated.success) return;
    for (const issue of validated.error.issues) {
      ctx.addIssue(issue);
    }
  });

export const proposePersonMemoryInputSchema = {
  person: personIdentityDraftSchema.describe(
    'One named third-party person. Aliases are private to the authenticated owner; an optional workspace link is only a locator.',
  ),
  targetPersonId: personIdSchema
    .optional()
    .describe('Optional exact active private person ID when updating an already materialized person.'),
  replacesProposalId: captureCandidateIdSchema
    .optional()
    .describe(
      'Exact pending/not-now F276 proposal ID to replace with this corrected card. The server anchors the new card and withdraws the old one atomically.',
    ),
  claims: z
    .array(claimInputSchema)
    .max(3)
    .default([])
    .describe('0-3 owner-reported facts or owner assessments. Agent inference is intentionally not accepted.'),
  relationship: relationshipInputSchema
    .optional()
    .describe('Optional first-class owner-to-person relationship proposal.'),
  interaction: interactionInputSchema
    .optional()
    .describe(
      'Optional append-only interaction event with 1-8 ordered owner-visible message evidence sources, including exact messages from other threads. Preserve approximate or conflicting time explicitly.',
    ),
  sourceBundle: personMemorySourceBundleInputSchema.describe(
    'Typed evidence sources plus per-claim/relationship/interaction-field assertion roles. Locators are optimistic pins; the server re-resolves owner, actual source thread, visibility and digest before staging and again before publication.',
  ),
  sourceMessageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional exact owner-authored source from any owner-visible thread. Historical sources must contain every claim/relationship evidence excerpt and pass visibility checks.',
    ),
  clientRequestId: z.string().min(1).max(200).optional().describe('Optional idempotency key.'),
};

type ProposePersonMemoryInput = {
  person: z.infer<typeof personIdentityDraftSchema>;
  targetPersonId?: z.infer<typeof personIdSchema>;
  replacesProposalId?: z.infer<typeof captureCandidateIdSchema>;
  claims: Array<z.infer<typeof claimInputSchema>>;
  relationship?: z.infer<typeof relationshipInputSchema>;
  interaction?: z.infer<typeof interactionInputSchema>;
  sourceBundle: z.infer<typeof personMemorySourceBundleInputSchema>;
  sourceMessageId?: string;
  clientRequestId?: string;
};

function isStaleProposalResult(result: ToolResult): boolean {
  try {
    const data = JSON.parse((result.content[0] as { text: string }).text);
    return data?.status === 'stale_ignored';
  } catch {
    return false;
  }
}

export function createPersonMemoryProposalTool(callbackPost: CallbackPost) {
  async function handleProposePersonMemory(input: ProposePersonMemoryInput): Promise<ToolResult> {
    const result = await callbackPost('/api/callbacks/propose-person-memory', {
      person: input.person,
      targetPersonId: input.targetPersonId,
      replacesProposalId: input.replacesProposalId,
      claims: input.claims,
      relationship: input.relationship,
      interaction: input.interaction,
      sourceBundle: input.sourceBundle,
      sourceMessageId: input.sourceMessageId,
      clientRequestId: input.clientRequestId ?? randomUUID(),
    });
    if (result.isError) return result;
    if (isStaleProposalResult(result)) {
      return errorResult(
        'Person-memory proposal was NOT created: this invocation has been superseded by a newer one (stale_ignored).',
      );
    }
    return result;
  }

  return {
    handleProposePersonMemory,
    tool: {
      name: 'cat_cafe_propose_person_memory',
      description:
        'Propose owner-private memory for one named person and up to three exact facts, relationship, or event items (F276). ' +
        'Use when: a low-frequency, high-value named person is introduced or corrected; no explicit “remember” command or repetition threshold is required. ' +
        'NOT for: workspace name/handle/alias mappings (use cat_cafe_propose_entity), or correcting already materialized truth (use the exact F276 claim/event lifecycle tool). ' +
        'Output: one rich chat card plus one Approval Hub item; nothing becomes recallable until the owner selects exact items, and approval atomically writes only those items. ' +
        'Accept owner facts and assessments with bounded quoted evidence, never agent inference. Preserve uncertain or conflicting time instead of guessing. ' +
        'Every proposal requires a typed sourceBundle with assertion roles. Attachments use an exact message block locator plus digest and bounded stored transcript; owner-confirmed transcripts preserve transcript_accuracy and never become event truth by themselves. ' +
        'For events, include a readable narrative, importance/topic, uncertainty notes, and field-mapped typed sources; the server validates every source against its actual owner-visible thread. ' +
        'Before the first durable write, the server preflights the exact approval card, source materializability, informed evidence and token budgets; blocked proposals return a machine-readable preflight action and create no pending candidate. ' +
        'The server derives owner, requester, current card thread, and every exact source thread. Do not create a silent dossier. ' +
        'GOTCHA: when correcting a pending/not-now F276 card, pass replacesProposalId so the corrected card atomically withdraws the old one; never route a private-memory correction into workspace Entity merely because the pending card cannot be edited in place. ' +
        'A replacement is a complete new pending snapshot, not a patch. Reusing one clientRequestId with a different replacesProposalId fails closed. ' +
        'If complete facts live in other owner-visible threads, stay in the current conversation and attach those exact messages as typed sources; the approval card remains in the current conversation while each source drills to its original thread. Never replace missing facts with a zero-information card, and never model the correction itself as a new interaction event.',
      inputSchema: proposePersonMemoryInputSchema,
      handler: handleProposePersonMemory,
    },
  };
}
