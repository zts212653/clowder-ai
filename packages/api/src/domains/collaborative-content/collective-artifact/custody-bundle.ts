import { isDeepStrictEqual } from 'node:util';
import { COLLECTIVE_CUSTODY_MAX_BYTES } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  type CollectiveContentSnapshot,
  validateCollectiveContentSnapshot,
} from '../../video-studio/content-owner/collective-snapshot.js';
import {
  type CollectiveModificationSnapshot,
  validateCollectiveModificationSnapshot,
} from '../modification/collective-custody-snapshot.js';
import {
  type CollectiveWorkspaceSnapshot,
  validateCollectiveWorkspaceSnapshot,
} from '../workspace-review/collective-custody-snapshot.js';

import { CollectiveCustodyContentReferences } from './custody-content-references.js';

export interface CollectiveArtifactCustodyBundle {
  v: 1;
  content: CollectiveContentSnapshot;
  review: CollectiveWorkspaceSnapshot | null;
  modifications: CollectiveModificationSnapshot;
}
const envelope = z
  .object({ v: z.literal(1), content: z.unknown(), review: z.unknown().nullable(), modifications: z.unknown() })
  .strict();

/** Validates the one scoped unit before preparation or activation, including every cross-store reference. */
export function validateCollectiveArtifactCustodyBundle(
  unsafe: unknown,
  scopeRef: string,
  contentRef: string,
): CollectiveArtifactCustodyBundle {
  const encoded = JSON.stringify(unsafe);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > COLLECTIVE_CUSTODY_MAX_BYTES)
    throw new Error('Collective transfer exceeds its admitted bound');
  const parsed = envelope.parse(unsafe);
  const content = validateCollectiveContentSnapshot(parsed.content, scopeRef);
  if (content.manifest.contentRef !== contentRef) throw new Error('Collective transfer content mismatch');
  const review =
    parsed.review === null ? null : validateCollectiveWorkspaceSnapshot(parsed.review, scopeRef, contentRef);
  const modifications = validateCollectiveModificationSnapshot(parsed.modifications, scopeRef, contentRef);
  const bundle: CollectiveArtifactCustodyBundle = { v: 1, content, review, modifications };
  const references = new CollectiveCustodyContentReferences(content);
  if (review) references.validateLedger(review);
  references.validateModifications(modifications, review?.review ?? null);
  validateDispositionReceipts(content, modifications);
  return bundle;
}

function validateDispositionReceipts(
  content: CollectiveContentSnapshot,
  modifications: CollectiveModificationSnapshot,
) {
  const ownerReceipts = new Map(content.manifest.receipts.map((receipt) => [receipt.operationId, receipt]));
  const acceptedReceipts = new Map<string, unknown>();
  for (const item of modifications.dispositions) {
    if (item.state === 'pending') throw new Error('Collective acceptance is not reconciled');
    if (item.state === 'failed' && ownerReceipts.has(item.intent.ownerOperationId))
      throw new Error('Collective failed disposition has an owner effect');
    if (item.state === 'accepted') {
      if (!isDeepStrictEqual(ownerReceipts.get(item.receipt.operationId), item.receipt))
        throw new Error('Collective acceptance owner receipt missing');
      acceptedReceipts.set(item.receipt.operationId, item.receipt);
    }
  }
  for (const receipt of content.manifest.receipts.filter((item) => item.previousOwnerRevision > 0)) {
    if (!isDeepStrictEqual(acceptedReceipts.get(receipt.operationId), receipt))
      throw new Error('Collective owner effect has no reconciled disposition');
  }
}
