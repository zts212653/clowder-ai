/**
 * F155: Guide Callback Routes
 * Thin wrappers — auth + parse → GuideLifecycleService → HTTP response.
 *
 * POST /api/callbacks/update-guide-state
 * POST /api/callbacks/start-guide
 * POST /api/callbacks/guide-resolve
 * POST /api/callbacks/guide-control
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { GuideLifecycleService } from '../domains/guides/GuideLifecycleService.js';
import { createGuideStoreBridge, type IGuideSessionStore } from '../domains/guides/GuideSessionRepository.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { callbackAuthSchema } from './callback-auth-schema.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const guideStatusSchema = z.enum(['offered', 'awaiting_choice', 'active', 'completed', 'cancelled']);

const updateGuideStateSchema = callbackAuthSchema.extend({
  threadId: z.string().min(1),
  guideId: z.string().min(1),
  status: guideStatusSchema,
  currentStep: z.number().int().min(0).optional(),
});

const startGuideSchema = callbackAuthSchema.extend({
  guideId: z.string().min(1),
});

const resolveGuideSchema = callbackAuthSchema.extend({
  intent: z.string().min(1),
});

const controlGuideSchema = callbackAuthSchema.extend({
  action: z.enum(['next', 'skip', 'exit']),
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export async function registerCallbackGuideRoutes(
  app: FastifyInstance,
  deps: {
    registry: InvocationRegistry;
    threadStore: IThreadStore;
    socketManager: SocketManager;
    guideSessionStore?: IGuideSessionStore;
    loadGuideFlow?: (guideId: string) => unknown;
  },
): Promise<void> {
  const { registry } = deps;

  // Static ESM import — fail loudly if loader is broken
  const {
    isValidGuideId,
    loadGuideFlow: defaultLoadGuideFlow,
    resolveGuideForIntent,
  } = await import('../domains/guides/guide-registry-loader.js');

  if (!deps.guideSessionStore) return; // Skip guide routes when store not provided (e.g. tests)
  const sessionStore = deps.guideSessionStore;
  const lifecycle = new GuideLifecycleService({
    threadStore: deps.threadStore,
    guideStore: createGuideStoreBridge(sessionStore),
    socketManager: deps.socketManager,
    log: app.log,
    isValidGuideId,
    loadGuideFlow: deps.loadGuideFlow ?? defaultLoadGuideFlow,
  });

  // POST /api/callbacks/update-guide-state
  app.post('/api/callbacks/update-guide-state', async (request, reply) => {
    const parsed = updateGuideStateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, threadId, guideId, status, currentStep } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }
    if (!registry.isLatest(invocationId)) return { status: 'stale_ignored' };
    if (record.threadId !== threadId) {
      reply.status(403);
      return { error: 'Cross-thread write rejected' };
    }

    const result = await lifecycle.updateGuideState({
      threadId,
      guideId,
      status,
      currentStep,
      userId: record.userId,
      catId: record.catId,
    });
    if (result.ok) return { guideState: result.guideState };
    reply.status(result.code);
    return {
      error: result.error,
      ...(result.message ? { message: result.message } : {}),
      ...(result.validTransitions ? { validTransitions: result.validTransitions } : {}),
    };
  });

  // POST /api/callbacks/start-guide
  app.post('/api/callbacks/start-guide', async (request, reply) => {
    const parsed = startGuideSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const { invocationId, callbackToken, guideId } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }
    if (!registry.isLatest(invocationId)) return { status: 'stale_ignored' };

    const result = await lifecycle.startGuideCallback({
      threadId: record.threadId,
      guideId,
      userId: record.userId,
    });
    if (!result.ok) {
      reply.status(result.code);
      return { error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    return { status: 'ok', guideId, guideState: result.guideState };
  });

  // POST /api/callbacks/guide-resolve
  app.post('/api/callbacks/guide-resolve', async (request, reply) => {
    const parsed = resolveGuideSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const { invocationId, callbackToken, intent } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    const matches = resolveGuideForIntent(intent);
    app.log.info({ intent, matchCount: matches.length, threadId: record.threadId }, '[F155] guide_resolve');
    return { status: 'ok', matches };
  });

  // POST /api/callbacks/guide-control
  app.post('/api/callbacks/guide-control', async (request, reply) => {
    const parsed = controlGuideSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const { invocationId, callbackToken, action } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }
    if (!registry.isLatest(invocationId)) return { status: 'stale_ignored' };

    const result = await lifecycle.controlGuide({
      threadId: record.threadId,
      userId: record.userId,
      action,
    });
    if (!result.ok) {
      reply.status(result.code);
      return { error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    return { status: 'ok', action };
  });
}
