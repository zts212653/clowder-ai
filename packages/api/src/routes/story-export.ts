/**
 * F252 Phase D — Story Export routes (AC-D2).
 *
 * POST   /api/story/:storyId/export     → create sanitized export pack
 * GET    /api/story/:storyId/public     → serve latest export (no auth!)
 * DELETE /api/story/:storyId/export/:exportId → remove export
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AnnotationFileStore } from '../domains/story/annotation-store.js';
import type { CatIdentityAliases } from '../domains/story/content-sanitizer.js';
import type { StoryExportStore } from '../domains/story/export-store.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';

export interface StoryExportRoutesOptions {
  exportStore: StoryExportStore;
  annotationStore: AnnotationFileStore;
  /** Callback to fetch transcript events for a story. */
  fetchTranscriptEvents: (storyId: string) => Promise<
    Array<{
      id: string;
      at: number;
      kind: string;
      content: string;
      toolName?: string;
      toolArgs?: string;
      toolResult?: string;
      catId?: string;
    }>
  >;
  /** Pre-built identity aliases for Class D redaction coverage. */
  catIdentityAliases?: CatIdentityAliases;
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

function isAuthenticated(request: FastifyRequest): boolean {
  const r = request as FastifyRequest & { sessionUserId?: string; callbackPrincipal?: unknown };
  return Boolean(r.sessionUserId) || Boolean(r.callbackPrincipal);
}

export const storyExportRoutes: FastifyPluginAsync<StoryExportRoutesOptions> = async (app, opts) => {
  const { exportStore, annotationStore, fetchTranscriptEvents } = opts;

  // Auth for create/delete — NOT for public GET
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

  // ─── POST /api/story/:storyId/export ─────────────────────────

  app.post<{
    Params: { storyId: string };
    Body: { title?: string };
  }>('/api/story/:storyId/export', async (request, reply) => {
    if (!isAuthenticated(request)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const { storyId } = request.params;
    const title = (request.body as { title?: string })?.title ?? `${storyId} Export`;

    // Fetch transcript events for this story
    const events = await fetchTranscriptEvents(storyId);

    // Fetch annotations for this story
    const annotationSet = await annotationStore.get(storyId);

    // Create sanitized export (with full identity alias coverage)
    const pack = await exportStore.create(storyId, title, events, annotationSet.annotations, opts.catIdentityAliases);

    return reply.status(201).send(pack.manifest);
  });

  // ─── GET /api/story/:storyId/public ──────────────────────────
  // Public — no auth required. Serves the latest sanitized export.

  app.get<{ Params: { storyId: string } }>(
    '/api/story/:storyId/public',
    { config: { skipAuth: true } as Record<string, unknown> },
    async (request, reply) => {
      const { storyId } = request.params;

      const pack = await exportStore.getLatest(storyId);
      if (!pack) {
        return reply.status(404).send({ error: 'not_found', message: 'No export available for this story' });
      }

      return reply.send(pack);
    },
  );

  // ─── DELETE /api/story/:storyId/export/:exportId ──────────────

  app.delete<{
    Params: { storyId: string; exportId: string };
  }>('/api/story/:storyId/export/:exportId', async (request, reply) => {
    if (!isAuthenticated(request)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    await exportStore.delete(request.params.storyId, request.params.exportId);
    return reply.status(204).send();
  });
};
