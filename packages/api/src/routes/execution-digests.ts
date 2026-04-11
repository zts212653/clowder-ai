/**
 * F070 Phase 3: Execution Digest routes — read-only API for dispatch backflow data
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ExecutionDigestStore } from '../domains/projects/execution-digest-store.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface ExecutionDigestRoutesOptions {
  executionDigestStore: ExecutionDigestStore;
}

export const executionDigestRoutes: FastifyPluginAsync<ExecutionDigestRoutesOptions> = async (app, opts) => {
  const { executionDigestStore } = opts;

  function requireUserId(request: FastifyRequest, reply: FastifyReply): string | null {
    const userId = resolveHeaderUserId(request) ?? undefined;
    if (!userId) {
      void reply.status(401).send({ error: 'Identity required' });
      return null;
    }
    return userId;
  }

  // GET /api/execution-digests — list with optional filters, scoped to userId
  app.get('/api/execution-digests', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectPath, threadId } = request.query as {
      projectPath?: string;
      threadId?: string;
    };
    if (projectPath) {
      return { digests: executionDigestStore.listByProject(projectPath, userId) };
    }
    if (threadId) {
      return { digests: executionDigestStore.listByThread(threadId, userId) };
    }
    return { digests: executionDigestStore.listAll(userId) };
  });

  // GET /api/execution-digests/:id — single digest, scoped to userId
  app.get<{ Params: { id: string } }>('/api/execution-digests/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const digest = executionDigestStore.getById(request.params.id);
    if (!digest || digest.userId !== userId) {
      return reply.status(404).send({ error: 'Digest not found' });
    }
    return { digest };
  });
};
