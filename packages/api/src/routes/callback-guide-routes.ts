/**
 * F155: Guide Callback Routes
 * Thin wrappers — auth + parse → GuideLifecycleService → HTTP response.
 *
 * POST /api/callbacks/update-guide-state
 * POST /api/callbacks/start-guide
 * POST /api/callbacks/get-available-guides
 * POST /api/callbacks/guide-control
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getProjectResolvedCats } from '../config/resolved-cats.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { GuideLifecycleService } from '../domains/guides/GuideLifecycleService.js';
import { createGuideStoreBridge, type IGuideSessionStore } from '../domains/guides/GuideSessionRepository.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const guideStatusSchema = z.enum(['offered', 'awaiting_choice', 'active', 'completed', 'cancelled']);

const updateGuideStateSchema = z.object({
  threadId: z.string().min(1),
  guideId: z.string().min(1),
  status: guideStatusSchema,
  currentStep: z.number().int().min(0).optional(),
});

const startGuideSchema = z.object({
  guideId: z.string().min(1),
});

const resolveGuideSchema = z.object({
  intent: z.string().min(1).optional(),
});

const controlGuideSchema = z.object({
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
    getGuideAvailabilityContext?: (
      threadId: string,
    ) => Promise<{ memberCardCount: number }> | { memberCardCount: number };
  },
): Promise<void> {
  const { registry } = deps;

  // Static ESM import — fail loudly if loader is broken
  const {
    isValidGuideId,
    loadGuideFlow: defaultLoadGuideFlow,
    getAvailableGuides,
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
  const getGuideAvailabilityContext =
    deps.getGuideAvailabilityContext ??
    (async (threadId: string) => {
      const thread = await Promise.resolve(deps.threadStore.get(threadId));
      const projectRoot =
        thread?.projectPath && thread.projectPath !== 'default' ? thread.projectPath : resolveActiveProjectRoot();
      return { memberCardCount: Object.keys(getProjectResolvedCats(projectRoot)).length };
    });

  const getAvailableGuidesResponse = async (request: FastifyRequest, reply: FastifyReply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const guides = getAvailableGuides(await getGuideAvailabilityContext(record.threadId));
    app.log.info({ guideCount: guides.length, threadId: record.threadId }, '[F155] get_available_guides');
    return { status: 'ok', guides };
  };

  // POST /api/callbacks/update-guide-state
  app.post('/api/callbacks/update-guide-state', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = updateGuideStateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { threadId, guideId, status, currentStep } = parsed.data;
    if (!registry.isLatest(record.invocationId)) return { status: 'stale_ignored' };
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
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = startGuideSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const { guideId } = parsed.data;
    if (!registry.isLatest(record.invocationId)) return { status: 'stale_ignored' };

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

  // POST /api/callbacks/get-available-guides
  app.post('/api/callbacks/get-available-guides', getAvailableGuidesResponse);

  // POST /api/callbacks/guide-resolve (legacy alias during tool rename rollout)
  app.post('/api/callbacks/guide-resolve', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = resolveGuideSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const context = await getGuideAvailabilityContext(record.threadId);
    const intent = parsed.data.intent?.trim();
    if (intent) {
      const matches = resolveGuideForIntent(intent, context);
      app.log.info({ intent, matchCount: matches.length, threadId: record.threadId }, '[F155] guide_resolve');
      return { status: 'ok', matches };
    }

    const guides = getAvailableGuides(context);
    app.log.info({ guideCount: guides.length, threadId: record.threadId }, '[F155] guide_resolve_discovery_alias');
    return { status: 'ok', guides };
  });

  // POST /api/callbacks/guide-control
  app.post('/api/callbacks/guide-control', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = controlGuideSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const { action } = parsed.data;
    if (!registry.isLatest(record.invocationId)) return { status: 'stale_ignored' };

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
