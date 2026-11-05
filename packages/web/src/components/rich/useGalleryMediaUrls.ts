import { useEffect, useState } from 'react';
import type { RichMediaGalleryBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

export function isGalleryApiUrl(url: string): boolean {
  return [
    '/uploads/',
    '/api/workspace/file/raw?',
    '/api/connector-media/',
    '/api/plugins/chatgpt-dot/images/',
    '/avatars/',
  ].some((prefix) => url.startsWith(prefix));
}

function isLocalPath(url: string): boolean {
  return !isGalleryApiUrl(url) && (/^\//.test(url) || /^[a-z]:[\\/]/i.test(url) || /^\\\\/.test(url));
}

/** Read-side compatibility for old galleries; resolution never edits the source message. */
export function useGalleryMediaUrls(items: RichMediaGalleryBlock['items']) {
  const [resolved, setResolved] = useState<Record<string, string | null>>({});
  const pathsKey = JSON.stringify([...new Set(items.map((item) => item.url.trim()).filter(isLocalPath))]);
  useEffect(() => {
    const paths: string[] = JSON.parse(pathsKey);
    if (!paths.length) return;
    let cancelled = false;
    void Promise.all(paths.map(async (href) => [href, await resolveGalleryMediaUrl(href)] as const)).then((entries) => {
      if (!cancelled) setResolved(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [pathsKey]);

  return items.map((item) => {
    const url = item.url.trim();
    if (isLocalPath(url)) return { url: resolved[url], pending: resolved[url] === undefined };
    const valid =
      isGalleryApiUrl(url) || /^https?:\/\//i.test(url) || /^data:image\//i.test(url) || /^blob:/i.test(url);
    return { url: valid ? url : null, pending: false };
  });
}

/** Resolves only an original message locator; it does not prepare or publish a media owner. */
export async function resolveGalleryMediaUrl(raw: string): Promise<string | null> {
  const url = raw.trim();
  if (!isLocalPath(url))
    return isGalleryApiUrl(url) || /^https?:\/\//i.test(url) || /^data:image\//i.test(url) || /^blob:/i.test(url)
      ? url
      : null;
  try {
    const response = await apiFetch('/api/workspace/resolve-document-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ href: url }),
    });
    if (!response.ok) return null;
    const target: unknown = await response.json();
    if (
      !target ||
      typeof target !== 'object' ||
      !('kind' in target) ||
      target.kind !== 'file' ||
      !('worktreeId' in target) ||
      typeof target.worktreeId !== 'string' ||
      !('path' in target) ||
      typeof target.path !== 'string'
    )
      return null;
    return `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: target.worktreeId, path: target.path })}`;
  } catch {
    return null;
  }
}
