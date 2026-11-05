import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveArtifactCustodyTransfer,
  type CollectiveCustodyPrepared,
  collectiveCustodyTransferSchema,
} from '@cat-cafe/shared';
import type { CollectiveCustodyFenceBinding } from '../../video-studio/content-owner/collective-custody-fence.js';
import type { CollectiveContentScopeV1 } from '../../video-studio/content-owner/collective-scope.js';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import type { WorkspaceContentReviewStore } from '../workspace-review/store.js';
import type { CollectiveArtifactCustodyBundle } from './custody-bundle.js';
import { type CollectiveCustodyJournalEntry, transferIdentity } from './custody-journal.js';
import type { CollectiveCustodyOwnerAuthority, CollectiveCustodyOwnerOperation } from './owner-port.js';
import type { CollectiveArtifactScopeQueue } from './scope-serial-queue.js';

export interface CollectiveCustodyOwners {
  owner: ProjectContentOwnerService;
  reviews: WorkspaceContentReviewStore;
  modifications: ArtifactReviewStore;
  ownerUserId: string;
  scopeQueue: CollectiveArtifactScopeQueue;
}
export async function authorizeTransfer(
  input: CollectiveArtifactCustodyTransfer,
  authority: CollectiveCustodyOwnerAuthority,
  operation: CollectiveCustodyOwnerOperation,
) {
  const fresh = collectiveCustodyTransferSchema.parse(await authority.authorize(operation));
  if (transferIdentity(fresh) !== transferIdentity(collectiveCustodyTransferSchema.parse(input)))
    throw new Error('Collective transfer authority changed');
  return fresh;
}
export function custodyFenceBinding(
  transfer: CollectiveArtifactCustodyTransfer,
  scopeRef: string,
  target = false,
): CollectiveCustodyFenceBinding {
  return {
    contentRef: transfer.version.contentRef,
    scopeRef,
    transferId: transfer.transferId,
    custodyRevision: transfer.expectedCustodyRevision + (target ? 1 : 0),
  };
}
export function preparedProof(entry: CollectiveCustodyJournalEntry): CollectiveCustodyPrepared {
  return {
    preparedRef: entry.preparedRef,
    manifest: entry.manifest,
    version: entry.transfer.version,
    ownerScopeRef: entry.scopeRef,
  };
}
export function requirePrepared(entry: CollectiveCustodyJournalEntry, transfer: CollectiveArtifactCustodyTransfer) {
  if (!isDeepStrictEqual(transfer.prepared, preparedProof(entry))) throw new Error('Collective prepared proof changed');
}
export function assertTransferBundle(
  transfer: CollectiveArtifactCustodyTransfer,
  bundle: CollectiveArtifactCustodyBundle,
) {
  const scope = bundle.content.manifest.collectiveScope;
  assertTransferScope(transfer, scope);
  const receipt = bundle.content.manifest.receipts.at(-1);
  if (
    !receipt ||
    receipt.contentRef !== transfer.version.contentRef ||
    receipt.ownerRevision !== transfer.version.ownerRevision ||
    receipt.blobDigest !== transfer.version.blobDigest ||
    receipt.receiptId !== transfer.version.receiptRef
  )
    throw new Error('Collective transfer owner tuple changed');
}
export function assertTransferScope(transfer: CollectiveArtifactCustodyTransfer, scope: CollectiveContentScopeV1) {
  if (
    scope.contentRef !== transfer.version.contentRef ||
    scope.serviceInstanceId !== transfer.serviceInstanceId ||
    scope.collectiveId !== transfer.collectiveId ||
    scope.artifactId !== transfer.artifactId ||
    scope.sourceEventId !== transfer.sourceEventId ||
    scope.publishedByHumanId !== transfer.publishedByHumanId
  )
    throw new Error('Collective transfer owner scope mismatch');
}
export function transferProofRef(kind: 'prepared' | 'ready', values: unknown[]): string {
  return `custody-${kind}:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}
