/**
 * Uploads Static File Route
 * Serves uploaded images from the uploads directory.
 */

import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';
import { registerUploadedMediaFileActions } from './local-media-file-actions.js';

export interface UploadsRoutesOptions {
  uploadDir: string;
}

export const uploadsRoutes: FastifyPluginAsync<UploadsRoutesOptions> = async (app, opts) => {
  registerUploadedMediaFileActions(app, resolve(opts.uploadDir));
  await app.register(fastifyStatic, {
    root: resolve(opts.uploadDir),
    prefix: '/uploads/',
    decorateReply: false,
  });
};
