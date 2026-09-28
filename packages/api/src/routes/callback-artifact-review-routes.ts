import {
  artifactReviewCommandSchema,
  prepareArtifactReviewSchema,
  respondWithMediaVersionSchema,
} from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  inspectArtifactReview,
  inspectArtifactReviewSchema,
} from '../domains/collaborative-content/artifact-review/inspection.js';
import type { ArtifactReviewService } from '../domains/collaborative-content/artifact-review/service.js';
import type { MediaReviewPrincipal } from '../domains/video-studio/content-owner/published-media-access.js';
import { replyArtifactReviewError } from './artifact-review-route-errors.js';
import {
  type AgentKeyAuthRegistry,
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackPrincipal,
} from './callback-auth-prehandler.js';
import { resolvePrincipalThread } from './callback-scope-helpers.js';

export interface CallbackArtifactReviewRoutesDeps {
  reviews: ArtifactReviewService;
  threads: Pick<IThreadStore, 'get' | 'list'>;
  registry: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
  changed: (ownerUserId: string, reviewId: string) => Promise<void>;
}
const scopeField = { threadId: z.string().min(1).max(128).optional() };
const schemas = {
  read: inspectArtifactReviewSchema.extend(scopeField),
  prepare: prepareArtifactReviewSchema.extend(scopeField),
  act: artifactReviewCommandSchema.extend(scopeField),
  respond: respondWithMediaVersionSchema.extend(scopeField),
} as const;

/** Each read/mutation has its own policy scope; invocation and agent-key auth both bind the real cat and permitted thread. */
export async function registerCallbackArtifactReviewRoutes(
  app: FastifyInstance,
  deps: CallbackArtifactReviewRoutesDeps,
) {
  for (const operation of ['read', 'prepare', 'act', 'respond'] as const) {
    await app.register(async (scope) => {
      registerCallbackAuthHook(scope, deps.registry, {
        ...(deps.agentKeyRegistry ? { agentKeyRegistry: deps.agentKeyRegistry } : {}),
        ...(operation === 'read' ? { enforceToolExecutionPolicy: false } : {}),
      });
      scope.post(
        `/api/callbacks/artifact-review/${operation}`,
        { bodyLimit: 5 * 1024 * 1024 },
        async (request, reply) => {
          reply.header('Cache-Control', 'private, no-store');
          const authenticated = requireCallbackPrincipal(request, reply);
          if (!authenticated) return;
          try {
            const parsed = schemas[operation].parse(request.body);
            const thread = await resolvePrincipalThread(authenticated, parsed.threadId, { threadStore: deps.threads });
            if (!thread.ok) return reply.code(thread.statusCode).send({ error: thread.error });
            const principal: MediaReviewPrincipal = {
              userId: authenticated.userId,
              threadId: thread.threadId,
              actor: { kind: 'cat', actorId: authenticated.catId },
            };
            const { threadId: _threadId, ...body } = parsed;
            if (operation === 'read') return await inspectArtifactReview(deps.reviews, body, principal);
            if (operation === 'prepare') {
              const view = await deps.reviews.prepare(body, principal);
              await deps.changed(principal.userId, view.review.reviewId);
              return {
                reviewId: view.review.reviewId,
                revision: view.review.revision,
                authority: view.authority,
                continuation: view.continuation,
              };
            }
            const result =
              operation === 'act'
                ? await deps.reviews.act(body, principal)
                : await deps.reviews.respond(body, principal);
            await deps.changed(principal.userId, result.view.review.reviewId);
            return {
              receipt: result.receipt,
              reviewId: result.view.review.reviewId,
              revision: result.view.review.revision,
              authority: result.view.authority,
              continuation: result.view.continuation,
            };
          } catch (error) {
            return replyArtifactReviewError(reply, error);
          }
        },
      );
    });
  }
}
