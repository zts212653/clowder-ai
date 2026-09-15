/**
 * GET /api/callbacks/thread-cats — discover cats in a thread via MCP callback auth.
 * Delegates to shared categorizeThreadCats() (F142). Both principals use canonical thread scope.
 */

import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isCatAvailable } from '../config/cat-config-loader.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';
import { resolvePrincipalThread } from './callback-scope-helpers.js';
import { categorizeThreadCats } from './thread-cats-core.js';

interface ThreadCatsCallbackDeps {
  threadStore: IThreadStore;
  agentRegistry: { getAllEntries(): Map<string, unknown> };
}

const querySchema = z.object({ threadId: z.string().trim().min(1).max(200).optional() });

export function registerCallbackThreadCatsRoutes(app: FastifyInstance, deps: ThreadCatsCallbackDeps): void {
  const { threadStore, agentRegistry } = deps;

  app.get('/api/callbacks/thread-cats', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid threadId query' });
    const scope = await resolvePrincipalThread(principal, parsed.data.threadId, { threadStore });
    if (!scope.ok) return reply.status(scope.statusCode).send({ error: scope.error });

    const threadId = scope.threadId;
    if (!threadId) {
      reply.status(400);
      return { error: 'No threadId associated with this invocation' };
    }

    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }
    if (thread.deletedAt) return reply.status(410).send({ error: 'Thread is deleted', code: 'THREAD_DELETED' });

    const allCatConfigs = catRegistry.getAllConfigs();
    const participantActivity = await threadStore.getParticipantsWithActivity(threadId);
    const result = categorizeThreadCats({
      participantActivity: participantActivity.map((p) => ({
        catId: p.catId as string,
        lastMessageAt: p.lastMessageAt,
        messageCount: p.messageCount,
        lastResponseHealthy: p.lastResponseHealthy,
      })),
      registeredServices: agentRegistry.getAllEntries(),
      allCatIds: Object.keys(allCatConfigs),
      getCatDisplayName: (catId: string) => allCatConfigs[catId]?.displayName ?? catId,
      isCatAvailable,
    });

    return {
      threadId,
      ...result,
      routingPolicy: thread.routingPolicy ? `v${thread.routingPolicy.v}` : null,
    };
  });
}
