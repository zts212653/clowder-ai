import type { SupportedImageMime } from './image-storage.js';
import { detectRasterImageMime } from './raster-image-mime.js';
import { inspectSvgImage, MAX_SVG_BYTES } from './svg-image.js';

/**
 * Sniff image magic signature from buffer prefix. Returns the detected MIME
 * type or `null` if no supported signature matches. mimetype on the multipart
 * part is supplied by the client and cannot be trusted as ground truth.
 */
export function detectImageMime(buffer: Buffer): SupportedImageMime | null {
  const raster = detectRasterImageMime(buffer);
  if (raster) return raster;
  if (
    buffer
      .subarray(0, MAX_SVG_BYTES)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trimStart()
      .startsWith('<')
  ) {
    try {
      inspectSvgImage(buffer);
      return 'image/svg+xml';
    } catch {
      return null;
    }
  }
  return null;
}
