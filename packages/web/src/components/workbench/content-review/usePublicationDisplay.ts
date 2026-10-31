import { immutableMediaSchema, type ReviewedMediaAsset } from '@cat-cafe/shared';
import { type RefObject, useLayoutEffect, useRef } from 'react';
import { reviewMediaDisplayPath } from '@/components/content-review/useReviewMediaSource';
import { API_URL } from '@/utils/api-client';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';
import type { ContentReviewView } from './content-review-contract';
import { observeMediaPresentation } from './observe-media-presentation';

export type PublicationDisplayRequest = { contentRef: string; ownerRevision: number; asset: ReviewedMediaAsset | null };
const attributes = ['data-content-ref', 'data-owner-revision', 'data-content-ready'] as const;

function verifiedPublication(request: PublicationDisplayRequest | undefined, view: ContentReviewView | null) {
  const source = view?.currentSource ?? view?.review.source;
  const asset = request?.asset;
  if (!asset || view?.sourceState !== 'current' || source?.kind !== 'publication') return null;
  const publication = source.publication;
  const media = immutableMediaSchema.safeParse(source.media);
  if (
    publication.contentRef !== request.contentRef ||
    publication.ownerRevision !== request.ownerRevision ||
    asset.contentRef !== publication.contentRef ||
    asset.ownerRevision !== publication.ownerRevision ||
    asset.blobDigest !== publication.blobDigest ||
    asset.ownerReceiptRef !== publication.ownerReceiptRef ||
    asset.mediaType !== source.mime ||
    !media.success ||
    JSON.stringify(asset.media) !== JSON.stringify(media.data)
  )
    return null;
  return publication;
}

function displayed(element: HTMLElement) {
  if (!element.isConnected || document.visibilityState === 'hidden' || !element.getClientRects().length) return false;
  let rect = element.getBoundingClientRect();
  let left = Math.max(rect.left, 0),
    top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth),
    bottom = Math.min(rect.bottom, window.innerHeight);
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (
      ancestor.hidden ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    )
      return false;
    rect = ancestor.getBoundingClientRect();
    if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
      left = Math.max(left, rect.left);
      right = Math.min(right, rect.right);
    }
    if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
  }
  return right > left && bottom > top;
}

/** This root exposes only the publication actually displayed here; it grants no authority or navigation result. */
export function usePublicationDisplay(
  rootRef: RefObject<HTMLElement>,
  request: PublicationDisplayRequest | undefined,
  view: ContentReviewView | null,
  error: string | null,
) {
  const visible = useWorkspaceSurfaceVisibility();
  const current = useRef({ request, view, error, visible });
  const refresh = useRef<(() => void) | null>(null);
  const enabled = request !== undefined;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    let media: HTMLImageElement | HTMLVideoElement | null = null;
    let src = '';
    let pixelsReady = false;
    let stopMedia: (() => void) | undefined;
    const clear = () => {
      for (const attribute of attributes) root.removeAttribute(attribute);
    };
    const publish = () => {
      const options = current.current;
      const publication = verifiedPublication(options.request, options.view);
      const expected = publication
        ? new URL(
            reviewMediaDisplayPath(
              `${API_URL}/api/content-publications/${encodeURIComponent(publication.contentRef)}/media/${publication.ownerRevision}`,
              options.request?.asset?.mediaType,
            ),
            window.location.href,
          ).href
        : null;
      if (
        !publication ||
        !options.visible ||
        options.error ||
        !pixelsReady ||
        !media ||
        !root.contains(media) ||
        media.src !== expected ||
        media.currentSrc !== expected ||
        (media instanceof HTMLImageElement &&
          (!media.complete || media.naturalWidth === 0 || media.naturalHeight === 0)) ||
        !displayed(media)
      ) {
        clear();
        return;
      }
      const values = [publication.contentRef, String(publication.ownerRevision), 'true'];
      attributes.forEach((attribute, index) => {
        if (root.getAttribute(attribute) !== values[index]) root.setAttribute(attribute, values[index]);
      });
    };
    const scan = () => {
      const node = root.querySelector<HTMLImageElement | HTMLVideoElement>(
        '[data-testid="workspace-content-review-media"]',
      );
      if (node !== media || node?.src !== src) {
        stopMedia?.();
        media = node;
        src = node?.src ?? '';
        pixelsReady = false;
        stopMedia = node
          ? observeMediaPresentation(node, (ready) => {
              pixelsReady = ready;
              publish();
            })
          : undefined;
      }
      publish();
    };
    refresh.current = scan;
    const mutation = new MutationObserver(scan);
    const attributeFilter = ['class', 'style', 'hidden', 'aria-hidden', 'data-comparing', 'src'];
    mutation.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter });
    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement)
      mutation.observe(ancestor, { attributes: true, attributeFilter });
    const resize = new ResizeObserver(scan);
    resize.observe(root);
    root.addEventListener('scroll', publish, true);
    window.addEventListener('resize', publish);
    document.addEventListener('scroll', publish, true);
    document.addEventListener('visibilitychange', publish);
    scan();
    return () => {
      refresh.current = null;
      mutation.disconnect();
      resize.disconnect();
      stopMedia?.();
      clear();
      root.removeEventListener('scroll', publish, true);
      window.removeEventListener('resize', publish);
      document.removeEventListener('scroll', publish, true);
      document.removeEventListener('visibilitychange', publish);
    };
  }, [rootRef, enabled]);
  useLayoutEffect(() => {
    current.current = { request, view, error, visible };
    refresh.current?.();
  }, [request, view, error, visible]);
}
