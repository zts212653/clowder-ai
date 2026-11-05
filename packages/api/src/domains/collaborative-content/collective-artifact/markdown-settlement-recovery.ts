import { isDeepStrictEqual } from 'node:util';
import { collectiveContentScopeRef } from '../../video-studio/content-owner/collective-scope.js';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { ContentSettlementReceiptV1 } from '../../video-studio/content-owner/types.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { AdmittedCollectiveMarkdown } from './markdown-authority.js';
import { reconcileCollectiveDisposition } from './markdown-modification-apply.js';

type Stores = { owner: ProjectContentOwnerService; modifications: ArtifactReviewStore; ownerUserId: string };

/** Content-free historical evidence from the canonical owner, never a new adoption by the reader. */
export async function recoverCollectiveSettlements(admitted: AdmittedCollectiveMarkdown, stores: Stores) {
  const catalogueRevision = admitted.constraint.catalogueOwnerRevision;
  if (
    admitted.constraint.agent ||
    !['read', 'history'].includes(admitted.constraint.action) ||
    catalogueRevision === undefined ||
    admitted.content.currentOwnerRevision <= catalogueRevision
  )
    return undefined;
  const scopeRef = collectiveContentScopeRef(admitted.scope);
  const receipts = (await stores.owner.listOutbox(admitted.content.contentRef))
    .filter((receipt) => receipt.ownerRevision > catalogueRevision)
    .slice(0, 30);
  const settlements = [];
  for (const receipt of receipts) {
    const next = await recoverReceipt(admitted, stores, receipt, scopeRef);
    if (Buffer.byteLength(JSON.stringify({ v: 1, settlements: [...settlements, next] })) > 64 * 1024) break;
    settlements.push(next);
  }
  await admitted.authorize();
  return settlements.length ? { v: 1 as const, settlements } : undefined;
}

async function recoverReceipt(
  admitted: AdmittedCollectiveMarkdown,
  stores: Stores,
  receipt: ContentSettlementReceiptV1,
  scopeRef: string,
) {
  const context = receipt.operationContext;
  if (context?.kind !== 'collective-artifact:apply' || context.scopeRef !== scopeRef)
    throw new WorkspaceContentReviewError('source_changed');
  let disposition = stores.modifications.acceptances.collective.forOwnerReceipt(
    stores.ownerUserId,
    context.dispositionId,
    scopeRef,
  );
  if (disposition?.state === 'pending') {
    await admitted.authorize();
    await stores.owner.collectiveCustody.fence.assertEffectAvailable(
      receipt.contentRef,
      scopeRef,
      admitted.constraint.custodyRevision,
    );
    disposition = (await reconcileCollectiveDisposition(disposition.intent, stores)) ?? null;
  }
  if (disposition?.state !== 'accepted' || !isDeepStrictEqual(disposition.receipt, receipt))
    throw new WorkspaceContentReviewError('source_changed');
  const request = stores.modifications.requests.collective.get(disposition.intent.requestId, scopeRef);
  if (!request || request.state !== 'accepted') throw new WorkspaceContentReviewError('source_changed');
  return {
    state: 'accepted' as const,
    receipt,
    lineage: {
      requestId: request.requestId,
      requestEventId: request.source.requestEventId,
      proposalRef: disposition.intent.candidateRef,
      sourceEventId: request.source.sourceEventId,
      sourceOwnerRevision: request.source.ownerRevision,
      location: request.source.location,
    },
  };
}
