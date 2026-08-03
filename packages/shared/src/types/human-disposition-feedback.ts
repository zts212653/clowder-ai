import { z } from 'zod';

export const HUMAN_DISPOSITION_REASON_CODES = [
  'not_important',
  'wrong_lane',
  'bad_evidence',
  'not_now',
  'wrong',
  'other',
] as const;

export type HumanDispositionReasonCode = (typeof HUMAN_DISPOSITION_REASON_CODES)[number];

export const HUMAN_DISPOSITION_REASON_CORRECTIONS = {
  not_important: { correctionDirection: 'dormant_exact_subject', autoInject: true },
  wrong_lane: { correctionDirection: 'reroute_exact_subject', autoInject: true },
  bad_evidence: { correctionDirection: 'repair_exact_subject_evidence', autoInject: true },
  not_now: { correctionDirection: 'defer_exact_subject', autoInject: true },
  wrong: { correctionDirection: 'correct_exact_subject', autoInject: true },
  other: { correctionDirection: 'human_review_only', autoInject: false },
} as const satisfies Record<HumanDispositionReasonCode, { correctionDirection: string; autoInject: boolean }>;

const referenceSchema = z.string().trim().min(1).max(500);
const identitySchema = z.string().trim().min(1).max(120);

export const humanDispositionInteractionKindSchema = z.string().trim().min(1).max(120);
export const humanDispositionDecisionSchema = z.enum(['rejected', 'cancelled', 'not_now', 'withdrawn']);
export type HumanDispositionInteractionKind = z.infer<typeof humanDispositionInteractionKindSchema>;
export type HumanDispositionDecision = z.infer<typeof humanDispositionDecisionSchema>;
export type HumanDispositionSourceRef = z.infer<typeof referenceSchema>;

export const humanDispositionFeedbackInputSchema = z.discriminatedUnion('reasonCode', [
  z.object({ reasonCode: z.literal('not_important') }).strict(),
  z.object({ reasonCode: z.literal('wrong_lane') }).strict(),
  z.object({ reasonCode: z.literal('bad_evidence') }).strict(),
  z.object({ reasonCode: z.literal('not_now') }).strict(),
  z.object({ reasonCode: z.literal('wrong') }).strict(),
  z.object({ reasonCode: z.literal('other'), detail: z.string().trim().min(1).max(500) }).strict(),
]);

export type HumanDispositionFeedbackInput = z.infer<typeof humanDispositionFeedbackInputSchema>;

export const humanDispositionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact_subject') }).strict(),
  z.object({ kind: z.literal('proposal_lineage'), rootProposalId: referenceSchema }).strict(),
]);

export const humanDispositionExpirySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('at'), expiresAt: z.number().finite().nonnegative() }).strict(),
]);

export const humanDispositionInvalidatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('subject_revision'), expectedRevisionRef: referenceSchema }).strict(),
  z.object({ kind: z.literal('source_superseded'), supersessionKey: referenceSchema }).strict(),
]);

export const humanDispositionLineageTruthSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_applicable') }).strict(),
  z.object({ status: z.literal('verified'), rootProposalId: referenceSchema }).strict(),
  z.object({ status: z.literal('unknown') }).strict(),
]);

export const humanDispositionInvalidatorTruthSchema = z.union([
  z.object({ kind: z.literal('none'), status: z.literal('not_applicable') }).strict(),
  z
    .object({
      kind: z.literal('subject_revision'),
      status: z.literal('verified'),
      currentRevisionRef: referenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal('subject_revision'), status: z.literal('unknown') }).strict(),
  z
    .object({
      kind: z.literal('source_superseded'),
      status: z.literal('verified'),
      supersessionKey: referenceSchema,
      superseded: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('source_superseded'), status: z.literal('unknown') }).strict(),
]);

export type HumanDispositionScope = z.infer<typeof humanDispositionScopeSchema>;
export type HumanDispositionExpiry = z.infer<typeof humanDispositionExpirySchema>;
export type HumanDispositionInvalidator = z.infer<typeof humanDispositionInvalidatorSchema>;
export type HumanDispositionLineageTruth = z.infer<typeof humanDispositionLineageTruthSchema>;
export type HumanDispositionInvalidatorTruth = z.infer<typeof humanDispositionInvalidatorTruthSchema>;

const serverBindingShape = {
  interactionKind: humanDispositionInteractionKindSchema,
  subjectRef: referenceSchema,
  proposalId: referenceSchema.optional(),
  decision: humanDispositionDecisionSchema,
  producerCatId: identitySchema,
  ownerUserId: identitySchema,
  decidedAt: z.number().finite().nonnegative(),
  scope: humanDispositionScopeSchema,
  expiry: humanDispositionExpirySchema,
  invalidator: humanDispositionInvalidatorSchema,
  sourceRef: referenceSchema,
};

export const humanDispositionServerBindingSchema = z.object(serverBindingShape).strict();
export const humanDispositionDecisionEpisodeSchema = z
  .object({
    interactionKind: serverBindingShape.interactionKind,
    subjectRef: serverBindingShape.subjectRef,
    proposalId: serverBindingShape.proposalId,
    decision: serverBindingShape.decision,
    producerCatId: serverBindingShape.producerCatId,
    ownerUserId: serverBindingShape.ownerUserId,
    decidedAt: serverBindingShape.decidedAt,
    sourceRef: serverBindingShape.sourceRef,
    feedback: humanDispositionFeedbackInputSchema.optional(),
  })
  .strict();
export const humanDispositionEnvelopeSchema = z
  .object({ ...serverBindingShape, feedback: humanDispositionFeedbackInputSchema })
  .strict();

const humanDispositionLedgerReceiptShape = {
  sourceRef: serverBindingShape.sourceRef,
  subjectRef: serverBindingShape.subjectRef,
  interactionKind: serverBindingShape.interactionKind,
  decidedAt: serverBindingShape.decidedAt,
};

export const humanDispositionLedgerReceiptSchema = z.object(humanDispositionLedgerReceiptShape).strict();

export const humanDispositionLedgerEntrySchema = z
  .object({
    episode: humanDispositionDecisionEpisodeSchema,
    envelope: humanDispositionEnvelopeSchema.optional(),
  })
  .strict()
  .superRefine(({ episode, envelope }, context) => {
    if (!envelope) {
      if (episode.feedback !== undefined) {
        context.addIssue({ code: 'custom', message: 'episode feedback requires an envelope', path: ['episode'] });
      }
      return;
    }
    const expectedEpisode = humanDispositionDecisionEpisodeSchema.parse({
      interactionKind: envelope.interactionKind,
      subjectRef: envelope.subjectRef,
      ...(envelope.proposalId === undefined ? {} : { proposalId: envelope.proposalId }),
      decision: envelope.decision,
      producerCatId: envelope.producerCatId,
      ownerUserId: envelope.ownerUserId,
      decidedAt: envelope.decidedAt,
      sourceRef: envelope.sourceRef,
      feedback: envelope.feedback,
    });
    if (JSON.stringify(episode) !== JSON.stringify(expectedEpisode)) {
      context.addIssue({ code: 'custom', message: 'episode and envelope identity must match', path: ['envelope'] });
    }
  });

export const humanDispositionEligibilityContextSchema = z
  .object({
    subjectRef: referenceSchema,
    proposalLineage: humanDispositionLineageTruthSchema,
    now: z.number().finite().nonnegative(),
    invalidatorTruth: humanDispositionInvalidatorTruthSchema,
  })
  .strict();

export type HumanDispositionServerBinding = z.infer<typeof humanDispositionServerBindingSchema>;
export type HumanDispositionDecisionEpisode = z.infer<typeof humanDispositionDecisionEpisodeSchema>;
export type HumanDispositionEnvelope = z.infer<typeof humanDispositionEnvelopeSchema>;
export type HumanDispositionEligibilityContext = z.infer<typeof humanDispositionEligibilityContextSchema>;
export type HumanDispositionLedgerEntry = z.infer<typeof humanDispositionLedgerEntrySchema>;
export type HumanDispositionLedgerReceipt = z.infer<typeof humanDispositionLedgerReceiptSchema>;
export type HumanDispositionSourceReplay = 'distinct' | 'replay' | 'conflict';
export type HumanDispositionFeedbackReplay = 'replay' | 'conflict';

export function buildHumanDispositionEnvelope(
  feedbackInput: HumanDispositionFeedbackInput | undefined,
  serverBinding: HumanDispositionServerBinding,
): HumanDispositionEnvelope | null {
  if (!feedbackInput) return null;
  return humanDispositionEnvelopeSchema.parse({
    ...humanDispositionServerBindingSchema.parse(serverBinding),
    feedback: humanDispositionFeedbackInputSchema.parse(feedbackInput),
  });
}

export function buildHumanDispositionLedgerEntry(
  feedbackInput: HumanDispositionFeedbackInput | undefined,
  serverBinding: HumanDispositionServerBinding,
): HumanDispositionLedgerEntry {
  const currentBinding = humanDispositionServerBindingSchema.parse(serverBinding);
  const feedback = feedbackInput === undefined ? undefined : humanDispositionFeedbackInputSchema.parse(feedbackInput);
  const episode = humanDispositionDecisionEpisodeSchema.parse({
    interactionKind: currentBinding.interactionKind,
    subjectRef: currentBinding.subjectRef,
    ...(currentBinding.proposalId === undefined ? {} : { proposalId: currentBinding.proposalId }),
    decision: currentBinding.decision,
    producerCatId: currentBinding.producerCatId,
    ownerUserId: currentBinding.ownerUserId,
    decidedAt: currentBinding.decidedAt,
    sourceRef: currentBinding.sourceRef,
    ...(feedback === undefined ? {} : { feedback }),
  });
  const envelope = buildHumanDispositionEnvelope(feedback, currentBinding);
  return humanDispositionLedgerEntrySchema.parse({
    episode,
    ...(envelope === null ? {} : { envelope }),
  });
}

export function buildHumanDispositionLedgerReceipt(entry: HumanDispositionLedgerEntry): HumanDispositionLedgerReceipt {
  const currentEntry = humanDispositionLedgerEntrySchema.parse(entry);
  return humanDispositionLedgerReceiptSchema.parse({
    sourceRef: currentEntry.episode.sourceRef,
    subjectRef: currentEntry.episode.subjectRef,
    interactionKind: currentEntry.episode.interactionKind,
    decidedAt: currentEntry.episode.decidedAt,
  });
}

export function classifyHumanDispositionSourceReplay(
  existing: HumanDispositionEnvelope,
  incoming: HumanDispositionEnvelope,
): HumanDispositionSourceReplay {
  const current = humanDispositionEnvelopeSchema.safeParse(existing);
  const replay = humanDispositionEnvelopeSchema.safeParse(incoming);
  if (!current.success || !replay.success) return 'conflict';
  if (current.data.sourceRef !== replay.data.sourceRef) return 'distinct';
  return JSON.stringify(current.data) === JSON.stringify(replay.data) ? 'replay' : 'conflict';
}

export function classifyHumanDispositionFeedbackReplay(
  existing: unknown,
  incoming: unknown,
): HumanDispositionFeedbackReplay {
  const current = humanDispositionFeedbackInputSchema.optional().safeParse(existing);
  const replay = humanDispositionFeedbackInputSchema.optional().safeParse(incoming);
  if (!current.success || !replay.success) return 'conflict';
  return JSON.stringify(current.data) === JSON.stringify(replay.data) ? 'replay' : 'conflict';
}

function hasVerifiedLineage(scope: HumanDispositionScope, context: HumanDispositionEligibilityContext): boolean {
  return (
    scope.kind === 'exact_subject' ||
    (context.proposalLineage.status === 'verified' && context.proposalLineage.rootProposalId === scope.rootProposalId)
  );
}

function isInvalidatorCurrent(
  invalidator: HumanDispositionInvalidator,
  truth: HumanDispositionInvalidatorTruth,
): boolean {
  if (invalidator.kind === 'none') return truth.kind === 'none' && truth.status === 'not_applicable';
  if (invalidator.kind === 'subject_revision') {
    return (
      truth.kind === 'subject_revision' &&
      truth.status === 'verified' &&
      truth.currentRevisionRef === invalidator.expectedRevisionRef
    );
  }
  return (
    truth.kind === 'source_superseded' &&
    truth.status === 'verified' &&
    truth.supersessionKey === invalidator.supersessionKey &&
    !truth.superseded
  );
}

export function isHumanDispositionEnvelopeEligible(
  envelope: HumanDispositionEnvelope,
  context: HumanDispositionEligibilityContext,
): boolean {
  const parsedEnvelope = humanDispositionEnvelopeSchema.safeParse(envelope);
  const parsedContext = humanDispositionEligibilityContextSchema.safeParse(context);
  if (!parsedEnvelope.success || !parsedContext.success || !Number.isFinite(parsedContext.data.now)) return false;

  const currentEnvelope = parsedEnvelope.data;
  const currentContext = parsedContext.data;
  if (
    !HUMAN_DISPOSITION_REASON_CORRECTIONS[currentEnvelope.feedback.reasonCode].autoInject ||
    currentEnvelope.subjectRef !== currentContext.subjectRef
  ) {
    return false;
  }
  if (!hasVerifiedLineage(currentEnvelope.scope, currentContext)) return false;
  if (currentEnvelope.expiry.kind === 'at' && currentContext.now >= currentEnvelope.expiry.expiresAt) return false;
  return isInvalidatorCurrent(currentEnvelope.invalidator, currentContext.invalidatorTruth);
}
