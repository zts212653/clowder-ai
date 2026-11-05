import { type CollectiveModificationRecord, collectiveArtifactControlSchema } from '@cat-cafe/shared';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { AdmittedCollectiveMarkdown } from './markdown-authority.js';
import { reconcileCollectiveDisposition } from './markdown-modification-apply.js';
import { projectCollectiveModification } from './markdown-modification-request.js';

/** Ends only this request. It never claims to stop a remote invocation or undo an owner revision. */
export async function controlCollectiveModification(
  admitted: AdmittedCollectiveMarkdown,
  request: CollectiveModificationRecord,
  unsafe: unknown,
  stores: { owner: ProjectContentOwnerService; modifications: ArtifactReviewStore },
) {
  const input = collectiveArtifactControlSchema.parse(unsafe);
  const action = admitted.constraint.action;
  if (admitted.constraint.agent || !['cancel', 'reject'].includes(action))
    throw new WorkspaceContentReviewError('access_denied');
  if (action === 'cancel' && ![request.requestingHumanId, request.target.humanId].includes(admitted.constraint.humanId))
    throw new WorkspaceContentReviewError('access_denied');
  await admitted.authorize();
  const acceptances = stores.modifications.acceptances.collective;
  const winner = acceptances.winner(request.requestId, request.source.scopeRef);
  if (winner?.state === 'pending') await reconcileCollectiveDisposition(winner.intent, stores);
  await admitted.authorize();
  const current = stores.modifications.requests.collective.get(request.requestId, request.source.scopeRef);
  if (!current) throw new WorkspaceContentReviewError('source_changed');
  if (current.state === 'accepted') return { request: projectControlledRequest(current, stores.modifications) };
  const resolved = stores.modifications.requests.collective.resolve({
    ...input,
    scopeRef: request.source.scopeRef,
    operationId: admitted.operationId,
    actorHumanId: admitted.constraint.humanId,
    kind: action === 'cancel' ? 'cancelled' : 'rejected',
  });
  return { request: projectControlledRequest(resolved, stores.modifications) };
}

function projectControlledRequest(record: CollectiveModificationRecord, store: ArtifactReviewStore) {
  const candidate = store.text.latestProposal(record.requestId);
  return {
    ...projectCollectiveModification(record),
    latestProposalRevision: candidate?.revision ?? 0,
    ...(candidate ? { latestProposalRef: candidate.proposalRef } : {}),
  };
}
