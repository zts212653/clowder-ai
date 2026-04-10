/**
 * Thread Cats Callback Route — TD #408
 * GET /api/callbacks/thread-cats — discover cats in a thread via MCP callback auth.
 *
 * Delegates to shared categorizeThreadCats() — same logic as GET /api/threads/:id/cats (F142).
 * Auth: invocationId + callbackToken instead of binding-owner header.
 */

import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { isCatAvailable } from '../config/cat-config-loader.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { callbackAuthSchema } from './callback-auth-schema.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';
import { categorizeThreadCats } from './thread-cats-core.js';

interface ThreadCatsCallbackDeps {
  registry: InvocationRegistry;
  threadStore: IThreadStore;
  agentRegistry: { getAllEntries(): Map<string, unknown> };
}

const threadCatsQuerySchema = callbackAuthSchema;

export function registerCallbackThreadCatsRoutes(app: FastifyInstance, deps: ThreadCatsCallbackDeps): void {
  const { registry, threadStore, agentRegistry } = deps;

  app.get('/api/callbacks/thread-cats', async (request, reply) => {
    const parsed = threadCatsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Missing invocationId or callbackToken' };
    }

    const { invocationId, callbackToken } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

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
