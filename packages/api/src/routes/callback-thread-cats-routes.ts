/**
 * GET /api/callbacks/thread-cats — discover cats in a thread via MCP callback auth.
 * Delegates to shared categorizeThreadCats() (F142). Auth: invocationId + callbackToken.
 */

import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { isCatAvailable } from '../config/cat-config-loader.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { categorizeThreadCats } from './thread-cats-core.js';

interface ThreadCatsCallbackDeps {
  threadStore: IThreadStore;
  agentRegistry: { getAllEntries(): Map<string, unknown> };
}

export function registerCallbackThreadCatsRoutes(app: FastifyInstance, deps: ThreadCatsCallbackDeps): void {
  const { threadStore, agentRegistry } = deps;

  app.get('/api/callbacks/thread-cats', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const threadId = record.threadId;
    if (!threadId) {
      reply.status(400);
      return { error: 'No threadId associated with this invocation' };
    }

    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

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
