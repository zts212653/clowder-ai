import { apiFetch } from '@/utils/api-client';
import { contentApiBase } from './file-source';

export type ArtworkPixelRegion = Readonly<{ x: number; y: number; width: number; height: number }>;

function assertPixelRegion(region: ArtworkPixelRegion, bitmap: { width: number; height: number }) {
  if (
    !Object.values(region).every(Number.isSafeInteger) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > bitmap.width ||
    region.y + region.height > bitmap.height
  )
    throw new Error('invalid_pixels');
}

function encodePixels(
  source: ImageBitmap | HTMLVideoElement,
  width: number,
  height: number,
  region?: ArtworkPixelRegion,
) {
  if (region) assertPixelRegion(region, { width, height });
  const canvas = document.createElement('canvas');
  canvas.width = region?.width ?? width;
  canvas.height = region?.height ?? height;
  if (!canvas.width || !canvas.height || canvas.width * canvas.height > 40_000_000) throw new Error('invalid_pixels');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas_unavailable');
  if (region)
    context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  else context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encoding_failed'))), 'image/png'),
  );
}

/** Give ClipboardItem its promise during the gesture; snapshot the displayed frame before fetching. */
export async function copyArtworkPixels(
  element: HTMLImageElement | HTMLVideoElement,
  src: string,
  pixelRegion?: ArtworkPixelRegion,
) {
  const region = pixelRegion ? { ...pixelRegion } : undefined;
  const pixels = (async () => {
    if (element instanceof HTMLVideoElement) {
      if (element.readyState < 2 || element.seeking || !element.videoWidth) throw new Error('frame_not_ready');
      return encodePixels(element, element.videoWidth, element.videoHeight);
    }
    const base = contentApiBase();
    const source = new URL(src, base);
    const response =
      source.origin === base.origin ? await apiFetch(`${source.pathname}${source.search}`) : await fetch(src);
    if (!response.ok) throw new Error('image_unavailable');
    const bitmap = await createImageBitmap(await response.blob());
    try {
      return await encodePixels(bitmap, bitmap.width, bitmap.height, region);
    } finally {
      bitmap.close();
    }
  })();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': pixels })]);
}
