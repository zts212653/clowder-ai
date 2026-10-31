import { videoProjectCommandSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { runProjectCommand } from '../domains/collaborative-content/modification/project/command.js';
import type { ProjectMessageTakeoverService } from '../domains/collaborative-content/modification/project/service.js';
import type { VideoProjectReviewService } from '../domains/collaborative-content/workspace-review/video-project-review-service.js';
import {
  ContentOwnerConflictError,
  ContentOwnerIdempotencyError,
  ContentOwnerNotFoundError,
} from '../domains/video-studio/content-owner/service.js';
import type { VideoProjectSelfReviewService } from '../domains/video-studio/project/self-review.js';
import type { VideoProjectService } from '../domains/video-studio/project/service.js';
import {
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackPrincipal,
} from './callback-auth-prehandler.js';
import { resolvePrincipalThread } from './callback-scope-helpers.js';
import { replyContentModificationError } from './content-modification-routes.js';

/** One invocation-authenticated project command resource; browser identities and agent keys cannot impersonate a child. */
export async function registerCallbackVideoProjectCommandRoutes(
  app: FastifyInstance,
  deps: {
    projects: VideoProjectService;
    reviews: VideoProjectReviewService;
    selfReviews: VideoProjectSelfReviewService;
    takeover: ProjectMessageTakeoverService;
    threads: Pick<IThreadStore, 'get' | 'list'>;
    registry: CallbackAuthRegistry;
    changed?: (ownerUserId: string, contentRef: string) => void;
  },
) {
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, deps.registry);
    scope.post('/api/callbacks/video-project/command', { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const auth = requireCallbackPrincipal(request, reply);
      if (!auth) return;
      if (auth.kind !== 'invocation') return reply.code(403).send({ error: 'invocation_required' });
      try {
        const thread = await resolvePrincipalThread(auth, undefined, { threadStore: deps.threads });
        if (!thread.ok) return reply.code(thread.statusCode).send({ error: thread.error });
        const principal = {
          userId: auth.userId,
          threadId: thread.threadId,
          actor: { kind: 'cat' as const, actorId: auth.catId },
          invocationId: auth.invocationId,
        };
        const input = videoProjectCommandSchema.parse(request.body);
        return await runProjectCommand(deps, input, principal);
      } catch (error) {
        return projectCommandFailure(reply, error);
      }
    });
  });
}

function projectCommandFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof ContentOwnerConflictError)
    return reply.code(409).send({ error: error.code, actualOwnerRevision: error.actualOwnerRevision });
  if (error instanceof ContentOwnerIdempotencyError) return reply.code(409).send({ error: error.code });
  if (error instanceof ContentOwnerNotFoundError) return reply.code(404).send({ error: 'not_found' });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', details: error.issues });
  if (error instanceof TypeError) return reply.code(400).send({ error: 'invalid_request' });
  return replyContentModificationError(reply, error);
}
