import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { rankToMatchRank } from '../domains/memory/f163-types.js';
import type { IEvidenceStore, IReflectionService } from '../domains/memory/interfaces.js';
import { MessageSearchService } from '../domains/memory/MessageSearchService.js';
import type { MatterMemoryService } from '../domains/memory/matters/MatterMemoryService.js';
import { relevanceEvidence } from '../domains/memory/relevance-evidence.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { registerCallbackMessageSearchAnswerRoutes } from './callback-message-search-answer-routes.js';
import { registerCallbackRecallMetrics } from './callback-recall-metrics.js';
import { mapKindToSourceType } from './evidence-helpers.js';
import { registerCallbackMatterMemoryRoutes } from './memory-matter-routes.js';
import { executeMessageSearch, messageSearchQuerySchema, toMessageSearchInput } from './message-search-handler.js';

interface CallbackMemoryRoutesDeps {
  matterMemoryService?: MatterMemoryService;
  cloudReturnGrantStore?: Pick<
    import('../domains/cats/services/cloud-bridge/cloud-return-grant.js').CloudReturnGrantStore,
    'claim' | 'release'
  >;
  messageSearchAnswerService?: import('../domains/memory/MessageSearchAnswerPublicationService.js').MessageSearchAnswerPublicationService;
  registry?: Pick<
    import('../domains/cats/services/agents/invocation/InvocationRegistry.js').InvocationRegistry,
    'isLatest'
  >;
  messageSearchService?: MessageSearchService;
  messageStore?: Pick<IMessageStore, 'getById'>;
  threadStore?: Pick<IThreadStore, 'get' | 'list'>;
  /** F102: DI — SQLite-backed services (required) */
  evidenceStore: IEvidenceStore;
  reflectionService: IReflectionService;
}

const searchEvidenceQuerySchema = messageSearchQuerySchema;

const reflectSchema = z.object({
  query: z.string().trim().min(1),
});

export async function registerCallbackMemoryRoutes(
  app: FastifyInstance,
  deps: CallbackMemoryRoutesDeps,
): Promise<void> {
  registerCallbackMatterMemoryRoutes(app, deps.matterMemoryService);
  await registerCallbackRecallMetrics(app);
  registerCallbackMessageSearchAnswerRoutes(app, {
    service: deps.messageSearchAnswerService,
    threadStore: deps.threadStore,
    registry: deps.registry,
    cloudReturnGrantStore: deps.cloudReturnGrantStore,
  });
  const messageSearchService =
    deps.messageSearchService ??
    (deps.messageStore && deps.threadStore
      ? new MessageSearchService({
          evidenceStore: deps.evidenceStore,
          messageStore: deps.messageStore,
          threadStore: deps.threadStore,
        })
      : undefined);
  app.get('/api/callbacks/search-evidence', async (request, reply) => {
    // Persistent agents have no invocation or trigger message. Only the message
    // query consumes their verified, user-bound principal; legacy reads retain
    // their invocation-only admission.
    const agentKey =
      request.callbackPrincipal?.kind === 'agent_key' &&
      (request.query as { resultUnit?: unknown }).resultUnit === 'message'
        ? request.callbackPrincipal
        : undefined;
    const record = agentKey ? undefined : requireCallbackAuth(request, reply);
    if (!record && !agentKey) return;

    const parsed = searchEvidenceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parsed.error.issues };
    }
    const { q, limit } = parsed.data;

    if (parsed.data.resultUnit === 'message') {
      const authenticated = record ?? agentKey;
      if (!authenticated) return;
      const messageId = record?.originTriggerMessageId ?? record?.a2aTriggerMessageId;
      return executeMessageSearch(
        messageSearchService,
        toMessageSearchInput(parsed.data),
        {
          userId: authenticated.userId,
          viewer: { type: 'cat', catId: authenticated.catId },
          ...(record && messageId ? { source: { threadId: record.threadId, messageId } } : {}),
        },
        reply,
      );
    }

    try {
      const items = await deps.evidenceStore.search(q, { limit: limit ?? 5, includePullOnly: true });
      const results = items.map((item, index) => ({
        title: item.title,
        anchor: item.anchor,
        snippet: item.summary ?? '',
        matchRank: rankToMatchRank(index),
        rank: index + 1,
        relevance: relevanceEvidence(item, q),
        ...(item.retrievalScore != null ? { retrievalScore: item.retrievalScore } : {}),
        sourceType: mapKindToSourceType(item.kind),
        ...(item.authority ? { authority: item.authority } : {}),
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
      }));
      return { results, degraded: false };
    } catch {
      return { results: [], degraded: true, degradeReason: 'evidence_store_error' };
    }
  });

  app.post('/api/callbacks/reflect', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = reflectSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { query } = parsed.data;

    try {
      const reflection = await deps.reflectionService.reflect(query);
      return { reflection, degraded: false, dispositionMode: 'off' as const };
    } catch {
      return {
        reflection: '',
        degraded: true,
        degradeReason: 'reflection_service_error',
        dispositionMode: 'off' as const,
      };
    }
  });
}
