import { parseCollectiveWorkResultFilePath } from '@cat-cafe/shared';
import { SESSION_KEY } from './use-human-auth-session.js';

export interface CollectiveWorkResultFileAddress {
  readonly fileId: string;
  readonly fileName: string;
  readonly pathname: string;
}

export function collectiveWorkResultFileAddress(href: string): CollectiveWorkResultFileAddress | undefined {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const address = parseCollectiveWorkResultFilePath(url.pathname);
    return address ? { ...address, pathname: url.pathname } : undefined;
  } catch {
    return undefined;
  }
}

export function currentCollectiveSessionToken(): string | undefined {
  if (typeof location === 'undefined' || typeof sessionStorage === 'undefined') return undefined;
  return sessionStorage.getItem(`${SESSION_KEY}:${location.origin}`) ?? undefined;
}

/** Non-Markdown results retain their original authenticated read path; credentials never follow the message URL origin. */
export async function openCollectiveWorkResultFile(
  address: CollectiveWorkResultFileAddress,
  sessionToken: string,
  popup?: Window | null,
): Promise<void> {
  if (typeof location === 'undefined') throw new Error('Work result file belongs to another Service');
  const href = new URL(address.pathname, location.origin).toString();
  try {
    const response = await fetch(href, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(`Work result file failed (${response.status})`);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (contentType !== 'text/markdown' && contentType !== 'text/plain')
      throw new Error('Work result file returned an unsupported media type');
    const blob = await response.blob();
    if (blob.size > 65_536) throw new Error('Work result file exceeds the supported size');
    const objectUrl = URL.createObjectURL(blob);
    if (popup) {
      popup.opener = null;
      popup.location.replace(objectUrl);
    } else {
      const download = document.createElement('a');
      download.href = objectUrl;
      download.download = address.fileName;
      download.rel = 'noreferrer noopener';
      download.click();
    }
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (error) {
    popup?.close();
    throw error;
  }
}
