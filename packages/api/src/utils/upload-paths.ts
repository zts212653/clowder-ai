import { resolve } from 'node:path';
import { resolveUploadsDir } from '../config/data-dirs.js';

/**
 * Resolve the upload directory.
 * Explicit override keeps the historical cwd-based behavior.
 * Without configuration, use the data-dir resolver (DATA_DIR/uploads or the
 * module-relative packages/api/uploads fallback).
 */
export function getDefaultUploadDir(configuredUploadDir?: string): string {
  return configuredUploadDir ? resolve(configuredUploadDir) : resolveUploadsDir();
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
