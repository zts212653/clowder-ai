import { isContentFileBasename } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { contentApiBase, contentFileUrl, workspaceFileSourceFromUrl } from './file-source';
export type ContentFileInfo = {
  local: boolean;
  canOpen?: boolean;
  canReveal?: boolean;
  path?: string;
  displayPath?: string;
  filename?: string;
  mime?: string;
  byteLength?: number;
  defaultApplication?: string | null;
  defaultApplicationBundleId?: string;
  author?: string;
  createdAt?: string;
  modifiedAt?: string;
};
export type FileActionSource = { kind: 'workspace'; worktreeId: string; path: string } | { kind: 'url'; url: string };

function apiBase() {
  return contentApiBase();
}
export function fileSourceUrl(source: FileActionSource): string | null {
  return source.kind === 'url'
    ? contentFileUrl(source.url)
    : new URL(
        '/api/workspace/file/raw?' + new URLSearchParams({ worktreeId: source.worktreeId, path: source.path }),
        apiBase(),
      ).href;
}
export function fileSourceIdentity(source: FileActionSource): string {
  const workspace = source.kind === 'workspace' ? source : workspaceFileSourceFromUrl(source.url);
  return JSON.stringify(workspace ?? { kind: 'url', url: fileSourceUrl(source) });
}
/** Display and download are representations of the same locator, never separate file identities. */
export function fileDownloadUrl(raw: string): string | null {
  const safe = contentFileUrl(raw);
  if (!safe) return null;
  const url = new URL(safe);
  if (workspaceFileSourceFromUrl(safe)) url.pathname = '/api/workspace/file/download';
  return url.href;
}
export function fileActionUrl(source: FileActionSource, action: 'file-info' | 'reveal' | 'open'): string | null {
  if (source.kind === 'workspace')
    return (
      '/api/workspace/file/actions/' +
      action +
      '?' +
      new URLSearchParams({ worktreeId: source.worktreeId, path: source.path })
    );
  const url = new URL(source.url, apiBase());
  if (url.pathname === '/api/workspace/file/download') url.pathname = '/api/workspace/file/raw';
  if (url.origin !== apiBase().origin) return null;
  if (/^\/(?:api\/)?uploads\/[^/]+$/.test(url.pathname)) {
    let filename: string;
    try {
      filename = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    } catch {
      return null;
    }
    if (!isContentFileBasename(filename)) return null;
    url.pathname = url.pathname.replace(/^\/uploads\//, '/api/uploads/');
    url.search = '';
  } else if (url.pathname === '/api/workspace/file/raw') {
    if (url.searchParams.getAll('worktreeId').length !== 1 || url.searchParams.getAll('path').length !== 1) return null;
    const worktreeId = url.searchParams.get('worktreeId'),
      path = url.searchParams.get('path');
    if (!worktreeId || !path) return null;
    url.search = new URLSearchParams({ worktreeId, path }).toString();
  } else if (
    !/^\/api\/(?:content-publications\/[^/]+\/media\/\d+|artifact-reviews\/[^/]+\/media\/\d+|(?:workspace\/)?content-reviews\/[^/]+\/media)$/.test(
      url.pathname,
    )
  )
    return null;
  url.pathname += '/' + action;
  url.searchParams.delete('display');
  return url.pathname + url.search;
}
export async function contentFileInfo(source: FileActionSource): Promise<ContentFileInfo> {
  const url = fileActionUrl(source, 'file-info');
  if (!url) return { local: false };
  const response = await apiFetch(url);
  if (!response.ok) throw new Error('file_info_unavailable');
  const info: ContentFileInfo = await response.json();
  if (info.local && (typeof info.path !== 'string' || !info.path.startsWith('/'))) throw new Error('invalid_file_info');
  return info;
}
export async function runContentFileAction(source: FileActionSource, action: 'reveal' | 'open') {
  const url = fileActionUrl(source, action);
  if (!url) throw new Error('local_action_unavailable');
  const response = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error('file_action_failed');
}

/** Lazy cards copy the same bytes as an open reader; external sources keep their CORS/credential boundary. */
export async function copyContentText(source: FileActionSource, text?: string) {
  if (text !== undefined) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const original = fileSourceUrl(source);
  const link = original ? fileDownloadUrl(original) : null;
  if (!link) throw new Error('invalid_file_source');
  const url = new URL(link);
  const response = url.origin === apiBase().origin ? apiFetch(url.pathname + url.search) : fetch(link);
  const value = response.then(async (r) => {
    if (!r.ok) throw new Error('content_unavailable');
    return r.text();
  });
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write)
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': value.then((text) => new Blob([text], { type: 'text/plain' })) }),
    ]);
  else await navigator.clipboard.writeText(await value);
}

/** ClipboardItem receives the promise during the user gesture, preserving Safari's activation. */
export async function copyArtworkPixels(element: HTMLImageElement | HTMLVideoElement, src: string) {
  const pixels = (async () => {
    const canvas = document.createElement('canvas');
    const video = element instanceof HTMLVideoElement;
    let bitmap: ImageBitmap | null = null;
    if (video) {
      if (element.readyState < 2 || element.seeking || !element.videoWidth) throw new Error('frame_not_ready');
      canvas.width = element.videoWidth;
      canvas.height = element.videoHeight;
    } else {
      const source = new URL(src, apiBase());
      const response =
        source.origin === apiBase().origin ? await apiFetch(`${source.pathname}${source.search}`) : await fetch(src);
      if (!response.ok) throw new Error('image_unavailable');
      bitmap = await createImageBitmap(await response.blob());
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    try {
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > 40_000_000)
        throw new Error('invalid_pixels');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas_unavailable');
      context.drawImage(bitmap ?? element, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encoding_failed'))), 'image/png'),
      );
    } finally {
      bitmap?.close();
    }
  })();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': pixels })]);
}

export async function downloadContentFile(url: string, filename: string) {
  const safeUrl = fileDownloadUrl(url);
  if (!safeUrl) throw new Error('invalid_file_source');
  const source = new URL(safeUrl);
  if (source.origin !== apiBase().origin) {
    const anchor = document.createElement('a');
    anchor.href = source.href;
    anchor.download = filename;
    anchor.rel = 'noopener noreferrer';
    anchor.click();
    return;
  }
  const response = await apiFetch(`${source.pathname}${source.search}`);
  if (!response.ok) throw new Error('download_unavailable');
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
