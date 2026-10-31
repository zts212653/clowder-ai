import {
  artifactReviewAnchorSchema,
  evolutionMediaLocatorSchema,
  workspaceContentReviewActionSchema,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WorkspaceFileQuoteDependencies } from '../domains/collaborative-content/workspace-review/file-quote-projection.js';
import type { WorkspaceContentReviewService } from '../domains/collaborative-content/workspace-review/service.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';
import { parseMediaByteRange, streamMediaByteRange } from './media-byte-range.js';
import { registerMediaFileActions } from './media-file-actions.js';
import { sendOrientedWebp } from './published-media-response.js';
import { replyWorkspaceContentReviewError } from './workspace-content-review-error.js';
import { registerWorkspaceFileQuoteRoutes } from './workspace-file-quote-routes.js';

const id = z.string().trim().min(1).max(256);
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const locatorSchema = z.object({ worktreeId: id, path: z.string().trim().min(1).max(2048) }).strict();
const paramsSchema = z.object({ reviewId: id }).strict();
const principalActor = (request: FastifyRequest) => {
  if (
    request.headers['x-invocation-id'] ||
    request.headers['x-callback-token'] ||
    request.headers['x-agent-key-secret']
  )
    return null;
  const userId = resolveDirectLocalAuthorizationUserId(request);
  return userId ? { userId, actor: { kind: 'human' as const, actorId: userId } } : null;
};

export function registerWorkspaceContentReviewRoutes(
  app: FastifyInstance,
  deps: {
    readonly reviews: WorkspaceContentReviewService;
    readonly namespace?: 'publication';
    readonly changed?: (ownerUserId: string, reviewId: string) => void;
    readonly fileQuotes?: WorkspaceFileQuoteDependencies;
  },
): void {
  const base = deps.namespace === 'publication' ? '/api/content-reviews' : '/api/workspace/content-reviews';
  if (deps.fileQuotes && !deps.namespace) registerWorkspaceFileQuoteRoutes(app, deps.fileQuotes);
  if (deps.namespace === 'publication')
    app.post(`${base}/resolve`, async (request, reply) => {
      try {
        reply.header('Cache-Control', 'private, no-store');
        const principal = principalActor(request);
        if (!principal) return reply.code(401).send({ error: { code: 'identity_required' } });
        const target = z
          .object({ contentRef: id, ownerRevision: z.number().int().positive().safe() })
          .strict()
          .parse(request.body);
        return { ownerUserId: principal.userId, contexts: await deps.reviews.resolvePublication(target, principal) };
      } catch (error) {
        return replyWorkspaceContentReviewError(reply, error);
      }
    });
  app.post(`${base}/prepare`, async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, no-store');
      const principal = principalActor(request);
      if (!principal) return reply.code(401).send({ error: { code: 'identity_required' } });
      const body =
        deps.namespace === 'publication'
          ? z
              .union([
                z.object({ evolution: evolutionMediaLocatorSchema, operationId: id }).strict(),
                z
                  .object({
                    publication: z
                      .object({ contentRef: id, ownerRevision: z.number().int().positive().safe() })
                      .strict(),
                    operationId: id,
                  })
                  .strict(),
              ])
              .parse(request.body)
          : z.object({ locator: locatorSchema, operationId: id }).strict().parse(request.body);
      return await deps.reviews.prepare({ principal, ...body });
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });

  app.get(`${base}/:reviewId`, async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, no-store');
      const principal = principalActor(request);
      if (!principal) return reply.code(401).send({ error: { code: 'identity_required' } });
      const { reviewId } = paramsSchema.parse(request.params);
      return await deps.reviews.read({ principal, reviewId });
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });

  app.get(`${base}/:reviewId/operations/:operationId`, async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, no-store');
      const principal = principalActor(request);
      if (!principal) return reply.code(401).send({ error: { code: 'identity_required' } });
      const params = z.object({ reviewId: id, operationId: id }).strict().parse(request.params);
      return { receipt: await deps.reviews.operationReceipt({ principal, ...params }) };
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });

  app.post(`${base}/:reviewId/annotations`, async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, no-store');
      const principal = principalActor(request);
      if (!principal) return reply.code(401).send({ error: { code: 'identity_required' } });
      const { reviewId } = paramsSchema.parse(request.params);
      const body = z
        .object({
          expectedRevision: z.number().int().positive(),
          operationId: id,
          body: z.string().trim().min(1).max(8000),
          target: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('text_quote'), quote: z.string().min(1).max(8000) }).strict(),
            z.object({ kind: z.literal('media_anchor'), anchor: artifactReviewAnchorSchema }).strict(),
          ]),
        })
        .strict()
        .parse(request.body);
      const result = await deps.reviews.annotate({ principal, reviewId, ...body });
      deps.changed?.(principal.userId, reviewId);
      return result;
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });

  app.post(`${base}/:reviewId/actions`, async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, no-store');
      const principal = principalActor(request);
      if (!principal) return reply.code(401).send({ error: { code: 'identity_required' } });
      const { reviewId } = paramsSchema.parse(request.params);
      const body = z
        .object({
          expectedRevision: z.number().int().positive(),
          operationId: id,
          action: workspaceContentReviewActionSchema,
        })
        .strict()
        .parse(request.body);
      const result = await deps.reviews.act({ principal, reviewId, ...body });
      deps.changed?.(principal.userId, reviewId);
      return result;
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });

  app.post(`${base}/:reviewId/refresh`, async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, no-store');
      const principal = principalActor(request);
      if (!principal) return reply.code(401).send({ error: { code: 'identity_required' } });
      const { reviewId } = paramsSchema.parse(request.params);
      const body = z
        .object({
          expectedRevision: z.number().int().positive(),
          operationId: id,
          expectedSourceRevision: revision.optional(),
        })
        .strict()
        .parse(request.body);
      return await deps.reviews.refresh({ principal, reviewId, ...body });
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });

  registerMediaFileActions(app, `${base}/:reviewId/media`, {
    onError: replyWorkspaceContentReviewError,
    authorize: async (request) => {
      const principal = principalActor(request);
      if (!principal) return null;
      const { reviewId } = paramsSchema.parse(request.params);
      const { expectedSourceRevision } = z.object({ expectedSourceRevision: revision }).strict().parse(request.query);
      const media = await deps.reviews.openMedia({ principal, reviewId, expectedSourceRevision });
      media.stream.destroy();
      if (!('localPath' in media) || typeof media.localPath !== 'string') return { local: false as const };
      return { path: media.localPath, mime: media.mime, byteLength: media.byteLength };
    },
  });
  app.get(`${base}/:reviewId/media`, async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, no-store');
      const principal = principalActor(request);
      if (!principal) return reply.code(401).send({ error: { code: 'identity_required' } });
      const { reviewId } = paramsSchema.parse(request.params);
      const { expectedSourceRevision, display } = z
        .object({ expectedSourceRevision: revision, display: z.literal('oriented').optional() })
        .strict()
        .parse(request.query);
      const media = await deps.reviews.openMedia({ principal, reviewId, expectedSourceRevision });
      if (display === 'oriented' && media.mime === 'image/webp') return await sendOrientedWebp(reply, media.stream);
      reply
        .header('Content-Type', media.mime)
        .header('Accept-Ranges', 'bytes')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store');
      const range = request.headers.range;
      if (!range) return reply.header('Content-Length', media.byteLength).send(media.stream);
      const parsed = parseMediaByteRange(range, media.byteLength);
      if (!parsed) {
        media.stream.destroy();
        return reply.code(416).header('Content-Range', `bytes */${media.byteLength}`).send();
      }
      return reply
        .code(206)
        .header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${media.byteLength}`)
        .header('Content-Length', parsed.end - parsed.start + 1)
        .send(streamMediaByteRange(media.stream, parsed));
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });
}
