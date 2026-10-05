import { contentModificationRequestSchema, contentModificationSourceSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { createContentModificationIntegration } from '../domains/collaborative-content/modification/composition.js';
import {
  ContentModificationJournalError,
  modificationRequestId,
} from '../domains/collaborative-content/modification/journal.js';
import { ModificationTargetError } from '../domains/collaborative-content/modification/target-service.js';
import { ModificationTextError } from '../domains/collaborative-content/modification/text/text-store.js';
import { WorkspaceContentSourceError } from '../domains/workspace/workspace-content-source.js';
import { WorkspaceWritebackError } from '../domains/workspace/writeback/journal.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';
import { replyArtifactReviewError } from './artifact-review-route-errors.js';

const params = z.object({ requestId: z.string().regex(/^f309-modification-[a-f0-9]{64}$/) }).strict();
type Services = ReturnType<typeof createContentModificationIntegration>;

export function directContentHuman(request: FastifyRequest) {
  if (
    request.headers['x-invocation-id'] ||
    request.headers['x-callback-token'] ||
    request.headers['x-agent-key-secret']
  )
    return null;
  const userId = resolveDirectLocalAuthorizationUserId(request);
  return userId ? { userId, actor: { kind: 'human' as const, actorId: userId } } : null;
}

export function registerContentModificationRoutes(app: FastifyInstance, deps: Services) {
  app.get('/api/content-modifications/by-operation/:operationId', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { operationId } = z.object({ operationId: z.string().uuid() }).strict().parse(request.params);
      return await deps.requests.read(modificationRequestId(principal.userId, operationId), principal);
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
  app.post('/api/content-modifications/context', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { source } = z.object({ source: contentModificationSourceSchema }).strict().parse(request.body);
      return await deps.context.read(source, principal);
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
  app.post('/api/content-modifications/selection', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const input = z
        .object({ source: contentModificationSourceSchema, quote: z.string().min(1).max(8000) })
        .strict()
        .parse(request.body);
      if (input.source.kind !== 'workspace') return reply.code(400).send({ error: 'unsupported_text' });
      const result = await deps.selection({ ...input, source: input.source }, principal);
      if (result.status !== 'attached') return reply.code(409).send({ error: `selection_${result.status}` });
      return result;
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
  app.get('/api/content-modifications/choices', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      return await deps.targets.choices(principal.userId);
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
  app.post('/api/content-modifications', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      return await deps.requests.submit(contentModificationRequestSchema.parse(request.body), principal);
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
  app.get('/api/content-modifications/:requestId', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { requestId } = params.parse(request.params),
        view = await deps.requests.read(requestId, principal);
      const candidates = await deps.results.candidates(view.record, principal);
      const sourceDiscussions = await deps.sourceDiscussions.forRequest(requestId, principal);
      const acceptances = await deps.results.acceptances(view.record, principal);
      const writeback = view.record.progress.review ? await deps.results.writeback(view.record, principal) : undefined;
      const text =
        view.record.progress.prepared?.kind === 'text' && view.record.progress.review
          ? await deps.text.read(requestId, principal)
          : undefined;
      return {
        ...view,
        runtimeControls: await deps.runtimeControls.list(requestId, principal.userId),
        rejections: deps.results.rejections(requestId, principal.userId),
        candidates,
        sourceDiscussions,
        acceptances,
        ...(text ? { text } : {}),
        ...(writeback ? { writeback } : {}),
      };
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
  app.post('/api/content-modifications/:requestId/accept', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { requestId } = params.parse(request.params);
      const body = z
        .object({ requestId: z.literal(requestId) })
        .passthrough()
        .parse(request.body);
      return await deps.results.accept(body, principal);
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
  app.post('/api/content-modifications/:requestId/reject', async (request, reply) => {
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { requestId } = params.parse(request.params);
      const { candidateRef } = z
        .object({ candidateRef: z.string().min(1).max(1000) })
        .strict()
        .parse(request.body);
      return await deps.results.reject(requestId, candidateRef, principal);
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
  app.post('/api/content-modifications/:requestId/cancel', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      z.object({}).strict().parse(request.body);
      const { requestId } = params.parse(request.params);
      return await deps.requests.cancel(requestId, principal);
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
  app.post('/api/content-modifications/:requestId/runtime-controls', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { requestId } = params.parse(request.params);
      return await deps.runtimeControls.confirm(requestId, request.body, principal);
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
}

export function replyContentModificationError(reply: FastifyReply, error: unknown) {
  if (error instanceof ModificationTargetError)
    return reply.code(409).send({ error: error.code, ...(error.decision ? { preflight: error.decision } : {}) });
  if (
    error instanceof WorkspaceWritebackError ||
    error instanceof ContentModificationJournalError ||
    error instanceof ModificationTextError ||
    error instanceof WorkspaceContentSourceError
  )
    return reply.code(MODIFICATION_ERROR_STATUS[error.code] ?? 409).send({ error: error.code });
  return replyArtifactReviewError(reply, error);
}

const MODIFICATION_ERROR_STATUS: Readonly<Record<string, number>> = {
  edit_token_invalid: 401,
  identity_required: 401,
  access_denied: 403,
  not_found: 404,
  invalid_patch: 400,
  too_large: 413,
  unsupported_text: 415,
  unsupported_media: 415,
};
