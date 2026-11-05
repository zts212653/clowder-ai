import type { SharedMarkdownView } from './collective-artifact-client.js';

const changed = () => new Error('批注正在更新，请重新读取作品。');

/** A complete JSON envelope is still only one annotation page, not the entire ledger. */
export function assertSharedAnnotationPage(view: SharedMarkdownView, offset: number) {
  const page = view.view.annotationPage;
  const count = view.view.review.annotations.length;
  const end = offset + count;
  if (
    page.offset !== offset ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    end > page.total ||
    (count === 0 && page.total !== 0) ||
    (page.nextOffset === undefined ? end !== page.total : page.nextOffset !== end || end >= page.total)
  )
    throw changed();
  if (new Set(view.view.review.annotations.map((item) => item.id)).size !== count) throw changed();
}

export function appendSharedAnnotationPage(view: SharedMarkdownView, page: SharedMarkdownView) {
  const offset = view.view.annotationPage.nextOffset;
  if (offset === undefined) return view;
  assertSharedAnnotationPage(page, offset);
  if (
    page.contentRef !== view.contentRef ||
    page.ownerRevision !== view.ownerRevision ||
    page.blobDigest !== view.blobDigest ||
    page.view.review.reviewId !== view.view.review.reviewId ||
    page.view.review.revision !== view.view.review.revision ||
    page.view.annotationPage.total !== view.view.annotationPage.total
  )
    throw changed();
  const seen = new Set(view.view.review.annotations.map((item) => item.id));
  if (page.view.review.annotations.some((item) => seen.has(item.id))) throw changed();
  const expanded = structuredClone(view);
  expanded.view.review.annotations.push(...page.view.review.annotations);
  expanded.view.review.sourceHistory = [
    ...new Map(
      [...(view.view.review.sourceHistory ?? []), ...(page.view.review.sourceHistory ?? [])].map((source) => [
        source.revision,
        source,
      ]),
    ).values(),
  ];
  expanded.view.annotationResolutions = [
    ...(view.view.annotationResolutions ?? []),
    ...(page.view.annotationResolutions ?? []),
  ];
  expanded.view.replyPages = [...(view.view.replyPages ?? []), ...(page.view.replyPages ?? [])];
  expanded.view.annotationPage.nextOffset = page.view.annotationPage.nextOffset;
  return expanded;
}
