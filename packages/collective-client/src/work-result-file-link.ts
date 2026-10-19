import { parseCollectiveWorkResultFilePath } from '@cat-cafe/shared';
import { SESSION_KEY } from './use-human-auth-session.js';

export function collectiveWorkResultFileAddress(href: string): { fileName: string; pathname: string } | undefined {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const address = parseCollectiveWorkResultFilePath(url.pathname);
    return address ? { fileName: address.fileName, pathname: url.pathname } : undefined;
  } catch {
    return undefined;
  }
}

export function currentCollectiveWorkResultFile(href: string): { fileName: string; href: string } | undefined {
  if (typeof location === 'undefined') return undefined;
  const address = collectiveWorkResultFileAddress(href);
  return address
    ? { fileName: address.fileName, href: new URL(address.pathname, location.origin).toString() }
    : undefined;
}

export function currentCollectiveSessionToken(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  if (typeof sessionStorage === 'undefined') return undefined;
  const token = sessionStorage.getItem(`${SESSION_KEY}:${location.origin}`);
  return token === null ? undefined : token;
}

export async function openCollectiveWorkResultFile(
  href: string,
  sessionToken: string,
  popup?: Window | null,
): Promise<void> {
  const address = currentCollectiveWorkResultFile(href);
  if (!address) throw new Error('Work result file belongs to another Service');
  try {
    const response = await fetch(address.href, {
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
