/**
 * GET /api/threads/:id/cats — Thread cat categorization API (F142)
 *
 * Returns participants, routable cats, and availability status for a thread.
 * Auth: connector-bound threads require binding owner header (P1 v4 fix).
 */

import type { FastifyPluginAsync } from 'fastify';
import { resolveHeaderUserId } from '../utils/request-identity.js';
import type { ParticipantActivityInput } from './thread-cats-core.js';
import { categorizeThreadCats } from './thread-cats-core.js';

export interface ThreadCatsRoutesOptions {
  threadStore: {
    get(id: string):
      | { id: string; title?: string | null; routingPolicy?: { v: number; scopes?: unknown } | null }
      | null
      | Promise<{
          id: string;
          title?: string | null;
          routingPolicy?: { v: number; scopes?: unknown } | null;
        } | null>;
    getParticipantsWithActivity(threadId: string): ParticipantActivityInput[] | Promise<ParticipantActivityInput[]>;
  };
  agentRegistry: {
    getAllEntries(): Map<string, unknown>;
  };
  bindingStore: {
    getByThread(threadId: string): Array<{ userId: string }> | Promise<Array<{ userId: string }>>;
  };
  getCatDisplayName: (catId: string) => string;
  getAllCatIds: () => string[];
  isCatAvailable: (catId: string) => boolean;
}

export const threadCatsRoutes: FastifyPluginAsync<ThreadCatsRoutesOptions> = async (app, opts) => {
  const { threadStore, agentRegistry, bindingStore, getCatDisplayName, getAllCatIds, isCatAvailable } = opts;

  app.get<{ Params: { id: string } }>('/api/threads/:id/cats', async (request, reply) => {
    const { id } = request.params;

    // 1. Thread exists?
    const thread = await threadStore.get(id);
    if (!thread) return reply.status(404).send({ error: 'Thread not found' });

    // 2. Auth: connector binding owner check (P1 v4)
    const bindings = await bindingStore.getByThread(id);
    if (bindings.length > 0) {
      const requestUserId = resolveHeaderUserId(request);
      if (!requestUserId) {
        return reply.status(401).send({ error: 'Authentication required' });
      }
      if (!bindings.some((b) => b.userId === requestUserId)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
    }

    // 3. Categorize via shared core (KD-9)
    const participantActivity = await threadStore.getParticipantsWithActivity(id);
    const result = categorizeThreadCats({
      participantActivity,
      registeredServices: agentRegistry.getAllEntries(),
      allCatIds: getAllCatIds(),
      getCatDisplayName,
      isCatAvailable,
    });

    return {
      ...result,
      routingPolicy: thread.routingPolicy ? `v${thread.routingPolicy.v}` : null,
    };
  });
};
