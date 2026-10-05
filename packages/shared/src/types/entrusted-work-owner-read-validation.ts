import { z } from 'zod';
import type { EntrustedWorkOwnerReadV1 } from './entrusted-work-owner-read.js';
import {
  canonicalProducerEvidence,
  type EligibleAttentionReceipt,
  sameProducerEvidence,
  selectCanonicalOwnerTime,
} from './entrusted-work-owner-read-evidence.js';

type OwnerReadRefinementInput = EntrustedWorkOwnerReadV1;
function addBriefIssue(context: z.RefinementCtx, path: string, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path: ['brief', path], message });
}

export function validateBriefTaskCoordinates(ownerRead: OwnerReadRefinementInput, context: z.RefinementCtx): void {
  if ((ownerRead.brief.current.state === 'done') !== Boolean(ownerRead.completion)) {
    addBriefIssue(context, 'current', 'completed reads require the canonical completion evidence');
  }
  if (
    ownerRead.brief.current.ownerRef !== ownerRead.envelope.ownerRef ||
    ownerRead.brief.current.revision !== ownerRead.envelope.revision
  ) {
    addBriefIssue(context, 'current', 'brief current state must use the same Task owner coordinate');
  }
  if (
    ownerRead.brief.outcome.state === 'known' &&
    (ownerRead.brief.outcome.ownerRef !== ownerRead.envelope.ownerRef ||
      ownerRead.brief.outcome.revision !== ownerRead.envelope.revision)
  ) {
    addBriefIssue(context, 'outcome', 'brief outcome must use the same Task owner coordinate');
  }
  if (
    ownerRead.brief.nextOwner.kind === 'cat' &&
    (!ownerRead.brief.nextOwner.ownerRef.startsWith('cat:') ||
      ownerRead.brief.nextOwner.evidenceRef !== ownerRead.envelope.ownerRef ||
      ownerRead.brief.nextOwner.revision !== ownerRead.envelope.revision)
  ) {
    addBriefIssue(context, 'nextOwner', 'cat next owner must be backed by the current Task owner coordinate');
  }
}

export function validateBriefAttentionAndMilestone(
  ownerRead: OwnerReadRefinementInput,
  context: z.RefinementCtx,
): void {
  const eligibleReceipts = ownerRead.attentionReceipts.filter(
    (receipt): receipt is EligibleAttentionReceipt => receipt.eligible,
  );
  if (ownerRead.envelope.freshness.state === 'stale') {
    if (
      ownerRead.brief.needsMe.state !== 'unknown' ||
      ownerRead.brief.nextOwner.kind !== 'unknown' ||
      ownerRead.brief.verifiedMilestone.kind !== 'unknown' ||
      ownerRead.brief.verifiedMilestone.reason !== 'stale_owner_read'
    ) {
      addBriefIssue(context, 'needsMe', 'stale owner reads must fail closed to unknown attention truth');
    }
    return;
  }
  validateBriefAttention(ownerRead, eligibleReceipts, context);
  if (
    ownerRead.completion &&
    (ownerRead.attentionReceipts.length > 0 || ownerRead.brief.nextOwner.kind !== 'unknown')
  ) {
    addBriefIssue(context, 'nextOwner', 'completed history is inert and cannot expose attention or a next owner');
  }
  validateBriefMilestone(ownerRead, eligibleReceipts, context);
}

function validateBriefAttention(
  ownerRead: OwnerReadRefinementInput,
  eligibleReceipts: EligibleAttentionReceipt[],
  context: z.RefinementCtx,
): void {
  const expectedHumanOwnerRef = `user:${ownerRead.envelope.visibility.ownerUserId}`;
  const evidence = canonicalProducerEvidence(eligibleReceipts);
  if (eligibleReceipts.length > 0) {
    if (
      ownerRead.brief.needsMe.state !== 'needed' ||
      !sameProducerEvidence(ownerRead.brief.needsMe.evidence, evidence) ||
      ownerRead.brief.nextOwner.kind !== 'human' ||
      ownerRead.brief.nextOwner.ownerRef !== expectedHumanOwnerRef ||
      !sameProducerEvidence(ownerRead.brief.nextOwner.evidence, evidence)
    ) {
      addBriefIssue(
        context,
        'needsMe',
        'needed brief state must match every current eligible producer coordinate and the human next owner',
      );
    }
    return;
  }
  if (
    ownerRead.brief.needsMe.state !== 'not_needed' ||
    ownerRead.brief.needsMe.evidenceRef !== ownerRead.envelope.ownerRef ||
    ownerRead.brief.needsMe.revision !== ownerRead.envelope.revision ||
    ownerRead.brief.nextOwner.kind === 'human'
  ) {
    addBriefIssue(
      context,
      'needsMe',
      'not-needed brief state must use the current Task coordinate and cannot retain a human next owner',
    );
  }
}

function validateBriefMilestone(
  ownerRead: OwnerReadRefinementInput,
  eligibleReceipts: EligibleAttentionReceipt[],
  context: z.RefinementCtx,
): void {
  if (eligibleReceipts.length > 0) {
    validateAttentionMilestone(ownerRead, eligibleReceipts, context);
    return;
  }
  validateOwnerMilestone(ownerRead, context);
}

function validateAttentionMilestone(
  ownerRead: OwnerReadRefinementInput,
  eligibleReceipts: EligibleAttentionReceipt[],
  context: z.RefinementCtx,
): void {
  const milestone = ownerRead.brief.verifiedMilestone;
  if (eligibleReceipts.length === 1) {
    const [eligibleReceipt] = eligibleReceipts;
    if (
      !eligibleReceipt ||
      milestone.kind !== 'needs_judgment' ||
      milestone.evidenceRef !== eligibleReceipt.producer.ownerRef ||
      milestone.revision !== eligibleReceipt.producer.revision
    ) {
      addBriefIssue(context, 'verifiedMilestone', 'judgment milestone must match the sole eligible producer receipt');
    }
    return;
  }
  if (milestone.kind !== 'unknown' || milestone.reason !== 'multiple_current_milestones') {
    addBriefIssue(context, 'verifiedMilestone', 'multiple producer milestones must remain explicitly ambiguous');
  }
}

function validateOwnerMilestone(ownerRead: OwnerReadRefinementInput, context: z.RefinementCtx): void {
  const milestone = ownerRead.brief.verifiedMilestone;
  if (ownerRead.completion) {
    if (
      milestone.kind !== 'work_completed' ||
      milestone.evidenceRef !== ownerRead.envelope.ownerRef ||
      milestone.revision !== ownerRead.envelope.revision
    ) {
      addBriefIssue(context, 'verifiedMilestone', 'completed milestone must match the closed Task coordinate');
    }
    return;
  }
  if (ownerRead.preparedArtifact) {
    if (
      milestone.kind !== 'artifact_ready' ||
      milestone.evidenceRef !== ownerRead.preparedArtifact.completenessRef ||
      milestone.revision !== ownerRead.preparedArtifact.artifactRevision
    ) {
      addBriefIssue(
        context,
        'verifiedMilestone',
        'Artifact milestone must match the prepared Artifact owner coordinate',
      );
    }
    return;
  }
  const primaryTime = selectCanonicalOwnerTime(ownerRead.timeRefs);
  if (primaryTime) {
    if (
      milestone.kind !== 'time_committed' ||
      milestone.role !== primaryTime.role ||
      milestone.evidenceRef !== primaryTime.ownerRef ||
      milestone.revision !== primaryTime.revision
    ) {
      addBriefIssue(context, 'verifiedMilestone', 'time milestone must match the canonical typed Task time coordinate');
    }
    return;
  }
  if (
    milestone.kind !== 'custody_admitted' ||
    milestone.evidenceRef !== ownerRead.envelope.admissionReceiptRef ||
    milestone.revision !== ownerRead.envelope.revision
  ) {
    addBriefIssue(context, 'verifiedMilestone', 'custody milestone must match the canonical Task admission receipt');
  }
}
