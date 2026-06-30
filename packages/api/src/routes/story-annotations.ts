/**
 * F252 Phase D — Story Annotation CRUD routes (AC-D1).
 *
 * GET    /api/story/:storyId/annotations           → list all annotations
 * POST   /api/story/:storyId/annotations           → add new annotation
 * PUT    /api/story/:storyId/annotations/:annotId   → update annotation
 * DELETE /api/story/:storyId/annotations/:annotId   → remove annotation
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  type AddAnnotationInput,
  AnnotationFileStore,
  AnnotationNotFoundError,
  type UpdateAnnotationInput,
  VersionConflictError,
} from '../domains/story/annotation-store.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';

export interface StoryAnnotationRoutesOptions {
  annotationStore: AnnotationFileStore;
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

/** 鉴权检查 — session 或 callback principal 任一通过。 */
function isAuthenticated(request: FastifyRequest): boolean {
  const r = request as FastifyRequest & { sessionUserId?: string; callbackPrincipal?: unknown };
  return Boolean(r.sessionUserId) || Boolean(r.callbackPrincipal);
}

export const storyAnnotationRoutes: FastifyPluginAsync<StoryAnnotationRoutesOptions> = async (app, opts) => {
  const { annotationStore } = opts;

  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

  // ─── GET /api/story/:storyId/annotations ─────────────────────────

  app.get<{ Params: { storyId: string } }>('/api/story/:storyId/annotations', async (request, reply) => {
    if (!isAuthenticated(request)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const set = await annotationStore.get(request.params.storyId);
    return reply.send(set);
  });

  // ─── POST /api/story/:storyId/annotations ────────────────────────

  app.post<{
    Params: { storyId: string };
    Body: AddAnnotationInput;
  }>('/api/story/:storyId/annotations', async (request, reply) => {
    if (!isAuthenticated(request)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const { storyId } = request.params;
    const body = request.body as AddAnnotationInput;

    if (!body || typeof body.at !== 'number' || !body.kind || !body.content || typeof body.content !== 'string') {
      return reply
        .status(400)
        .send({ error: 'invalid_input', message: 'Required: at (number), kind, content (string)' });
    }

    if (body.kind !== 'narration' && body.kind !== 'highlight') {
      return reply.status(400).send({ error: 'invalid_kind', message: 'kind must be "narration" or "highlight"' });
    }

    const annotation = await annotationStore.add(storyId, body);
    return reply.status(201).send(annotation);
  });

  // ─── PUT /api/story/:storyId/annotations/:annotId ────────────────

  app.put<{
    Params: { storyId: string; annotId: string };
    Body: UpdateAnnotationInput & { expectedVersion?: number };
  }>('/api/story/:storyId/annotations/:annotId', async (request, reply) => {
    if (!isAuthenticated(request)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const { storyId, annotId } = request.params;
    const body = request.body as UpdateAnnotationInput & { expectedVersion?: number };
    const { expectedVersion, ...updateInput } = body ?? {};

    // Validate update fields — same constraints as POST (cloud R3 P2 + R4 P2-4)
    if (updateInput.at !== undefined && typeof updateInput.at !== 'number') {
      return reply.status(400).send({ error: 'invalid_input', message: 'at must be a number' });
    }
    if (updateInput.content !== undefined && typeof updateInput.content !== 'string') {
      return reply.status(400).send({ error: 'invalid_input', message: 'content must be a string' });
    }
    if (updateInput.kind !== undefined && updateInput.kind !== 'narration' && updateInput.kind !== 'highlight') {
      return reply.status(400).send({ error: 'invalid_kind', message: 'kind must be "narration" or "highlight"' });
    }

    try {
      const updated = await annotationStore.update(storyId, annotId, updateInput, expectedVersion);
      return reply.send(updated);
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return reply.status(409).send({ error: 'version_conflict', message: err.message });
      }
      if (err instanceof AnnotationNotFoundError) {
        return reply.status(404).send({ error: 'not_found', message: err.message });
      }
      throw err;
    }
  });

  // ─── DELETE /api/story/:storyId/annotations/:annotId ─────────────

  app.delete<{
    Params: { storyId: string; annotId: string };
  }>('/api/story/:storyId/annotations/:annotId', async (request, reply) => {
    if (!isAuthenticated(request)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const { storyId, annotId } = request.params;

    try {
      await annotationStore.remove(storyId, annotId);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof AnnotationNotFoundError) {
        return reply.status(404).send({ error: 'not_found', message: err.message });
      }
      throw err;
    }
  });
};
