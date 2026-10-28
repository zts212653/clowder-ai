/**
 * Uploads Static File Route
 * Serves uploaded images from the uploads directory.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { setStoredFileHeaders } from './file-byte-response-headers.js';
import { registerUploadedMediaFileActions } from './local-media-file-actions.js';
import { registerMessageStickerRoutes } from './message-stickers.js';

export interface UploadsRoutesOptions {
  uploadDir: string;
}

export const uploadsRoutes: FastifyPluginAsync<UploadsRoutesOptions> = async (app, opts) => {
  const originalRoot = findMonorepoRoot(dirname(fileURLToPath(import.meta.url)));
  registerMessageStickerRoutes(app, {
    memory: join(originalRoot, 'packages/web/public/f321/stickers'),
    collaboration: join(originalRoot, 'docs/videos/shared-assets/cat-stickers/2026-10-11-collaboration'),
  });
  registerUploadedMediaFileActions(app, resolve(opts.uploadDir));
  await app.register(fastifyStatic, {
    root: resolve(opts.uploadDir),
    prefix: '/uploads/',
    decorateReply: false,
    setHeaders: setStoredFileHeaders,
  });
};
