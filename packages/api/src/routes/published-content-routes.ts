import { mediaPublicationSourceSchema, messageMediaPublicationSourceSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PublishedMediaService } from '../domains/video-studio/content-owner/published-media-service.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';
import { replyArtifactReviewError } from './artifact-review-route-errors.js';
import { directContentHuman } from './content-modification-routes.js';
import { sendPublishedMedia } from './published-media-response.js';

const id = z.string().min(1).max(256);
const publication = z.object({ contentRef: id, ownerRevision: z.coerce.number().int().positive().safe() }).strict();

export function registerPublishedContentRoutes(app: FastifyInstance, deps: { media: PublishedMediaService }): void {
  app.post('/api/content-publications/resolve', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const body = z
        .object({ source: messageMediaPublicationSourceSchema, operationId: id, selection: publication.optional() })
        .strict()
        .parse(request.body);
      return await deps.media.resolveMessage({ ...body, principal });
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
  app.get('/api/content-publications/:contentRef', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { contentRef } = z.object({ contentRef: id }).strict().parse(request.params);
      const { ownerRevision } = z
        .object({ ownerRevision: z.coerce.number().int().positive().safe().optional() })
        .strict()
        .parse(request.query);
      return await deps.media.describe(contentRef, ownerRevision, principal);
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
  app.post('/api/content-publications/prepare', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (
      !userId ||
      request.headers['x-invocation-id'] ||
      request.headers['x-callback-token'] ||
      request.headers['x-agent-key-secret']
    )
      return reply.code(401).send({ error: 'identity_required' });
    try {
      const body = z.object({ source: mediaPublicationSourceSchema, operationId: id }).strict().parse(request.body);
      return await deps.media.prepare({ ...body, principal: { userId, actor: { kind: 'human', actorId: userId } } });
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
  app.get('/api/content-publications/:contentRef/media/:ownerRevision', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (
      !userId ||
      request.headers['x-invocation-id'] ||
      request.headers['x-callback-token'] ||
      request.headers['x-agent-key-secret']
    )
      return reply.code(401).send({ error: 'identity_required' });
    try {
      const { contentRef, ownerRevision } = publication.parse(request.params);
      const principal = { userId, actor: { kind: 'human' as const, actorId: userId } };
      const asset = await deps.media.read(contentRef, ownerRevision, principal);
      return await sendPublishedMedia(request, reply, await deps.media.openAsset(asset, principal));
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
}
