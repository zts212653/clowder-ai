/**
 * F155: Frontend-Facing Guide Action Routes
 * Thin wrappers — userId auth + parse → GuideActionService → HTTP response.
 *
 * POST /api/guide-actions/start    — start a guide
 * GET  /api/guide-flows/:guideId   — serve flow definition
 * POST /api/guide-actions/cancel   — cancel a guide
 * POST /api/guide-actions/preview  — preview steps
 * POST /api/guide-actions/complete — mark guide completed
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { GuideActionService } from '../domains/guides/GuideActionService.js';
import { createGuideStoreBridge, type IGuideSessionStore } from '../domains/guides/GuideSessionRepository.js';
import { isValidGuideId, loadGuideFlow } from '../domains/guides/guide-registry-loader.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface GuideActionRoutesOptions {
  threadStore: IThreadStore;
  socketManager: SocketManager;
  guideSessionStore?: IGuideSessionStore;
  /** B-6: Dismiss tracker for re-offer suppression */
  dismissTracker?: import('../domains/guides/GuideDismissTracker.js').IGuideDismissTracker;
}

const guideActionSchema = z.object({
  threadId: z.string().min(1),
  guideId: z.string().min(1),
});

export const guideActionRoutes: FastifyPluginAsync<GuideActionRoutesOptions> = async (app, opts) => {
  if (!opts.guideSessionStore) return; // Skip guide routes when store not provided (e.g. tests)
  const sessionStore = opts.guideSessionStore;
  const lifecycle = new GuideActionService({
    threadStore: opts.threadStore,
    guideStore: createGuideStoreBridge(sessionStore),
    socketManager: opts.socketManager,
    log: app.log,
    isValidGuideId,
    loadGuideFlow,
    dismissTracker: opts.dismissTracker,
  });

  // POST /api/guide-actions/start
  app.post('/api/guide-actions/start', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const parsed = guideActionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { threadId, guideId } = parsed.data;
    const result = await lifecycle.startGuideAction({ threadId, guideId, userId });
    if (!result.ok) {
      reply.status(result.code);
      return { error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    return { status: 'ok', guideId, guideState: result.guideState };
  });

  // GET /api/guide-flows/:guideId — serve flow definition at runtime
  app.get<{ Params: { guideId: string } }>('/api/guide-flows/:guideId', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    try {
      return loadGuideFlow(request.params.guideId);
    } catch (err) {
      app.log.warn({ guideId: request.params.guideId, err }, '[F155] Failed to load guide flow');
      reply.status(404);
      return { error: 'guide_not_found', message: (err as Error).message };
    }
  });

  // POST /api/guide-actions/cancel
  app.post('/api/guide-actions/cancel', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const parsed = guideActionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { threadId, guideId } = parsed.data;
    const result = await lifecycle.cancelGuideAction({ threadId, guideId, userId });
    if (!result.ok) {
      reply.status(result.code);
      return { error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    return { status: 'ok', guideState: result.guideState };
  });

  // POST /api/guide-actions/preview
  app.post('/api/guide-actions/preview', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const parsed = guideActionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { threadId, guideId } = parsed.data;
    const result = await lifecycle.previewGuideAction({ threadId, guideId, userId });
    if (!result.ok) {
      reply.status(result.code);
      return { error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    return { status: 'ok', guideState: result.guideState, flow: result.flow };
  });

  // POST /api/guide-actions/complete
  app.post('/api/guide-actions/complete', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const parsed = guideActionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { threadId, guideId } = parsed.data;
    const result = await lifecycle.completeGuideAction({ threadId, guideId, userId });
    if (!result.ok) {
      reply.status(result.code);
      return { error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    return { status: 'ok', guideId, guideState: result.guideState };
  });
};
