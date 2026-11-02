/**
 * Uploads Static File Route
 * Serves uploaded images from the uploads directory.
 */

import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';
import { setStoredFileHeaders } from './file-byte-response-headers.js';
import { registerUploadedMediaFileActions } from './local-media-file-actions.js';
import { resolveMessageStickerDirectories } from './message-sticker-runtime-assets.js';
import { registerMessageStickerRoutes } from './message-stickers.js';

export interface UploadsRoutesOptions {
  uploadDir: string;
}

export const uploadsRoutes: FastifyPluginAsync<UploadsRoutesOptions> = async (app, opts) => {
  registerMessageStickerRoutes(app, resolveMessageStickerDirectories());
  registerUploadedMediaFileActions(app, resolve(opts.uploadDir));
  await app.register(fastifyStatic, {
    root: resolve(opts.uploadDir),
    prefix: '/uploads/',
    decorateReply: false,
    setHeaders: setStoredFileHeaders,
  });
};
