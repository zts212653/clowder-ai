import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';

export type FileCardOrigin = Extract<WorkspaceFileNavigationOrigin, { kind: 'settings' | 'workspace-card' }>;
export const FILE_RETURN_PARAM = 'fileReturn';
export const FILE_RETURN_EVENT = 'cat-cafe:file-return';

export function validSettingsHref(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\u0000-\u001f]/.test(value)) return false;
  if (!value.startsWith('/settings')) return false;
  const url = new URL(value, 'https://local.invalid');
  return (
    url.origin === 'https://local.invalid' && (url.pathname === '/settings' || url.pathname.startsWith('/settings/'))
  );
}

export function parseFileCardOrigin(value: Record<string, unknown>): FileCardOrigin | null {
  if (
    typeof value.anchorId !== 'string' ||
    !value.anchorId.trim() ||
    value.anchorId.length > 4096 ||
    typeof value.viewportOffsetPx !== 'number' ||
    !Number.isFinite(value.viewportOffsetPx)
  )
    return null;
  const position = { anchorId: value.anchorId, viewportOffsetPx: value.viewportOffsetPx };
  if (value.kind === 'settings' && validSettingsHref(value.href))
    return { kind: 'settings', href: value.href, ...position };
  if (
    value.kind === 'workspace-card' &&
    typeof value.threadId === 'string' &&
    value.threadId.trim() &&
    value.threadId.length <= 256 &&
    (value.destination === 'status' || value.destination === 'eval')
  )
    return { kind: 'workspace-card', threadId: value.threadId, destination: value.destination, ...position };
  return null;
}

export function captureFileCardOrigin(
  element: HTMLElement | null,
  anchorId: string,
  threadId: string,
  destination: 'status' | 'eval',
): FileCardOrigin {
  const container = element?.closest<HTMLElement>('[data-trajectory-origin-scroll], [data-file-origin-scroll]');
  const viewportOffsetPx =
    element && container ? element.getBoundingClientRect().top - container.getBoundingClientRect().top : 0;
  const url = new URL(window.location.href);
  url.searchParams.delete(FILE_RETURN_PARAM);
  const href = `${url.pathname}${url.search}${url.hash}`;
  return validSettingsHref(href)
    ? { kind: 'settings', href, anchorId, viewportOffsetPx }
    : { kind: 'workspace-card', threadId, destination, anchorId, viewportOffsetPx };
}

/** Navigation coordinates only: the target component consumes them once it is actually mounted and visible. */
export function fileCardReturnHref(origin: FileCardOrigin): string {
  if (!parseFileCardOrigin(origin)) throw new Error('Invalid file navigation origin');
  const href =
    origin.kind === 'settings'
      ? origin.href
      : origin.threadId === 'default'
        ? '/'
        : `/thread/${encodeURIComponent(origin.threadId)}`;
  const url = new URL(href, 'https://local.invalid');
  url.searchParams.set(
    FILE_RETURN_PARAM,
    JSON.stringify({
      anchorId: origin.anchorId,
      viewportOffsetPx: origin.viewportOffsetPx,
      ...(origin.kind === 'workspace-card' ? { threadId: origin.threadId } : {}),
    }),
  );
  return `${url.pathname}${url.search}${url.hash}`;
}
