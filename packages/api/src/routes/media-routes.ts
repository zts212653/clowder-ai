import type { FastifyPluginAsync } from 'fastify';
import type { FileMessagingMediaLedger } from '../domains/messaging/media-ledger.js';

export interface MediaRoutesOptions {
  readonly ledger: FileMessagingMediaLedger;
  readonly ownerUserId: string;
}

const HMR_ID = /^hmr_[A-Za-z0-9_-]{32}$/;

export const mediaRoutes: FastifyPluginAsync<MediaRoutesOptions> = async (app, opts) => {
  const notFound = (reply: import('fastify').FastifyReply) => reply.status(404).send({ error: 'Media not found' });
  app.get('/api/media/hmr/*', async (request, reply) => {
    if (request.sessionUserId !== opts.ownerUserId) return reply.status(401).send({ error: 'Unauthorized' });
    return notFound(reply);
  });
  app.get<{ Params: { hmrId: string } }>('/api/media/hmr/:hmrId', async (request, reply) => {
    if (request.sessionUserId !== opts.ownerUserId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const { hmrId } = request.params;
    if (!HMR_ID.test(hmrId)) return notFound(reply);
    let verified: Awaited<ReturnType<FileMessagingMediaLedger['openVerifiedStream']>>;
    try {
      verified = await opts.ledger.openVerifiedStream(hmrId);
    } catch {
      return notFound(reply);
    }
    if (!verified) return notFound(reply);
    return (
      reply
        .header('content-type', verified.mimeType ?? 'application/octet-stream')
        .header('content-length', verified.byteLength)
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        // Mime type is supplied by an importer; a direct visit to active content must not run it.
        .header('content-security-policy', 'sandbox')
        .send(verified.stream)
    );
  });
};
