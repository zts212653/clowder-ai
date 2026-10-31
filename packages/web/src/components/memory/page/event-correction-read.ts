import {
  type EventMemoryCorrectionProposalView,
  eventMemoryOwnerActionSchema,
  memoryOwnerRevisionSchema,
} from '@cat-cafe/shared';

const memoryObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function isEventCorrection(value: unknown): value is EventMemoryCorrectionProposalView {
  if (!memoryObject(value) || !memoryObject(value.source)) return false;
  const strings = ['proposalId', 'sourceCatId', 'sourceThreadId'] as const;
  return (
    strings.every((key) => typeof value[key] === 'string' && !!value[key]) &&
    ['pending', 'approving', 'approved', 'rejected'].includes(String(value.status)) &&
    ['unsupported_by_source', 'outdated', 'not_applicable_here'].includes(String(value.reason)) &&
    memoryOwnerRevisionSchema.safeParse(value.expectedRevision).success &&
    eventMemoryOwnerActionSchema.safeParse({
      action: 'correct',
      expectedRevision: value.expectedRevision,
      requestId: 'browser-read-shape-validation-only',
      patch: value.suggestedPatch,
    }).success &&
    typeof value.source.threadId === 'string' &&
    !!value.source.threadId &&
    typeof value.source.messageId === 'string' &&
    !!value.source.messageId &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    (value.rejectionReason === undefined || typeof value.rejectionReason === 'string') &&
    (value.appliedRevision === undefined || memoryOwnerRevisionSchema.safeParse(value.appliedRevision).success)
  );
}

/** Older Event reads remain readable; an invalid new projection is never treated as zero suggestions. */
export function hasValidEventCorrections(value: Record<string, unknown>): value is Record<string, unknown> & {
  pendingCorrectionCount?: number;
  correctionProposals?: EventMemoryCorrectionProposalView[];
} {
  return (
    (value.pendingCorrectionCount === undefined ||
      (Number.isSafeInteger(value.pendingCorrectionCount) && Number(value.pendingCorrectionCount) >= 0)) &&
    (value.correctionProposals === undefined ||
      (Array.isArray(value.correctionProposals) && value.correctionProposals.every(isEventCorrection)))
  );
}

export function eventCorrectionProjection(value: Record<string, unknown>) {
  if (!hasValidEventCorrections(value)) throw new Error('Invalid Event correction projection');
  return {
    ...(value.pendingCorrectionCount !== undefined ? { pendingCorrectionCount: value.pendingCorrectionCount } : {}),
    ...(value.correctionProposals !== undefined ? { correctionProposals: value.correctionProposals } : {}),
  };
}
