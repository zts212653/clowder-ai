/**
 * Image Path Extraction
 * Extracts absolute file paths from MessageContent blocks for CLI passthrough.
 */

import { resolve } from 'node:path';
import type { MessageContent } from '@cat-cafe/shared';
import { getDefaultUploadDir, resolveInternalRouteUrl } from '../../../../../utils/upload-paths.js';

/**
 * Extract absolute image file paths from contentBlocks.
 * Converts relative URL paths (/uploads/foo.png) to absolute filesystem paths.
 * @param uploadDir Override for the upload directory (defaults to UPLOAD_DIR env or './uploads')
 */
export function extractImagePaths(contentBlocks: readonly MessageContent[] | undefined, uploadDir?: string): string[] {
  if (!contentBlocks) return [];

  const paths: string[] = [];
  const resolvedUploadDir = getDefaultUploadDir(uploadDir ?? process.env.UPLOAD_DIR);
  for (const block of contentBlocks) {
    if (block.type !== 'image') continue;
    const url = block.url;
    if (url.startsWith('/uploads/')) {
      const filename = url.slice('/uploads/'.length);
      paths.push(resolve(resolvedUploadDir, filename));
    } else if (url.startsWith('/')) {
      paths.push(resolve(url));
    }
  }
  return paths;
}

/**
 * F211-REG3 (Layer B): extract workspace-reachable HTTP image URLs from contentBlocks.
 * External runtimes (Antigravity/Bengal) cannot read absolute filesystem imagePaths under
 * cat-cafe-runtime/uploads because the IDE workspace root rejects them ("Path outside
 * workspace root"). An HTTP url served by the API `/uploads/` static route IS reachable, so
 * the carrier can fetch the bytes. Actual in-IDE rendering remains an Antigravity carrier
 * (F061) concern — this only removes the path-reachability blocker.
 */
export function extractImageUrls(contentBlocks: readonly MessageContent[] | undefined): string[] {
  if (!contentBlocks) return [];

  const urls: string[] = [];
  for (const block of contentBlocks) {
    if (block.type !== 'image') continue;
    const url = block.url;
    if (url.startsWith('/uploads/') || url.startsWith('http://') || url.startsWith('https://')) {
      urls.push(resolveInternalRouteUrl(url));
    }
  }
  return urls;
}
