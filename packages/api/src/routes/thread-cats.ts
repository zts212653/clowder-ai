/**
 * GET /api/threads/:id/cats — Thread cat categorization API (F142)
 *
 * Returns participants, routable cats, and availability status for a thread.
 * Auth: connector-bound threads require binding owner header (P1 v4 fix).
 */

import type { FastifyPluginAsync } from 'fastify';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface ParticipantActivity {
  catId: string;
  lastMessageAt: number;
  messageCount: number;
  lastResponseHealthy?: boolean;
}

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
    getParticipantsWithActivity(threadId: string): ParticipantActivity[] | Promise<ParticipantActivity[]>;
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

    // 3. Gather data
    const participantActivity = await threadStore.getParticipantsWithActivity(id);
    const registeredServices = agentRegistry.getAllEntries();
    const allCatIds = getAllCatIds();
    const participantIds = new Set(participantActivity.map((p) => p.catId));

    // 4. Categorize (KD-9: notRoutable = strictly available=false, non-participants only)
    const routableNow: Array<{ catId: string; displayName: string }> = [];
    const routableNotJoined: Array<{ catId: string; displayName: string }> = [];
    const notRoutable: Array<{ catId: string; displayName: string }> = [];

    for (const catId of allCatIds) {
      const hasService = registeredServices.has(catId);
      const available = isCatAvailable(catId);
      const isParticipant = participantIds.has(catId);

      if (!available && !isParticipant) {
        notRoutable.push({ catId, displayName: getCatDisplayName(catId) });
      } else if (hasService && available && !isParticipant) {
        routableNotJoined.push({ catId, displayName: getCatDisplayName(catId) });
      }
    }

    // routableNow = participants with service + available
    for (const p of participantActivity) {
      if (registeredServices.has(p.catId) && isCatAvailable(p.catId)) {
        routableNow.push({ catId: p.catId, displayName: getCatDisplayName(p.catId) });
      }
    }

    return {
      participants: participantActivity.map((p) => ({
        catId: p.catId,
        displayName: getCatDisplayName(p.catId),
        lastMessageAt: p.lastMessageAt,
        messageCount: p.messageCount,
      })),
      routableNow,
      routableNotJoined,
      notRoutable,
      routingPolicy: thread.routingPolicy ? `v${thread.routingPolicy.v}` : null,
    };
  });
};
