import { memoryOwnerRevisionSchema } from '@cat-cafe/shared';
import { lookupDisplayedSettled, lookupSettled } from '@/components/shell/mailbox/settled-lookup';
import { apiFetch } from '@/utils/api-client';
import { isEventCorrection } from './event-correction-read';
import { memoryObject } from './owner-memory-read';
import { type CorrectionCoordinate, readCorrectionOwner } from './read-correction-approval';

export function correctionEffectConfirmed(value: unknown, proposalId: string): boolean {
  return (
    memoryObject(value) &&
    isEventCorrection(value.proposal) &&
    value.proposal.proposalId === proposalId &&
    value.proposal.status === 'approved' &&
    memoryOwnerRevisionSchema.safeParse(value.proposal.appliedRevision).success
  );
}

/** The original producer's finalized revision is an effect witness only after the exact owner/publication has settled. */
export async function readCorrectionResult(
  proposalId: string,
  coordinate: CorrectionCoordinate,
  expectedOwner?: string,
  display = false,
) {
  const ownerUserId = await readCorrectionOwner();
  if (!ownerUserId || (expectedOwner && ownerUserId !== expectedOwner)) return null;
  const result = await (display ? lookupDisplayedSettled : lookupSettled)({
    ownerUserId,
    sourceFeatureId: 'F321',
    proposalId,
    approvalCardRef: coordinate,
  });
  if (result.kind !== 'found') return null;
  let effect = false;
  if (result.terminal.resolution === 'accepted') {
    const response = await apiFetch(
      `/api/event-memory-corrections/${encodeURIComponent(proposalId)}`,
      {},
      { afterCurrentGet: true },
    );
    effect = response.ok && correctionEffectConfirmed(await response.json(), proposalId);
  }
  return {
    ownerUserId,
    terminal: {
      ...result.terminal,
      ...(!effect && result.terminal.resolution === 'accepted' ? { effectUnknown: true } : {}),
    },
    effect,
  };
}
