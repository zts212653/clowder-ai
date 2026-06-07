/**
 * F153 Prompt X-Ray: API routes for reading prompt captures.
 * All endpoints require session auth (localhost-only by default).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getPromptCaptureStore } from '../infrastructure/debug/prompt-capture-bridge.js';
import { isPromptCaptureEnabled } from '../infrastructure/debug/prompt-capture-store.js';
import { requirePrivilegedRouteOwner } from '../utils/privileged-route-guard.js';

const PROMPT_CAPTURE_GATE = {
  surface: 'Prompt capture debug routes',
  ownerErrorMessage: 'Prompt captures can only be accessed by the configured owner',
};

function requirePromptCaptureOwner(request: FastifyRequest, reply: FastifyReply) {
  return requirePrivilegedRouteOwner(request, reply, PROMPT_CAPTURE_GATE);
}

export const promptCaptureRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/debug/prompt-captures/status', async (request, reply) => {
    const gate = requirePromptCaptureOwner(request, reply);
    if (!gate.ok) return gate.response;
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
      const gate = requirePromptCaptureOwner(request, reply);
      if (!gate.ok) return gate.response;
      const { userId } = gate;
      const store = getPromptCaptureStore();
      const limit = Math.min(parseInt(request.query.limit ?? '20', 10) || 20, 100);

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
    const gate = requirePromptCaptureOwner(request, reply);
    if (!gate.ok) return gate.response;
    const { userId } = gate;
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
    const gate = requirePromptCaptureOwner(request, reply);
    if (!gate.ok) return gate.response;
    const removed = getPromptCaptureStore().prune();
    return { removed };
  });
};
