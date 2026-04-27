import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_DEFAULT_UPLOAD_DIR = resolve(THIS_DIR, '../../uploads');

/**
 * Resolve the upload directory.
 * Explicit UPLOAD_DIR keeps the historical cwd-based behavior.
 * Without configuration, default to packages/api/uploads so API routes and
 * connector outbound delivery share the same on-disk truth source.
 */
export function getDefaultUploadDir(configuredUploadDir?: string): string {
  return configuredUploadDir ? resolve(configuredUploadDir) : MODULE_DEFAULT_UPLOAD_DIR;
}

const INTERNAL_ROUTE_PREFIXES = ['/uploads/', '/api/connector-media/', '/api/tts/audio/'];

export function resolveInternalRouteUrl(url: string): string {
  if (url.startsWith('https://') || url.startsWith('http://')) return url;
  if (INTERNAL_ROUTE_PREFIXES.some((p) => url.startsWith(p))) {
    const apiBase = (
      process.env.CAT_CAFE_API_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      'http://localhost:3004'
    ).replace(/\/$/, '');
    return `${apiBase}${url}`;
  }
  return url;
}
