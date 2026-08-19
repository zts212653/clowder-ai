import { randomBytes } from 'node:crypto';
import {
  buildHumanDispositionLedgerEntry,
  type HumanDispositionFeedbackInput,
  type HumanDispositionLedgerEntry,
  type UserCancelWaitTerminationEventV1,
  userCancelWaitTerminationEventSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';

const OPAQUE_RANDOM_BYTES = 32;
const OPAQUE_RANDOM_TEXT = '[A-Za-z0-9_-]{43}';

const sessionHandoffCanonicalProposalSchema = z
  .object({
    proposalId: z.string().trim().min(1).max(120),
    sourceSessionId: z.string().trim().min(1).max(120),
    sourceCatId: z.string().trim().min(1).max(120),
    userId: z.string().trim().min(1).max(120),
  })
  .strict();

const personMemoryCanonicalStateSchema = z
  .object({
    ownerUserId: z.string().trim().min(1).max(120),
    requesterCatId: z.string().trim().min(1).max(120),
  })
  .strict();

function opaqueHandleSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}${OPAQUE_RANDOM_TEXT}$`));
}

export const personMemoryDispositionOpaqueProofSchema = z
  .object({
    opaqueLineageHandle: opaqueHandleSchema('f281_lineage_'),
    opaqueProposalHandle: opaqueHandleSchema('f281_proposal_'),
    opaqueSupersessionHandle: opaqueHandleSchema('f281_supersession_'),
    opaqueDecisionReceiptHandle: opaqueHandleSchema('f281_receipt_'),
  })
  .strict();

export type PersonMemoryDispositionOpaqueProof = z.infer<typeof personMemoryDispositionOpaqueProofSchema>;

export interface SessionHandoffDispositionAdapterInput {
  proposal: z.input<typeof sessionHandoffCanonicalProposalSchema>;
  decidedAt: number;
  feedback?: HumanDispositionFeedbackInput;
}

export interface PersonMemoryDispositionAdapterInput {
  canonical: z.input<typeof personMemoryCanonicalStateSchema>;
  proof: PersonMemoryDispositionOpaqueProof;
  decidedAt: number;
  feedback?: HumanDispositionFeedbackInput;
}

export interface WaitCancellationDispositionAdapterInput {
  event: UserCancelWaitTerminationEventV1;
  feedback?: HumanDispositionFeedbackInput;
}

export type HumanDispositionRandomBytesSource = (size: number) => Uint8Array;

function mintOpaqueHandle(prefix: string, randomBytesSource: HumanDispositionRandomBytesSource): string {
  const bytes = randomBytesSource(OPAQUE_RANDOM_BYTES);
  if (bytes.byteLength !== OPAQUE_RANDOM_BYTES) {
    throw new Error(`human-disposition RNG must return exactly ${OPAQUE_RANDOM_BYTES} bytes`);
  }
  return `${prefix}${Buffer.from(bytes).toString('base64url')}`;
}

export function mintPersonMemoryDispositionOpaqueProof(
  randomBytesSource: HumanDispositionRandomBytesSource = (size) => randomBytes(size),
): PersonMemoryDispositionOpaqueProof {
  return personMemoryDispositionOpaqueProofSchema.parse({
    opaqueLineageHandle: mintOpaqueHandle('f281_lineage_', randomBytesSource),
    opaqueProposalHandle: mintOpaqueHandle('f281_proposal_', randomBytesSource),
    opaqueSupersessionHandle: mintOpaqueHandle('f281_supersession_', randomBytesSource),
    opaqueDecisionReceiptHandle: mintOpaqueHandle('f281_receipt_', randomBytesSource),
  });
}

export function buildSessionHandoffDispositionLedgerEntry(
  input: SessionHandoffDispositionAdapterInput,
): HumanDispositionLedgerEntry {
  const proposal = sessionHandoffCanonicalProposalSchema.parse({
    proposalId: input.proposal.proposalId,
    sourceSessionId: input.proposal.sourceSessionId,
    sourceCatId: input.proposal.sourceCatId,
    userId: input.proposal.userId,
  });
  return buildHumanDispositionLedgerEntry(input.feedback, {
    interactionKind: 'session_handoff',
    subjectRef: proposal.sourceSessionId,
    proposalId: proposal.proposalId,
    decision: 'rejected',
    producerCatId: proposal.sourceCatId,
    ownerUserId: proposal.userId,
    decidedAt: input.decidedAt,
    scope: { kind: 'exact_subject' },
    expiry: { kind: 'none' },
    invalidator: { kind: 'none' },
    sourceRef: `F225:session-handoff:${proposal.proposalId}:reject`,
  });
}

export function buildPersonMemoryDispositionLedgerEntry(
  input: PersonMemoryDispositionAdapterInput,
): HumanDispositionLedgerEntry {
  const canonical = personMemoryCanonicalStateSchema.parse({
    ownerUserId: input.canonical.ownerUserId,
    requesterCatId: input.canonical.requesterCatId,
  });
  const proof = personMemoryDispositionOpaqueProofSchema.parse(input.proof);
  return buildHumanDispositionLedgerEntry(input.feedback, {
    interactionKind: 'person_memory_proposal',
    subjectRef: proof.opaqueLineageHandle,
    proposalId: proof.opaqueProposalHandle,
    decision: 'rejected',
    producerCatId: canonical.requesterCatId,
    ownerUserId: canonical.ownerUserId,
    decidedAt: input.decidedAt,
    scope: { kind: 'proposal_lineage', rootProposalId: proof.opaqueLineageHandle },
    expiry: { kind: 'none' },
    invalidator: {
      kind: 'source_superseded',
      supersessionKey: proof.opaqueSupersessionHandle,
    },
    sourceRef: proof.opaqueDecisionReceiptHandle,
  });
}

export function buildWaitCancellationDispositionLedgerEntry(
  input: WaitCancellationDispositionAdapterInput,
): HumanDispositionLedgerEntry {
  const event = userCancelWaitTerminationEventSchema.parse(input.event);
  return buildHumanDispositionLedgerEntry(input.feedback, {
    interactionKind: 'wait_cancel',
    subjectRef: event.subjectRef,
    decision: 'cancelled',
    producerCatId: event.ownerCatId,
    ownerUserId: event.ownerUserId,
    decidedAt: event.at,
    scope: { kind: 'exact_subject' },
    expiry: { kind: 'none' },
    invalidator: { kind: 'none' },
    sourceRef: event.eventId,
  });
}
