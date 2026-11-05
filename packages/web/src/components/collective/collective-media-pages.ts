import type { CollectiveMediaView } from '@cat-cafe/shared';

export function appendMediaPage(current: CollectiveMediaView, page: CollectiveMediaView, annotationId?: string) {
  if (
    page.contentRef !== current.contentRef ||
    page.ownerRevision !== current.ownerRevision ||
    page.blobDigest !== current.blobDigest ||
    page.view.review.reviewId !== current.view.review.reviewId ||
    page.view.review.revision !== current.view.review.revision
  )
    throw new Error('讨论正在更新，请重新读取。');
  const next = structuredClone(current);
  return annotationId ? appendReplyPage(next, page, annotationId) : appendAnnotationPage(next, page);
}

function appendReplyPage(next: CollectiveMediaView, page: CollectiveMediaView, annotationId: string) {
  const before = next.view.replyPages.find((item) => item.annotationId === annotationId);
  const after = page.view.replyPages.find((item) => item.annotationId === annotationId);
  const source = page.view.review.annotations.find((item) => item.id === annotationId);
  const target = next.view.review.annotations.find((item) => item.id === annotationId);
  if (
    !before ||
    !after ||
    !source ||
    !target ||
    after.offset !== before.nextOffset ||
    after.total !== before.total ||
    source.replies?.length !== 1 ||
    (after.nextOffset !== undefined && after.nextOffset <= after.offset)
  )
    throw new Error('讨论正在更新，请重新读取。');
  const ids = new Set(target.replies?.map((item) => item.id));
  if (source.replies.some((item) => ids.has(item.id))) throw new Error('回复页重复。');
  target.replies = [...(target.replies ?? []), ...source.replies];
  Object.assign(before, after);
  if (after.nextOffset === undefined) delete before.nextOffset;
  return next;
}

function appendAnnotationPage(next: CollectiveMediaView, page: CollectiveMediaView) {
  const before = next.view.annotationPage,
    after = page.view.annotationPage;
  if (
    after.offset !== before.nextOffset ||
    after.total !== before.total ||
    !page.view.review.annotations.length ||
    (after.nextOffset !== undefined && after.nextOffset <= after.offset)
  )
    throw new Error('批注页正在更新。');
  const ids = new Set(next.view.review.annotations.map((item) => item.id));
  if (page.view.review.annotations.some((item) => ids.has(item.id))) throw new Error('批注页重复。');
  next.view.review.annotations.push(...page.view.review.annotations);
  next.view.annotationPage = { ...after, offset: 0 };
  next.view.replyPages.push(...page.view.replyPages);
  next.view.annotationResolutions.push(...page.view.annotationResolutions);
  return next;
}

export function nextMediaPage(current: CollectiveMediaView, annotationId?: string) {
  if (!annotationId) {
    const annotationOffset = current.view.annotationPage.nextOffset;
    return annotationOffset === undefined ? undefined : { annotationOffset };
  }
  const replyOffset = current.view.replyPages.find((page) => page.annotationId === annotationId)?.nextOffset;
  return replyOffset === undefined ? undefined : { annotationId, replyOffset };
}
