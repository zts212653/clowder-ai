/**
 * Callback Authorization Routes — 猫猫请求权限 + 查询结果
 * 安全: invocationId + callbackToken 验证 (同 callbacks.ts)
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { AuthorizationManager } from '../domains/cats/services/auth/AuthorizationManager.js';
import { registerCallbackAuthHook, requireCallbackAuth } from './callback-auth-prehandler.js';

export interface CallbackAuthRoutesOptions {
  authManager: AuthorizationManager;
  registry: InvocationRegistry;
}

const requestPermissionSchema = z.object({
  action: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
  context: z.string().max(5000).optional(),
});

const permissionStatusSchema = z.object({
  requestId: z.string().min(1),
});

export const callbackAuthRoutes: FastifyPluginAsync<CallbackAuthRoutesOptions> = async (app, opts) => {
  const { authManager, registry } = opts;
  registerCallbackAuthHook(app, registry);

  // POST /api/callbacks/request-permission
  app.post('/api/callbacks/request-permission', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parseResult = requestPermissionSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { action, reason, context } = parseResult.data;

    const response = await authManager.requestPermission(
      record.catId,
      record.threadId,
      {
        invocationId: record.invocationId,
        action,
        reason,
        ...(context ? { context } : {}),
      },
      record.userId,
    );

    return response;
  });

  // GET /api/callbacks/permission-status
  app.get('/api/callbacks/permission-status', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parseResult = permissionStatusSchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Missing required query parameters' };
    }

    const { requestId } = parseResult.data;

    const status = await authManager.getRequestStatus(requestId);
    if (!status) {
      reply.status(404);
      return { error: 'Permission request not found' };
    }

    // P2 fix: 校验 requestId 严格归属当前 invocation
    if (
      status.invocationId !== record.invocationId ||
      status.catId !== record.catId ||
      status.threadId !== record.threadId
    ) {
      reply.status(403);
      return { error: 'Permission request belongs to a different invocation' };
    }

    return {
      requestId: status.requestId,
      status: status.status,
      action: status.action,
      createdAt: status.createdAt,
      ...(status.respondReason ? { reason: status.respondReason } : {}),
      ...(status.respondScope ? { scope: status.respondScope } : {}),
      ...(status.respondedAt ? { respondedAt: status.respondedAt } : {}),
    };
  });
};
