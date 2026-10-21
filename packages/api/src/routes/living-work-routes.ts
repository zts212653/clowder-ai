import { type WorkCommand, workCommandSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { WorkContextConflictError } from '../domains/collaborative-content/works/context-store.js';
import { inspectWorkResult } from '../domains/collaborative-content/works/inspection.js';
import {
  type LivingWorkService,
  type WorkPrincipal,
  WorkProjectionPendingError,
} from '../domains/collaborative-content/works/service.js';
import type { WorkVideoContextService } from '../domains/collaborative-content/works/video-context.js';
import { MediaOwnerError } from '../domains/video-studio/content-owner/media-errors.js';
import { WorkspaceContentSourceError } from '../domains/workspace/workspace-content-source.js';
import { replyArtifactReviewError } from './artifact-review-route-errors.js';
import {
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackPrincipal,
} from './callback-auth-prehandler.js';
import { directContentHuman } from './content-modification-routes.js';

const envelope = z.object({ threadId: z.string().min(1).max(128).optional(), command: workCommandSchema }).strict();
const callbackEnvelope = envelope.extend({
  contentTaskId: z.string().min(1).max(128).optional(),
  cursor: z
    .number()
    .int()
    .min(0)
    .max(16 * 1024 * 1024)
    .default(0),
  expectedSnapshot: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
});

async function run(
  service: LivingWorkService,
  command: WorkCommand,
  principal: WorkPrincipal,
  contexts?: WorkVideoContextService,
) {
  if (command.action === 'resolve-review-submission') return service.resolveReviewSubmission(command, principal);
  if (command.action === 'set-context' || command.action === 'import-context' || command.action === 'read-context') {
    if (!contexts) throw new MediaOwnerError('media_unavailable');
    if (command.action === 'import-context') return contexts.import(command, principal);
    return command.action === 'set-context'
      ? contexts.save(command, principal)
      : contexts.read(command.reference, principal, command.metadataRevision);
  }
  if (command.action === 'read') return service.read(command.reference, principal);
  if (command.action === 'publish-reference') return service.reference(command.reference, principal);
  if (command.action === 'list') return service.list(principal, command.after, command.catalogueSnapshot);
  if (command.action === 'inspect-source') return service.inspectSource(command.locator, principal);
  return service.commit(command, principal);
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof WorkContextConflictError) return reply.code(409).send({ error: 'context_conflict' });
  if (error instanceof WorkProjectionPendingError)
    return reply.code(503).send({
      status: 'version_saved',
      reference: { contentRef: error.receipt.contentRef, ownerRevision: error.receipt.ownerRevision },
      receipt: error.receipt,
      annotations: 'pending',
      retry: 'same_operation_and_payload',
    });
  if (error instanceof WorkspaceContentSourceError) {
    const codes: Readonly<Record<string, number>> = {
      access_denied: 403,
      not_found: 404,
      revision_changed: 409,
      too_large: 413,
    };
    const status = codes[error.code] ?? 400;
    return reply.code(status).send({ error: error.code });
  }
  return replyArtifactReviewError(reply, error);
}

export async function registerLivingWorkRoutes(
  app: FastifyInstance,
  deps: {
    service: LivingWorkService;
    registry: CallbackAuthRegistry;
    contexts?: WorkVideoContextService;
  },
) {
  app.post('/api/works/command', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const human = directContentHuman(request);
    if (!human) return reply.code(401).send({ error: 'identity_required' });
    try {
      const body = envelope.required({ threadId: true }).parse(request.body);
      return await run(deps.service, body.command, { ...human, threadId: body.threadId }, deps.contexts);
    } catch (error) {
      return fail(reply, error);
    }
  });
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, deps.registry);
    scope.post('/api/callbacks/work', { bodyLimit: 32 * 1024 }, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const authenticated = requireCallbackPrincipal(request, reply);
      if (!authenticated) return;
      if (authenticated.kind !== 'invocation')
        return reply.code(403).send({ error: 'current_production_invocation_required' });
      try {
        const body = callbackEnvelope.parse(request.body);
        if (body.threadId && body.threadId !== authenticated.threadId)
          return reply.code(403).send({ error: 'cross_thread_write' });
        const result = await run(
          deps.service,
          body.command,
          {
            userId: authenticated.userId,
            threadId: authenticated.threadId,
            actor: { kind: 'cat', actorId: authenticated.catId },
            invocationId: authenticated.invocationId,
            contentTaskId: body.contentTaskId,
          },
          deps.contexts,
        );
        return inspectWorkResult(body, result);
      } catch (error) {
        return fail(reply, error);
      }
    });
  });
}
