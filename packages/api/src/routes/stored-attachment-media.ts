/** Serve existing stored attachment URLs independently of any installed plugin. */
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';
import { setStoredFileHeaders } from './file-byte-response-headers.js';

export interface StoredAttachmentMediaRoutesOptions {
  mediaDir: string;
}

export const storedAttachmentMediaRoutes: FastifyPluginAsync<StoredAttachmentMediaRoutesOptions> = async (
  app,
  opts,
) => {
  await app.register(fastifyStatic, {
    root: resolve(opts.mediaDir),
    // Persisted messages retain these URLs; this route contains no platform handling.
    prefix: '/api/connector-media/',
    decorateReply: false,
    setHeaders: setStoredFileHeaders,
  });
};
