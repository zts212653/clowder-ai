/**
 * F155: Frontend-Facing Guide Action Routes
 *
 * These endpoints are called directly by the frontend InteractiveBlock
 * when a user clicks a guide option with an `action` field.
 * They use userId-based auth (X-Cat-Cafe-User header), NOT MCP callback auth.
 *
 * POST /api/guide-actions/start   — start a guide (offered/awaiting_choice → active)
 * POST /api/guide-actions/preview — preview steps (offered → awaiting_choice)
 * POST /api/guide-actions/cancel  — cancel a guide (offered/awaiting_choice → cancelled)
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { type GuideStateV1, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { loadGuideFlow } from '../domains/guides/guide-registry-loader.js';
import { canAccessGuideState, canAccessThread, isSharedDefaultThread } from '../domains/guides/guide-state-access.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface GuideActionRoutesOptions {
  threadStore: IThreadStore;
  socketManager: SocketManager;
}

const startSchema = z.object({
  threadId: z.string().min(1),
  guideId: z.string().min(1),
});

const cancelSchema = z.object({
  threadId: z.string().min(1),
  guideId: z.string().min(1),
});

const previewSchema = z.object({
  threadId: z.string().min(1),
  guideId: z.string().min(1),
});

const completeSchema = z.object({
  threadId: z.string().min(1),
  guideId: z.string().min(1),
});

export const guideActionRoutes: FastifyPluginAsync<GuideActionRoutesOptions> = async (app, opts) => {
  const { threadStore, socketManager } = opts;
  const log = app.log;

  // POST /api/guide-actions/start — frontend clicks "开始引导"
  app.post('/api/guide-actions/start', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { threadId, guideId } = parsed.data;
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    if (!canAccessThread(thread, userId)) {
      reply.status(403);
      return { error: 'Thread access denied' };
    }

    // P1 fix: validate flow is loadable before committing state transition
    try {
      loadGuideFlow(guideId);
    } catch (err) {
      log.warn({ guideId, threadId, err }, '[F155] start rejected — flow not loadable');
      reply.status(400);
      return { error: 'guide_flow_invalid', message: (err as Error).message };
    }

    const gs = thread.guideState;
    if (!gs) {
      // Self-healing: card was delivered but offered state never persisted.
      // Block on shared default thread — anyone can access it, so self-heal
      // would let any authenticated user manufacture guide state.
      if (isSharedDefaultThread(thread)) {
        reply.status(409);
        return { error: 'guide_not_offered', message: 'No guide offered on shared thread' };
      }
      // offeredBy (catId) is unavailable here — frontend has userId only. Routing layer
      // tolerates undefined offeredBy; completion notice simply won't target a specific cat.
      const created: GuideStateV1 = {
        v: 1,
        guideId,
        status: 'active',
        userId,
        offeredAt: Date.now(),
        startedAt: Date.now(),
      };
      await threadStore.updateGuideState(threadId, created);
      socketManager.emitToUser(userId, 'guide_start', { guideId, threadId, timestamp: Date.now() });
      log.info({ guideId, threadId, userId }, '[F155] guide started (self-healed missing offered state)');
      return { status: 'ok', guideId, guideState: created };
    }
    if (gs.guideId !== guideId) {
      reply.status(400);
      return { error: 'guide_not_offered', message: `Guide "${guideId}" not offered in this thread` };
    }
    if (!canAccessGuideState(thread, gs, userId)) {
      reply.status(403);
      return { error: 'Guide access denied' };
    }
    if (gs.status !== 'offered' && gs.status !== 'awaiting_choice') {
      reply.status(400);
      return { error: `Cannot start guide in status "${gs.status}"` };
    }

    const updated: GuideStateV1 = { ...gs, status: 'active', startedAt: Date.now() };
    await threadStore.updateGuideState(threadId, updated);

    // Guide UI events must stay user-scoped because the default thread is shared.
    socketManager.emitToUser(userId, 'guide_start', {
      guideId,
      threadId,
      timestamp: Date.now(),
    });
    log.info({ guideId, threadId, userId }, '[F155] guide started via frontend action');
    return { status: 'ok', guideId, guideState: updated };
  });

  // GET /api/guide-flows/:guideId — serve flow definition at runtime
  app.get<{ Params: { guideId: string } }>('/api/guide-flows/:guideId', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const { guideId } = request.params;
    try {
      const flow = loadGuideFlow(guideId);
      return flow;
    } catch (err) {
      log.warn({ guideId, err }, '[F155] Failed to load guide flow');
      reply.status(404);
      return { error: 'guide_not_found', message: (err as Error).message };
    }
  });

  // POST /api/guide-actions/cancel — frontend clicks "暂不需要"
  app.post('/api/guide-actions/cancel', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parsed = cancelSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { threadId, guideId } = parsed.data;
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    if (!canAccessThread(thread, userId)) {
      reply.status(403);
      return { error: 'Thread access denied' };
    }

    const gs = thread.guideState;
    // No state or different guide — nothing to cancel (self-healing for card-first delivery)
    if (!gs || gs.guideId !== guideId) {
      return { status: 'ok', guideState: null };
    }
    if (!canAccessGuideState(thread, gs, userId)) {
      reply.status(403);
      return { error: 'Guide access denied' };
    }
    if (gs.status === 'completed' || gs.status === 'cancelled') {
      return { status: 'ok', guideState: gs };
    }

    const updated: GuideStateV1 = { ...gs, status: 'cancelled', completedAt: Date.now() };
    await threadStore.updateGuideState(threadId, updated);

    socketManager.emitToUser(userId, 'guide_control', {
      action: 'exit',
      guideId,
      threadId,
      timestamp: Date.now(),
    });
    log.info({ guideId, threadId, userId }, '[F155] guide cancelled via frontend action');
    return { status: 'ok', guideState: updated };
  });

  // POST /api/guide-actions/preview — frontend clicks "先看步骤概览"
  app.post('/api/guide-actions/preview', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { threadId, guideId } = parsed.data;
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    if (!canAccessThread(thread, userId)) {
      reply.status(403);
      return { error: 'Thread access denied' };
    }

    let flow;
    try {
      flow = loadGuideFlow(guideId);
    } catch {
      reply.status(400);
      return { error: 'guide_flow_invalid', message: `Guide flow "${guideId}" not found` };
    }

    const gs = thread.guideState;
    if (!gs) {
      // Self-heal: card delivered but offered state never persisted.
      // Block on shared default thread — any authenticated user could
      // manufacture guide state and occupy the single guide slot.
      if (isSharedDefaultThread(thread)) {
        reply.status(409);
        return { error: 'guide_not_offered', message: 'No guide offered on shared thread' };
      }
      const created: GuideStateV1 = {
        v: 1,
        guideId,
        status: 'awaiting_choice',
        userId,
        offeredAt: Date.now(),
      };
      await threadStore.updateGuideState(threadId, created);
      log.info({ guideId, threadId, userId }, '[F155] guide preview (self-healed to awaiting_choice)');
      return { status: 'ok', guideState: created, flow };
    }

    if (gs.guideId !== guideId) {
      reply.status(400);
      return { error: 'guide_not_offered', message: `Guide "${guideId}" not offered in this thread` };
    }
    if (!canAccessGuideState(thread, gs, userId)) {
      reply.status(403);
      return { error: 'Guide access denied' };
    }

    // Transition offered → awaiting_choice; idempotent if already awaiting_choice
    if (gs.status === 'offered') {
      const updated: GuideStateV1 = { ...gs, status: 'awaiting_choice' };
      await threadStore.updateGuideState(threadId, updated);
      log.info({ guideId, threadId, userId }, '[F155] guide preview (offered → awaiting_choice)');
      return { status: 'ok', guideState: updated, flow };
    }

    return { status: 'ok', guideState: gs, flow };
  });

  // POST /api/guide-actions/complete — frontend guide overlay finished all steps
  app.post('/api/guide-actions/complete', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parsed = completeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { threadId, guideId } = parsed.data;
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    if (!canAccessThread(thread, userId)) {
      reply.status(403);
      return { error: 'Thread access denied' };
    }

    const gs = thread.guideState;
    if (!gs || gs.guideId !== guideId) {
      reply.status(400);
      return { error: 'guide_not_active', message: `Guide "${guideId}" not active in this thread` };
    }
    if (!canAccessGuideState(thread, gs, userId)) {
      reply.status(403);
      return { error: 'Guide access denied' };
    }
    if (gs.status === 'completed') {
      return { status: 'ok', guideState: gs };
    }
    if (gs.status !== 'active') {
      reply.status(400);
      return { error: `Cannot complete guide in status "${gs.status}"` };
    }

    const updated: GuideStateV1 = { ...gs, status: 'completed', completedAt: Date.now() };
    await threadStore.updateGuideState(threadId, updated);

    socketManager.emitToUser(userId, 'guide_complete', {
      guideId,
      threadId,
      timestamp: Date.now(),
    });
    log.info({ guideId, threadId, userId }, '[F155] guide completed via frontend action');
    return { status: 'ok', guideId, guideState: updated };
  });
};
