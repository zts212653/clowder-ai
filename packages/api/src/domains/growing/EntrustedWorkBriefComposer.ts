import type { EntrustedWorkOwnerReadV1, ProducerAttentionReceiptV1 } from '@cat-cafe/shared';

interface EntrustedWorkBriefInput {
  currentState: 'todo' | 'doing' | 'blocked';
  taskOwnerCatId?: string | null;
  ownerRef: string;
  ownerUserId: string;
  revision: number;
  intendedOutcome?: string;
  admissionReceiptRef: string;
  freshnessState: 'current' | 'stale';
  preparedArtifact: EntrustedWorkOwnerReadV1['preparedArtifact'];
  timeRefs: EntrustedWorkOwnerReadV1['timeRefs'];
  attentionReceipts: EntrustedWorkOwnerReadV1['attentionReceipts'];
}

type Brief = EntrustedWorkOwnerReadV1['brief'];
type EligibleReceipt = Extract<ProducerAttentionReceiptV1, { eligible: true }>;

export function composeEntrustedWorkBrief(input: EntrustedWorkBriefInput): EntrustedWorkOwnerReadV1['brief'] {
  const eligibleReceipts = input.attentionReceipts.filter((receipt): receipt is EligibleReceipt => receipt.eligible);
  const attentionEvidence = composeAttentionEvidence(eligibleReceipts);
  return {
    outcome: input.intendedOutcome
      ? {
          state: 'known',
          value: input.intendedOutcome,
          ownerRef: input.ownerRef,
          revision: input.revision,
        }
      : { state: 'unknown' },
    current: {
      state: input.currentState,
      ownerRef: input.ownerRef,
      revision: input.revision,
    },
    verifiedMilestone: composeVerifiedMilestone(input, eligibleReceipts),
    nextOwner: composeNextOwner(input, attentionEvidence),
    needsMe: composeNeedsMe(input, attentionEvidence),
  };
}

function composeAttentionEvidence(receipts: EligibleReceipt[]) {
  return receipts
    .map((receipt) => ({
      producerId: receipt.producer.producerId,
      ownerRef: receipt.producer.ownerRef,
      revision: receipt.producer.revision,
    }))
    .sort((left, right) =>
      [left.producerId, left.ownerRef, left.revision]
        .join('\u0000')
        .localeCompare([right.producerId, right.ownerRef, right.revision].join('\u0000')),
    );
}

function composeVerifiedMilestone(
  input: EntrustedWorkBriefInput,
  eligibleReceipts: EligibleReceipt[],
): Brief['verifiedMilestone'] {
  if (input.freshnessState === 'stale') return { kind: 'unknown', reason: 'stale_owner_read' };
  const [soleReceipt, secondReceipt] = eligibleReceipts;
  if (soleReceipt && !secondReceipt) {
    return {
      kind: 'needs_judgment',
      evidenceRef: soleReceipt.producer.ownerRef,
      revision: soleReceipt.producer.revision,
    };
  }
  if (secondReceipt) return { kind: 'unknown', reason: 'multiple_current_milestones' };
  if (input.preparedArtifact) {
    return {
      kind: 'artifact_ready',
      evidenceRef: input.preparedArtifact.completenessRef,
      revision: input.preparedArtifact.artifactRevision,
    };
  }
  const primaryTime = ['review_by', 'business_deadline', 'execution_trigger'].flatMap((role) =>
    input.timeRefs.filter((timeRef) => timeRef.role === role),
  )[0];
  if (primaryTime) {
    return {
      kind: 'time_committed',
      role: primaryTime.role,
      evidenceRef: primaryTime.ownerRef,
      revision: primaryTime.revision,
    };
  }
  return { kind: 'custody_admitted', evidenceRef: input.admissionReceiptRef, revision: input.revision };
}

function composeNextOwner(
  input: EntrustedWorkBriefInput,
  evidence: Extract<Brief['needsMe'], { state: 'needed' }>['evidence'],
): Brief['nextOwner'] {
  if (input.freshnessState === 'stale') return { kind: 'unknown' };
  if (evidence.length > 0) return { kind: 'human', ownerRef: `user:${input.ownerUserId}`, evidence };
  if (!input.taskOwnerCatId) return { kind: 'unknown' };
  return {
    kind: 'cat',
    ownerRef: `cat:${input.taskOwnerCatId}`,
    evidenceRef: input.ownerRef,
    revision: input.revision,
  };
}

function composeNeedsMe(
  input: EntrustedWorkBriefInput,
  evidence: Extract<Brief['needsMe'], { state: 'needed' }>['evidence'],
): Brief['needsMe'] {
  if (input.freshnessState === 'stale') return { state: 'unknown', reason: 'stale_owner_read' };
  if (evidence.length > 0) return { state: 'needed', evidence };
  return { state: 'not_needed', evidenceRef: input.ownerRef, revision: input.revision };
}
