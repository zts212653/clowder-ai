import type { PreparedMediaReviewContext } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ArtifactReviewService } from '../domains/collaborative-content/artifact-review/service.js';
import type { MediaReviewPrincipal } from '../domains/video-studio/content-owner/published-media-access.js';
import { resolveStrictUserId } from '../utils/request-identity.js';
import { replyArtifactReviewError } from './artifact-review-route-errors.js';

const paramsSchema = z.object({ reviewId: z.string().min(1).max(128) }).strict();
export interface ArtifactReviewRoutesDeps {
  reviews: ArtifactReviewService;
  changed: (ownerUserId: string, reviewId: string) => Promise<void>;
  contexts: (
    input: { threadId: string; artifactRef: string },
    principal: MediaReviewPrincipal,
  ) => Promise<PreparedMediaReviewContext[]>;
}

export function registerArtifactReviewRoutes(app: FastifyInstance, deps: ArtifactReviewRoutesDeps): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!humanPrincipal(request)) return reply.code(401).send({ error: 'identity_required' });
  });
  app.post('/api/artifact-reviews/prepare', async (request, reply) => {
    try {
      const principal = humanPrincipal(request);
      if (!principal) return;
      const view = await deps.reviews.prepare(request.body, principal);
      await deps.changed(principal.userId, view.review.reviewId);
      return view;
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
  app.get('/api/artifact-reviews/context', async (request, reply) => {
    try {
      const principal = humanPrincipal(request);
      if (!principal) return;
      const input = z
        .object({ threadId: z.string().min(1).max(128), artifactRef: z.string().min(1).max(2048) })
        .strict()
        .parse(request.query);
      return { contexts: await deps.contexts(input, principal) };
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
  app.get('/api/artifact-reviews', async (request, reply) => {
    try {
      const principal = humanPrincipal(request);
      if (!principal) return;
      const { taskId } = z
        .object({ taskId: z.string().min(1).max(128) })
        .strict()
        .parse(request.query);
      return { reviews: await deps.reviews.listForTask(taskId, principal) };
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
  app.get('/api/artifact-reviews/:reviewId', async (request, reply) => {
    try {
      const principal = humanPrincipal(request);
      if (!principal) return;
      return await deps.reviews.read(paramsSchema.parse(request.params).reviewId, principal);
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
  // A bounded batch of 100 strokes × 300 finite points fits within 2 MiB, including JSON overhead.
  app.post('/api/artifact-reviews/:reviewId/actions', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    try {
      const principal = humanPrincipal(request);
      if (!principal) return;
      const { reviewId } = paramsSchema.parse(request.params);
      const body = z
        .object({ reviewId: z.literal(reviewId) })
        .passthrough()
        .parse(request.body);
      const result = await deps.reviews.act(body, principal);
      await deps.changed(principal.userId, reviewId);
      return { ...result, view: await deps.reviews.read(reviewId, principal) };
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
  app.get('/api/artifact-reviews/:reviewId/history', async (request, reply) => {
    try {
      const principal = humanPrincipal(request);
      if (!principal) return;
      const query = z
        .object({
          afterRevision: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(20).default(10),
        })
        .strict()
        .parse(request.query);
      return await deps.reviews.history(
        paramsSchema.parse(request.params).reviewId,
        principal,
        query.afterRevision,
        query.limit,
      );
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
  app.get('/api/artifact-reviews/:reviewId/media/:round', async (request, reply) => {
    try {
      const principal = humanPrincipal(request);
      if (!principal) return;
      const { reviewId, round } = paramsSchema
        .extend({ round: z.coerce.number().int().positive() })
        .parse(request.params);
      const media = await deps.reviews.openMedia(reviewId, round, principal);
      reply
        .header('Content-Type', media.mediaType)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Accept-Ranges', 'bytes');
      try {
        const range = request.headers.range;
        if (!range)
          return reply
            .header('Content-Length', media.byteLength)
            .send(media.handle.createReadStream({ autoClose: true }));
        const parsed = parseRange(range, media.byteLength);
        if (!parsed) {
          await media.handle.close();
          return reply.code(416).header('Content-Range', `bytes */${media.byteLength}`).send();
        }
        return reply
          .code(206)
          .header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${media.byteLength}`)
          .header('Content-Length', parsed.end - parsed.start + 1)
          .send(media.handle.createReadStream({ ...parsed, autoClose: true }));
      } catch (error) {
        await media.handle.close();
        throw error;
      }
    } catch (error) {
      return replyArtifactReviewError(reply, error);
    }
  });
}

function humanPrincipal(request: FastifyRequest): MediaReviewPrincipal | null {
  if (
    request.headers['x-invocation-id'] ||
    request.headers['x-callback-token'] ||
    request.headers['x-agent-key-secret']
  )
    return null;
  const userId = resolveStrictUserId(request);
  return userId ? { userId, actor: { kind: 'human', actorId: userId } } : null;
}

function parseRange(value: string, length: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const suffix = !match[1];
  const first = Number(match[1] || match[2]);
  const end = suffix || !match[2] ? length - 1 : Math.min(Number(match[2]), length - 1);
  const start = suffix ? Math.max(0, length - first) : first;
  return Number.isSafeInteger(first) &&
    Number.isSafeInteger(end) &&
    (!suffix || first > 0) &&
    start <= end &&
    start < length
    ? { start, end }
    : null;
}
