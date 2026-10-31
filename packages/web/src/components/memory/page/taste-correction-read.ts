import {
  memoryOwnerRevisionSchema,
  type TasteMemoryCorrectionProposalView,
  tasteMemoryOwnerActionSchema,
} from '@cat-cafe/shared';
import { memoryObject } from './owner-memory-read';

function isTasteCorrection(value: unknown): value is TasteMemoryCorrectionProposalView {
  return (
    memoryObject(value) &&
    ['proposalId', 'sourceCatId', 'sourceThreadId'].every((key) => typeof value[key] === 'string' && !!value[key]) &&
    ['pending', 'approving', 'approved', 'rejected'].includes(String(value.status)) &&
    ['unsupported_by_source', 'outdated', 'not_applicable_here'].includes(String(value.reason)) &&
    memoryOwnerRevisionSchema.safeParse(value.expectedRevision).success &&
    tasteMemoryOwnerActionSchema.safeParse({
      action: 'correct',
      expectedRevision: value.expectedRevision,
      requestId: 'browser-read-shape-validation-only',
      patch: value.suggestedPatch,
    }).success &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    (value.rejectionReason === undefined || typeof value.rejectionReason === 'string')
  );
}

/** Preserve older read responses; never turn an invalid new suggestion projection into an empty one. */
export function hasValidTasteCorrections(value: Record<string, unknown>): value is Record<string, unknown> & {
  pendingCorrectionCount?: number;
  correctionProposals?: TasteMemoryCorrectionProposalView[];
} {
  return (
    (value.pendingCorrectionCount === undefined ||
      (Number.isSafeInteger(value.pendingCorrectionCount) && Number(value.pendingCorrectionCount) >= 0)) &&
    (value.correctionProposals === undefined ||
      (Array.isArray(value.correctionProposals) && value.correctionProposals.every(isTasteCorrection)))
  );
}
