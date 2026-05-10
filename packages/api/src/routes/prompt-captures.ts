/**
 * F153 Prompt X-Ray: API routes for reading prompt captures.
 * All endpoints require session auth (localhost-only by default).
 */

import type { FastifyPluginAsync } from 'fastify';
import { getPromptCaptureStore } from '../infrastructure/debug/prompt-capture-bridge.js';
import { isPromptCaptureEnabled } from '../infrastructure/debug/prompt-capture-store.js';

function requireSession(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
): string | null {
  const userId = (request as import('fastify').FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

export const promptCaptureRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/debug/prompt-captures/status', async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const store = getPromptCaptureStore();
    return {
      enabled: isPromptCaptureEnabled(),
      mode: process.env.PROMPT_CAPTURE ?? 'off',
      catFilter: process.env.PROMPT_CAPTURE_CATS ?? null,
      ...store.stats(),
    };
  });

  app.get<{ Querystring: { threadId?: string; invocationId?: string; limit?: string } }>(
    '/api/debug/prompt-captures',
    async (request, reply) => {
      const userId = requireSession(request, reply);
      if (!userId) return;
      const store = getPromptCaptureStore();
      const limit = Math.max(1, Math.min(parseInt(request.query.limit ?? '20', 10) || 20, 100));

      if (request.query.invocationId) {
        return store.listByInvocation(request.query.invocationId, userId);
      }
      if (request.query.threadId) {
        return store.listByThread(request.query.threadId, limit, userId);
      }
      return reply.status(400).send({ error: 'Provide invocationId or threadId filter' });
    },
  );

  app.get<{ Params: { captureId: string } }>('/api/debug/prompt-captures/:captureId', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;
    const { captureId } = request.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(captureId)) {
      return reply.status(400).send({ error: 'Invalid captureId format' });
    }
    const capture = getPromptCaptureStore().read(captureId, userId);
    if (!capture) {
      return reply.status(404).send({ error: 'Capture not found or expired' });
    }
    return capture;
  });

  app.post('/api/debug/prompt-captures/prune', async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const removed = getPromptCaptureStore().prune();
    return { removed };
  });
};
