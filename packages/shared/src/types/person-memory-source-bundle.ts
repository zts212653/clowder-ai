import { z } from 'zod';
import {
  boundedString,
  candidateClaimDraftIdSchema,
  ownerUserIdSchema,
  personMemorySourceRefSchema,
} from './person-memory-base.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceIdSchema = boundedString(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const PERSON_MEMORY_INTERACTION_EVIDENCE_FIELDS = [
  'eventKind',
  'headline',
  'occurredAt',
  'duration',
  'importanceOrTopic',
  'uncertaintyNotes',
] as const;

export const personMemoryInteractionEvidenceFieldSchema = z.enum(PERSON_MEMORY_INTERACTION_EVIDENCE_FIELDS);

const attachmentLocatorSchema = z
  .object({
    surface: z.enum(['content_block', 'rich_block']),
    index: z.number().int().nonnegative().max(100),
  })
  .strict();

const safeArtifactLocatorSchema = boundedString(320).refine(
  (value) =>
    value.startsWith('workspace:') &&
    !value.includes('..') &&
    !value.includes('\\') &&
    !/^[a-z]+:\/\//i.test(value) &&
    !value.includes('\0'),
  'artifact locator must be an allowlisted workspace locator',
);

const messageTextSourceInputSchema = z
  .object({
    sourceId: sourceIdSchema,
    kind: z.literal('message_text'),
    messageId: boundedString(240),
    expectedDigest: digestSchema.optional(),
    excerpt: boundedString(800),
  })
  .strict();

const messageAttachmentSourceInputSchema = z
  .object({
    sourceId: sourceIdSchema,
    kind: z.literal('message_attachment'),
    messageId: boundedString(240),
    attachmentLocator: attachmentLocatorSchema,
    expectedDigest: digestSchema,
    boundedTranscript: boundedString(800),
  })
  .strict();

const ownerConfirmedTranscriptSourceInputSchema = z
  .object({
    sourceId: sourceIdSchema,
    kind: z.literal('owner_confirmed_transcript'),
    transcript: boundedString(800),
    transcriptDigest: digestSchema,
    confirmationMessageId: boundedString(240),
    confirmationScope: z.literal('transcript_accuracy'),
  })
  .strict();

const ownerPrivateArtifactSourceInputSchema = z
  .object({
    sourceId: sourceIdSchema,
    kind: z.literal('owner_private_artifact'),
    artifactLocator: safeArtifactLocatorSchema,
    expectedDigest: digestSchema,
    boundedExcerpt: boundedString(800),
    confirmationMessageId: boundedString(240),
  })
  .strict();

export const personMemorySourceInputSchema = z.discriminatedUnion('kind', [
  messageTextSourceInputSchema,
  messageAttachmentSourceInputSchema,
  ownerConfirmedTranscriptSourceInputSchema,
  ownerPrivateArtifactSourceInputSchema,
]);

export const personMemoryAssertionRoleSchema = z.enum([
  'reported_fact',
  'user_assessment',
  'quoted_third_party',
  'agent_inference',
]);

const personMemoryAssertionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claim'), index: z.number().int().nonnegative().max(2) }).strict(),
  z.object({ kind: z.literal('relationship'), field: z.literal('status') }).strict(),
  z
    .object({
      kind: z.literal('interaction'),
      field: personMemoryInteractionEvidenceFieldSchema,
    })
    .strict(),
]);

export const personMemoryAssertionBindingSchema = z
  .object({
    sourceId: sourceIdSchema,
    target: personMemoryAssertionTargetSchema,
    role: personMemoryAssertionRoleSchema,
  })
  .strict();

function validateSourceBundleReferences(
  sources: Array<{ sourceId: string }>,
  bindings: Array<{ sourceId: string }>,
  ctx: z.RefinementCtx,
): void {
  const sourceIds = sources.map((source) => source.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'source IDs must be unique' });
  }
  const knownSourceIds = new Set(sourceIds);
  for (const [index, binding] of bindings.entries()) {
    if (!knownSourceIds.has(binding.sourceId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assertionBindings', index, 'sourceId'],
        message: 'assertion binding must reference a source in this bundle',
      });
    }
  }
}

export const personMemorySourceBundleInputSchema = z
  .object({
    sources: z.array(personMemorySourceInputSchema).min(1).max(8),
    assertionBindings: z.array(personMemoryAssertionBindingSchema).min(1).max(24),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateSourceBundleReferences(value.sources, value.assertionBindings, ctx);
  });

const resolvedMessageTextSourceSchema = z
  .object({
    sourceId: sourceIdSchema,
    kind: z.literal('message_text'),
    sourceRef: personMemorySourceRefSchema,
    ownerUserId: ownerUserIdSchema,
    resolvedDigest: digestSchema,
    excerpt: boundedString(800),
  })
  .strict();

const resolvedMessageAttachmentSourceSchema = z
  .object({
    sourceId: sourceIdSchema,
    kind: z.literal('message_attachment'),
    sourceRef: personMemorySourceRefSchema,
    ownerUserId: ownerUserIdSchema,
    attachmentLocator: attachmentLocatorSchema,
    resolvedDigest: digestSchema,
    boundedTranscript: boundedString(800),
  })
  .strict();

const resolvedOwnerConfirmedTranscriptSourceSchema = z
  .object({
    sourceId: sourceIdSchema,
    kind: z.literal('owner_confirmed_transcript'),
    confirmationSourceRef: personMemorySourceRefSchema,
    ownerUserId: ownerUserIdSchema,
    resolvedDigest: digestSchema,
    transcript: boundedString(800),
    confirmationScope: z.literal('transcript_accuracy'),
  })
  .strict();

const resolvedOwnerPrivateArtifactSourceSchema = z
  .object({
    sourceId: sourceIdSchema,
    kind: z.literal('owner_private_artifact'),
    artifactLocator: safeArtifactLocatorSchema,
    confirmationSourceRef: personMemorySourceRefSchema,
    ownerUserId: ownerUserIdSchema,
    resolvedDigest: digestSchema,
    boundedExcerpt: boundedString(800),
  })
  .strict();

export const resolvedPersonMemorySourceSchema = z.discriminatedUnion('kind', [
  resolvedMessageTextSourceSchema,
  resolvedMessageAttachmentSourceSchema,
  resolvedOwnerConfirmedTranscriptSourceSchema,
  resolvedOwnerPrivateArtifactSourceSchema,
]);

const resolvedAssertionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claim'), draftId: candidateClaimDraftIdSchema }).strict(),
  z
    .object({
      kind: z.literal('relationship'),
      draftId: candidateClaimDraftIdSchema,
      field: z.literal('status'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('interaction'),
      draftId: candidateClaimDraftIdSchema,
      field: personMemoryInteractionEvidenceFieldSchema,
    })
    .strict(),
]);

export const resolvedPersonMemoryAssertionBindingSchema = z
  .object({
    sourceId: sourceIdSchema,
    target: resolvedAssertionTargetSchema,
    role: personMemoryAssertionRoleSchema.exclude(['agent_inference']),
  })
  .strict();

export const personMemoryResolvedSourceBundleSchema = z
  .object({
    sources: z.array(resolvedPersonMemorySourceSchema).min(1).max(8),
    assertionBindings: z.array(resolvedPersonMemoryAssertionBindingSchema).min(1).max(24),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateSourceBundleReferences(value.sources, value.assertionBindings, ctx);
  });

export interface PersonMemoryAssertionMatrixInput {
  claims: Array<{ kind: 'reported_fact' | 'user_assessment' }>;
  hasRelationship: boolean;
  hasInteraction: boolean;
  requiredInteractionFields?: Array<z.infer<typeof personMemoryInteractionEvidenceFieldSchema>>;
  bindings: PersonMemoryAssertionBinding[];
}

function validateClaimBinding(
  role: PersonMemoryAssertionRole,
  targetIndex: number,
  claims: PersonMemoryAssertionMatrixInput['claims'],
): string[] {
  const claim = claims[targetIndex];
  if (!claim) return [`claim target index ${targetIndex} is not present`];
  if (role === 'reported_fact' && claim.kind !== 'reported_fact') {
    return ['reported_fact binding requires a reported_fact claim'];
  }
  if (role === 'user_assessment' && claim.kind !== 'user_assessment') {
    return ['user_assessment binding requires a user_assessment claim'];
  }
  return [];
}

function validateRelationshipBinding(role: PersonMemoryAssertionRole, hasRelationship: boolean): string[] {
  return [
    ...(!hasRelationship ? ['relationship target is not present'] : []),
    ...(role !== 'reported_fact' ? ['relationship status requires reported_fact evidence'] : []),
  ];
}

function validateInteractionBinding(
  role: PersonMemoryAssertionRole,
  field: z.infer<typeof personMemoryInteractionEvidenceFieldSchema>,
  hasInteraction: boolean,
): string[] {
  if (!hasInteraction) return ['interaction target is not present'];
  const assessmentField = field === 'importanceOrTopic' || field === 'uncertaintyNotes';
  if (role === 'reported_fact' && assessmentField) {
    return [`interaction ${field} requires user_assessment evidence`];
  }
  if (role === 'user_assessment' && !assessmentField) {
    return [`user_assessment cannot support interaction ${field}`];
  }
  if (role === 'quoted_third_party' && !assessmentField) {
    return [`quoted_third_party cannot support interaction ${field}`];
  }
  return [];
}

function validateAssertionBinding(
  binding: PersonMemoryAssertionBinding,
  input: PersonMemoryAssertionMatrixInput,
): string[] {
  if (binding.role === 'agent_inference') {
    return ['agent_inference requires owner confirmation before proposal staging'];
  }
  if (binding.target.kind === 'claim') {
    return validateClaimBinding(binding.role, binding.target.index, input.claims);
  }
  if (binding.target.kind === 'relationship') {
    return validateRelationshipBinding(binding.role, input.hasRelationship);
  }
  return validateInteractionBinding(binding.role, binding.target.field, input.hasInteraction);
}

export function validatePersonMemoryAssertionMatrix(input: PersonMemoryAssertionMatrixInput): string[] {
  const errors = input.bindings.flatMap((binding) => validateAssertionBinding(binding, input));
  for (const index of input.claims.keys()) {
    if (!input.bindings.some((binding) => binding.target.kind === 'claim' && binding.target.index === index)) {
      errors.push(`claim target index ${index} requires assertion evidence`);
    }
  }
  if (input.hasRelationship && !input.bindings.some((binding) => binding.target.kind === 'relationship')) {
    errors.push('relationship status requires assertion evidence');
  }
  for (const field of input.requiredInteractionFields ?? []) {
    if (!input.bindings.some((binding) => binding.target.kind === 'interaction' && binding.target.field === field)) {
      errors.push(`interaction ${field} requires assertion evidence`);
    }
  }
  return [...new Set(errors)];
}

export type PersonMemorySourceInput = z.infer<typeof personMemorySourceInputSchema>;
export type PersonMemoryAssertionRole = z.infer<typeof personMemoryAssertionRoleSchema>;
export type PersonMemoryAssertionBinding = z.infer<typeof personMemoryAssertionBindingSchema>;
export type PersonMemorySourceBundleInput = z.infer<typeof personMemorySourceBundleInputSchema>;
export type ResolvedPersonMemorySource = z.infer<typeof resolvedPersonMemorySourceSchema>;
export type ResolvedPersonMemoryAssertionBinding = z.infer<typeof resolvedPersonMemoryAssertionBindingSchema>;
export type PersonMemoryResolvedSourceBundle = z.infer<typeof personMemoryResolvedSourceBundleSchema>;
