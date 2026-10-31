import { videoProjectReviewActionSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { VideoProjectMessageImporter } from '../domains/collaborative-content/workspace-review/project-message/import.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { replyWorkspaceContentReviewError } from './workspace-content-review-error.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';

const id = z.string().trim().min(1).max(256);
const params = z.object({ contentRef: id });
const source = z.object({ threadId: id }).strict();
export function registerVideoProjectReviewRoutes(app: FastifyInstance, importer: VideoProjectMessageImporter) {
  const base = '/api/video-projects/:contentRef/review';
  app.post(`${base}/synchronize`, async (request, reply) => {
    const principal = human(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { contentRef } = params.parse(request.params),
        { threadId } = source.parse(request.body);
      return await importer.synchronize({ principal, contentRef, threadId, limit: 100 });
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });
  app.get(base, async (request, reply) => {
    const principal = human(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      reply.header('Cache-Control', 'private, no-store');
      const { contentRef } = params.parse(request.params);
      return await importer.reviews.prepare({ principal, contentRef, operationId: `browser-review-${contentRef}` });
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });
  app.post(`${base}/actions`, async (request, reply) => {
    const principal = human(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { contentRef } = params.parse(request.params);
      const body = z
        .object({
          expectedRevision: z.number().int().positive(),
          operationId: id,
          action: videoProjectReviewActionSchema,
        })
        .strict()
        .parse(request.body);
      // Human UI can reopen; Cat modifications retain their own authenticated action path.
      if (body.action.kind !== 'reopened') return reply.code(400).send({ error: 'invalid_action' });
      const view = await importer.reviews.prepare({
        principal,
        contentRef,
        operationId: `browser-review-${contentRef}`,
      });
      return await importer.reviews.act({ ...body, principal, reviewId: view.review.reviewId });
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });
  app.get(`${base}/operations/:operationId`, async (request, reply) => {
    const principal = human(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { contentRef, operationId } = params.extend({ operationId: id }).parse(request.params);
      const view = await importer.reviews.prepare({
        principal,
        contentRef,
        operationId: `browser-review-${contentRef}`,
      });
      return {
        receipt: await importer.reviews.operationReceipt({ principal, reviewId: view.review.reviewId, operationId }),
      };
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });
}
function human(request: FastifyRequest) {
  const userId = isDirectLoopbackRequest(request) ? workspaceDirectHuman(request, resolveSessionUserId) : null;
  return userId ? { userId, actor: { kind: 'human' as const, actorId: userId } } : null;
}
