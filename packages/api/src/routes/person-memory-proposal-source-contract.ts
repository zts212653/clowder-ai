import {
  type CandidateInteractionDraft,
  candidateClaimDraftSchema,
  candidateInteractionProposalSchema,
  candidateRelationshipDraftSchema,
  captureCandidateIdSchema,
  PERSON_MEMORY_LIMITS,
  type PersonMemoryResolvedSourceBundle,
  type PersonMemorySourceBundleInput,
  personIdentityDraftSchema,
  personIdSchema,
  personMemorySourceBundleInputSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { type IMessageStore, isDelivered } from '../domains/cats/services/stores/ports/MessageStore.js';
import { canViewMessage } from '../domains/cats/services/stores/visibility.js';
import { estimateTokens } from '../utils/token-counter.js';

const claimInputSchema = candidateClaimDraftSchema.omit({ draftId: true, decision: true });
const relationshipInputSchema = candidateRelationshipDraftSchema.omit({ draftId: true, decision: true });
const interactionInputSchema = candidateInteractionProposalSchema;

export const proposePersonMemorySchema = z
  .object({
    person: personIdentityDraftSchema,
    targetPersonId: personIdSchema.optional(),
    claims: z.array(claimInputSchema).max(PERSON_MEMORY_LIMITS.maxClaimsPerCandidate).default([]),
    relationship: relationshipInputSchema.optional(),
    interaction: interactionInputSchema.optional(),
    sourceBundle: personMemorySourceBundleInputSchema.optional(),
    replacesProposalId: captureCandidateIdSchema.optional(),
    sourceMessageId: z.string().trim().min(1).max(240).optional(),
    clientRequestId: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const count = value.claims.length + (value.relationship ? 1 : 0) + (value.interaction ? 1 : 0);
    if (count < 1 || count > PERSON_MEMORY_LIMITS.maxClaimsPerCandidate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claims'],
        message: `proposal must contain 1-${PERSON_MEMORY_LIMITS.maxClaimsPerCandidate} exact-bind items`,
        params: {
          preflightCode: 'informed_approval_incomplete',
        },
      });
    }
    const excerpts = [
      ...value.claims.map((draft) => draft.evidenceExcerpt),
      ...(value.relationship ? [value.relationship.evidenceExcerpt] : []),
      ...(value.interaction
        ? [value.interaction.evidenceExcerpt, ...value.interaction.sources.map((source) => source.evidenceExcerpt)]
        : []),
    ];
    if (excerpts.some((excerpt) => estimateTokens(excerpt) > PERSON_MEMORY_LIMITS.maxEvidenceExcerptTokens)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claims'],
        message: `each evidence excerpt must be <=${PERSON_MEMORY_LIMITS.maxEvidenceExcerptTokens} tokens`,
        params: {
          preflightCode: 'evidence_excerpt_budget_exceeded',
          budgetKind: 'evidence_excerpt',
          maxTokens: PERSON_MEMORY_LIMITS.maxEvidenceExcerptTokens,
        },
      });
    }
    if (estimateTokens(excerpts.join('\n')) > PERSON_MEMORY_LIMITS.maxEvidenceExcerptAggregateTokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claims'],
        message: `evidence excerpts must be <=${PERSON_MEMORY_LIMITS.maxEvidenceExcerptAggregateTokens} tokens total`,
        params: {
          preflightCode: 'evidence_excerpt_budget_exceeded',
          budgetKind: 'evidence_excerpt_aggregate',
          maxTokens: PERSON_MEMORY_LIMITS.maxEvidenceExcerptAggregateTokens,
        },
      });
    }
  });

export type ProposePersonMemoryBody = z.infer<typeof proposePersonMemorySchema>;

export type ProposePersonMemorySourceAuth = {
  userId: string;
  threadId: string;
};

type LegacySources = PersonMemorySourceBundleInput['sources'];
type LegacyBindings = PersonMemorySourceBundleInput['assertionBindings'];

function appendLegacyClaims(
  body: ProposePersonMemoryBody,
  proposalSourceMessageId: string,
  sources: LegacySources,
  assertionBindings: LegacyBindings,
): void {
  for (const [index, claim] of body.claims.entries()) {
    const sourceId = `legacy-claim-${index}`;
    sources.push({
      sourceId,
      kind: 'message_text',
      messageId: proposalSourceMessageId,
      excerpt: claim.evidenceExcerpt,
    });
    assertionBindings.push({
      sourceId,
      target: { kind: 'claim', index },
      role: claim.sourceRole === 'quoted_third_party' ? 'quoted_third_party' : claim.payload.kind,
    });
  }
}

function appendLegacyRelationship(
  body: ProposePersonMemoryBody,
  proposalSourceMessageId: string,
  sources: LegacySources,
  assertionBindings: LegacyBindings,
): void {
  if (!body.relationship) return;
  const sourceId = 'legacy-relationship';
  sources.push({
    sourceId,
    kind: 'message_text',
    messageId: proposalSourceMessageId,
    excerpt: body.relationship.evidenceExcerpt,
  });
  assertionBindings.push({
    sourceId,
    target: { kind: 'relationship', field: 'status' },
    role: body.relationship.sourceRole === 'quoted_third_party' ? 'quoted_third_party' : 'reported_fact',
  });
}

function appendLegacyInteraction(
  body: ProposePersonMemoryBody,
  sources: LegacySources,
  assertionBindings: LegacyBindings,
): void {
  for (const [index, source] of body.interaction?.sources.entries() ?? []) {
    const sourceId = `legacy-interaction-${index}`;
    sources.push({
      sourceId,
      kind: 'message_text',
      messageId: source.messageId,
      excerpt: source.evidenceExcerpt,
    });
    for (const field of source.supports) {
      const assessmentField = field === 'importanceOrTopic' || field === 'uncertaintyNotes';
      assertionBindings.push({
        sourceId,
        target: { kind: 'interaction', field },
        role:
          body.interaction?.sourceRole === 'quoted_third_party'
            ? 'quoted_third_party'
            : assessmentField
              ? 'user_assessment'
              : 'reported_fact',
      });
    }
  }
}

export function legacySourceBundle(
  body: ProposePersonMemoryBody,
  proposalSourceMessageId: string,
): PersonMemorySourceBundleInput {
  const sources: PersonMemorySourceBundleInput['sources'] = [];
  const assertionBindings: PersonMemorySourceBundleInput['assertionBindings'] = [];
  appendLegacyClaims(body, proposalSourceMessageId, sources, assertionBindings);
  appendLegacyRelationship(body, proposalSourceMessageId, sources, assertionBindings);
  appendLegacyInteraction(body, sources, assertionBindings);
  return personMemorySourceBundleInputSchema.parse({ sources, assertionBindings });
}

function containsRelayedQuote(value: string): boolean {
  return /(?:告诉我|跟我说|对我说|向我说|听说|据说|别人说|说(?:他|她|自己|ta)\b|表示(?:他|她)|提到(?:他|她)|[\p{Script=Han}A-Za-z0-9·._-]{2,32}(?:说的|讲过))/iu.test(
    value.normalize('NFKC'),
  );
}

export function requiredInteractionFields(
  interaction: ProposePersonMemoryBody['interaction'],
): Array<CandidateInteractionDraft['sourceEvidence'][number]['supports'][number]> {
  if (!interaction) return [];
  return [
    'eventKind',
    'headline',
    'importanceOrTopic',
    ...(interaction.payload.occurredAt ? (['occurredAt'] as const) : []),
    ...(interaction.payload.duration ? (['duration'] as const) : []),
    ...(interaction.payload.uncertaintyNotes.length > 0 ? (['uncertaintyNotes'] as const) : []),
  ];
}

export async function resolvedBindingsAreMaterializable(
  bundle: PersonMemoryResolvedSourceBundle,
  messageStore: Pick<IMessageStore, 'getById'>,
): Promise<boolean> {
  const sources = new Map(bundle.sources.map((source) => [source.sourceId, source]));
  for (const binding of bundle.assertionBindings) {
    if (
      binding.role !== 'reported_fact' ||
      binding.target.kind !== 'interaction' ||
      binding.target.field === 'importanceOrTopic' ||
      binding.target.field === 'uncertaintyNotes'
    ) {
      continue;
    }
    const source = sources.get(binding.sourceId);
    if (source?.kind !== 'message_text') return false;
    const message = await messageStore.getById(source.sourceRef.messageId);
    if (!message || containsRelayedQuote(message.content)) return false;
  }
  return true;
}

export async function resolveInteractionSourceEvidence(
  messageStore: IMessageStore,
  interaction: ProposePersonMemoryBody['interaction'],
  auth: ProposePersonMemorySourceAuth,
): Promise<CandidateInteractionDraft['sourceEvidence'] | null> {
  if (!interaction) return [];
  const resolved: CandidateInteractionDraft['sourceEvidence'] = [];
  for (const source of interaction.sources) {
    const message = await messageStore.getById(source.messageId);
    if (
      !message ||
      message.userId !== auth.userId ||
      message.catId !== null ||
      message.source !== undefined ||
      message.deletedAt !== undefined ||
      message._tombstone === true ||
      !isDelivered(message) ||
      !canViewMessage(message, { type: 'user' }) ||
      !message.content.normalize('NFKC').includes(source.evidenceExcerpt.normalize('NFKC'))
    ) {
      return null;
    }
    resolved.push({
      sourceRef: {
        kind: 'message',
        threadId: message.threadId,
        messageId: message.id,
      },
      evidenceExcerpt: source.evidenceExcerpt,
      supports: source.supports,
    });
  }
  return resolved;
}

export async function resolveProposalSourceMessageId(
  messageStore: IMessageStore,
  body: ProposePersonMemoryBody,
  auth: ProposePersonMemorySourceAuth,
  invocationOriginMessageId: string,
): Promise<string | null> {
  const requestedMessageId = body.sourceMessageId ?? invocationOriginMessageId;
  if (requestedMessageId === invocationOriginMessageId) return invocationOriginMessageId;

  const message = await messageStore.getById(requestedMessageId);
  const evidenceExcerpts = body.sourceBundle
    ? []
    : [
        ...body.claims.map((draft) => draft.evidenceExcerpt),
        ...(body.relationship ? [body.relationship.evidenceExcerpt] : []),
      ];
  if (
    !message ||
    message.userId !== auth.userId ||
    message.catId !== null ||
    message.source !== undefined ||
    message.deletedAt !== undefined ||
    message._tombstone === true ||
    !isDelivered(message) ||
    !canViewMessage(message, { type: 'user' }) ||
    evidenceExcerpts.some((excerpt) => !message.content.normalize('NFKC').includes(excerpt.normalize('NFKC')))
  ) {
    return null;
  }
  return message.id;
}
