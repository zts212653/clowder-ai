import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { DEFAULT_THREAD_ID, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface ConnectorHubRoutesOptions {
  threadStore: IThreadStore;
}

function requireTrustedHubIdentity(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = resolveHeaderUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  return userId;
}

export const connectorHubRoutes: FastifyPluginAsync<ConnectorHubRoutesOptions> = async (app, opts) => {
  const { threadStore } = opts;

  app.get('/api/connector/hub-threads', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) {
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const allThreads = await threadStore.list(userId);
    const hubThreads = allThreads
      .filter((t) => t.connectorHubState && t.id !== DEFAULT_THREAD_ID)
      .sort((a, b) => (b.connectorHubState?.createdAt ?? 0) - (a.connectorHubState?.createdAt ?? 0));
    return {
      threads: hubThreads.map((t) => ({
        id: t.id,
        title: t.title,
        connectorId: t.connectorHubState?.connectorId,
        externalChatId: t.connectorHubState?.externalChatId,
        createdAt: t.connectorHubState?.createdAt,
        lastCommandAt: t.connectorHubState?.lastCommandAt,
      })),
    };
  });
};
