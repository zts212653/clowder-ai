import { createHash } from 'node:crypto';
import { collectiveArtifactReadPageSchema } from '@cat-cafe/shared';
import { contentModificationPage } from '../modification/inspection.js';
import type { AdmittedCollectiveMarkdown } from './markdown-authority.js';
import type { CollectiveMarkdownReviews } from './markdown-reviews.js';

/** Reuse F309 exact JSON paging when escaping would exceed the short-lived relay envelope. */
export function readCollectiveMarkdown(
  admitted: AdmittedCollectiveMarkdown,
  reviews: CollectiveMarkdownReviews,
  unsafe: Record<string, unknown>,
  request: Record<string, unknown> = {},
) {
  const page = collectiveArtifactReadPageSchema.parse(unsafe);
  const value = {
    contentRef: admitted.content.contentRef,
    ownerRevision: admitted.content.ownerRevision,
    blobDigest: admitted.content.blobDigest,
    text: admitted.content.bytes.toString('utf8'),
    view: reviews.view(admitted, undefined, unsafe),
    ...request,
  };
  // Reserve 64 KiB for a content-free recovery batch alongside this body/page.
  return pageCollectiveValue(admitted, value, page, 112 * 1024);
}

export function pageCollectiveValue(
  admitted: AdmittedCollectiveMarkdown,
  value: Record<string, unknown>,
  page: { cursor: number; expectedSnapshot?: string },
  maxBytes = 180 * 1024,
) {
  const serialized = JSON.stringify(value);
  if (!page.cursor && !page.expectedSnapshot && Buffer.byteLength(serialized) <= maxBytes) return value;
  const snapshot = `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
  return contentModificationPage(
    {
      requestId: admitted.operationId,
      view: 'collective-markdown',
      cursor: page.cursor,
      expectedSnapshot: page.expectedSnapshot,
    },
    snapshot,
    value,
  );
}
