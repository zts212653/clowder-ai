import { API_URL, apiFetch } from '@/utils/api-client';
export type ArtworkFileInfo = {
  local: boolean;
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
export function artworkFileActionUrl(mediaUrl: string, action: 'file-info' | 'reveal' | 'open'): string | null {
  const url = new URL(mediaUrl, API_URL);
  if (url.origin !== new URL(API_URL).origin) return null;
  if (/^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(mp4|webm|mov)$/i.test(url.pathname)) {
    url.pathname = `/api${url.pathname}`;
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
  url.pathname += `/${action}`;
  url.searchParams.delete('display');
  return `${url.pathname}${url.search}`;
}
export function localDesktopViewer() {
  return (
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname) &&
    window.innerWidth > 600 &&
    !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) &&
    !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}
export async function artworkFileInfo(mediaUrl: string): Promise<ArtworkFileInfo> {
  const url = artworkFileActionUrl(mediaUrl, 'file-info');
  if (!url || !localDesktopViewer()) return { local: false };
  const response = await apiFetch(url);
  if (!response.ok) throw new Error('file_info_unavailable');
  const info: ArtworkFileInfo = await response.json();
  if (info.local && (typeof info.path !== 'string' || !info.path.startsWith('/'))) throw new Error('invalid_file_info');
  return info;
}
export async function runArtworkFileAction(mediaUrl: string, action: 'reveal' | 'open') {
  const url = artworkFileActionUrl(mediaUrl, action);
  if (!url || !localDesktopViewer()) throw new Error('local_action_unavailable');
  const response = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error('file_action_failed');
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
      const source = new URL(src, API_URL);
      const response =
        source.origin === new URL(API_URL).origin
          ? await apiFetch(`${source.pathname}${source.search}`)
          : await fetch(src);
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

export async function downloadArtworkFile(url: string, filename: string) {
  const source = new URL(url, API_URL);
  const response =
    source.origin === new URL(API_URL).origin ? await apiFetch(`${source.pathname}${source.search}`) : await fetch(url);
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
