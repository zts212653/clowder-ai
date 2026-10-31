import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { TasteProposal } from '@cat-cafe/shared';
import { TasteWriteConflictError, type VignetteWriterFn } from '../../taste/services/approveTasteProposal.js';
import type { TasteMemoryLifecycleService } from './TasteMemoryLifecycleService.js';
import { sourcePathFromTasteAnchor } from './taste-memory-identity.js';

export function createTasteProposalWriter(
  createVignette: VignetteWriterFn,
  lifecycle: Pick<TasteMemoryLifecycleService, 'applyApprovedCorrectionUnderTargetLock'>,
): VignetteWriterFn {
  return async (proposal: TasteProposal) => {
    const target = proposal.correctionTarget;
    if (!target) return createVignette(proposal);
    const sourcePath = sourcePathFromTasteAnchor(target.sourceAnchor);
    if (!sourcePath) throw new TasteWriteConflictError('not_available');
    const result = await lifecycle.applyApprovedCorrectionUnderTargetLock({
      ownerUserId: proposal.userId,
      sourcePath,
      expectedRevision: target.expectedRevision,
      patch: target.suggestedPatch,
      requestId: correctionRequestId(proposal.id),
    });
    if ('error' in result) throw new TasteWriteConflictError(result.error);
    return { slug: posix.basename(sourcePath, '.md'), path: sourcePath };
  };
}

function correctionRequestId(proposalId: string): string {
  const digest = createHash('sha256').update(proposalId).digest('hex');
  return `taste-correction-${digest}`;
}
