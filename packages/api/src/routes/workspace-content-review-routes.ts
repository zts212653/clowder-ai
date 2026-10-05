import {
  artifactReviewAnchorSchema,
  evolutionMediaLocatorSchema,
  workspaceContentReviewActionSchema,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { WorkspaceContentReviewError } from '../domains/collaborative-content/workspace-review/errors.js';
import type { WorkspaceContentReviewService } from '../domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentSourceError } from '../domains/workspace/workspace-content-source.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';
import { parseMediaByteRange, streamMediaByteRange } from './media-byte-range.js';

const id = z.string().trim().min(1).max(256);
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const locatorSchema = z.object({ worktreeId: id, path: z.string().trim().min(1).max(2048) }).strict();
const paramsSchema = z.object({ reviewId: id }).strict();
const SOURCE_ERROR_STATUS: Record<WorkspaceContentSourceError['code'], number> = {
  access_denied: 403,
  not_found: 404,
  revision_changed: 409,
  too_large: 413,
  unsupported_media: 415,
  unsupported_text: 415,
};
const REVIEW_ERROR_STATUS: Record<WorkspaceContentReviewError['code'], number> = {
  access_denied: 403,
  not_found: 404,
  invalid_action: 400,
  operation_reused: 409,
  revision_conflict: 409,
  source_changed: 409,
  source_unavailable: 409,
  version_pending: 409,
  unsupported_content: 415,
  existing_contexts: 409,
};
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
  },
): void {
  const base = deps.namespace === 'publication' ? '/api/content-reviews' : '/api/workspace/content-reviews';
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

  app.get(`${base}/:reviewId/media`, async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, no-store');
      const principal = principalActor(request);
      if (!principal) return reply.code(401).send({ error: { code: 'identity_required' } });
      const { reviewId } = paramsSchema.parse(request.params);
      const { expectedSourceRevision } = z.object({ expectedSourceRevision: revision }).strict().parse(request.query);
      const media = await deps.reviews.openMedia({ principal, reviewId, expectedSourceRevision });
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

function replyWorkspaceContentReviewError(reply: FastifyReply, error: unknown) {
  if (error instanceof WorkspaceContentSourceError) {
    return reply.code(SOURCE_ERROR_STATUS[error.code]).send({ error: { code: error.code } });
  }
  if (error instanceof WorkspaceContentReviewError) {
    return reply
      .code(REVIEW_ERROR_STATUS[error.code])
      .send({ error: { code: error.code, ...(error.contexts ? { contexts: error.contexts } : {}) } });
  }
  if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_request' } });
  return reply.code(500).send({ error: { code: 'workspace_content_unavailable' } });
}
