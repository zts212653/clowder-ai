import { messageMediaPublicationSourceSchema, messagePublicationLandingSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { getThreadHref, pushThreadRouteWithHistory } from '../ThreadSidebar/thread-navigation';
import { publicationContentRefSchema } from '../workbench/publication-surface';
import type { HomeCommandInput, HomeOutcome } from './home-action-bridge';
import { afterPaintUntil } from './home-after-paint';

const publication = z
  .object({
    kind: z.literal('publication'),
    source: messageMediaPublicationSourceSchema,
    artifact: z
      .object({
        contentRef: publicationContentRefSchema,
        ownerRevision: z.number().int().positive().safe(),
      })
      .strict()
      .optional(),
  })
  .strict();

function rendered(node: HTMLElement): boolean {
  if (node.getClientRects().length === 0) return false;
  for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (
      parent.hidden ||
      parent.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    )
      return false;
  }
  return true;
}

/** Consumes F309's exact ready-root contract; missing or hidden original pixels remain unconfirmed. */
export function isHomePublicationVisible(contentRef: string, ownerRevision: number): boolean {
  if (document.visibilityState !== 'visible') return false;
  return [...document.querySelectorAll<HTMLElement>('[data-testid="workspace-content-review-surface"]')].some(
    (node) => {
      if (
        node.dataset.contentRef !== contentRef ||
        node.dataset.ownerRevision !== String(ownerRevision) ||
        node.dataset.contentReady !== 'true' ||
        !rendered(node)
      )
        return false;
      const image = node.querySelector<HTMLImageElement>('img[data-testid="workspace-content-review-media"]');
      const video = node.querySelector<HTMLVideoElement>('video[data-testid="workspace-content-review-media"]');
      return (
        (!image || (rendered(image) && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)) &&
        (!video ||
          (rendered(video) && !video.error && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0))
      );
    },
  );
}

/** Exact original message item -> authenticated publication owner -> the existing F307 surface. */
export async function applyHomePublication(
  input: HomeCommandInput,
  action: unknown,
  expiresAt: number,
): Promise<HomeOutcome> {
  const parsed = publication.safeParse(action);
  if (!parsed.success) return { status: 'blocked', reason: 'invalid_publication_source' };
  const { source, artifact } = parsed.data;
  const baseRoute = window.location.pathname + window.location.search;
  const response = await apiFetch('/api/content-publications/resolve', {
    method: 'POST',
    signal: input.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, operationId: input.token, ...(artifact ? { selection: artifact } : {}) }),
  });
  if (!response.ok) return { status: 'blocked', reason: 'publication_owner_refused' };
  const resolved = messagePublicationLandingSchema.safeParse(await response.json());
  if (
    input.signal.aborted ||
    Date.now() >= expiresAt ||
    baseRoute !== window.location.pathname + window.location.search
  )
    return { status: 'blocked', reason: 'publication_request_changed' };
  if (!resolved.success || resolved.data.status !== 'resolved')
    return { status: 'unconfirmed', reason: 'publication_choice_not_resolved' };
  const asset = resolved.data.asset;
  if (artifact && (asset.contentRef !== artifact.contentRef || asset.ownerRevision !== artifact.ownerRevision))
    return { status: 'blocked', reason: 'publication_version_changed' };
  if (!(await reachPublicationThread(input, source.threadId, expiresAt)))
    return { status: 'unconfirmed', reason: 'publication_thread_not_confirmed' };
  const opened = useChatStore.getState().openPublication(
    {
      kind: 'publication',
      contentRef: asset.contentRef,
      ownerRevision: asset.ownerRevision,
      title: '作品',
      messagePublicationSource: source,
      navigationOrigin: { kind: 'chat-file-link', threadId: source.threadId, messageId: source.messageId },
    },
    source.threadId,
  );
  if (!opened) return { status: 'blocked', reason: 'publication_thread_changed' };
  const shown = await afterPaintUntil(
    () =>
      useChatStore.getState().currentThreadId === source.threadId &&
      isHomePublicationVisible(asset.contentRef, asset.ownerRevision),
    input.signal,
    expiresAt,
  );
  return shown
    ? { status: 'applied', artifact: { contentRef: asset.contentRef, ownerRevision: asset.ownerRevision } }
    : { status: 'unconfirmed', reason: 'publication_dom_not_confirmed' };
}

async function reachPublicationThread(input: HomeCommandInput, threadId: string, expiresAt: number) {
  const href = getThreadHref(threadId);
  if (window.location.pathname !== href) {
    if (window.location.pathname === '/' || window.location.pathname.startsWith('/thread/'))
      pushThreadRouteWithHistory(threadId, window);
    else input.navigate(href);
  }
  return afterPaintUntil(
    () =>
      useChatStore.getState().currentThreadId === threadId &&
      [...document.querySelectorAll<HTMLElement>('[data-thread-id]')].some(
        (node) => node.dataset.threadId === threadId,
      ),
    input.signal,
    expiresAt,
  );
}
