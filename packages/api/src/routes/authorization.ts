/**
 * Authorization Management Routes — 铲屎官审批 + 规则管理 + 审计查询
 * 安全: X-Cat-Cafe-User header（兼容 legacy x-user-id）
 */

import type { CatId } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AuthorizationManager } from '../domains/cats/services/auth/AuthorizationManager.js';
import type { IAuthorizationAuditStore } from '../domains/cats/services/stores/ports/AuthorizationAuditStore.js';
import type { IAuthorizationRuleStore } from '../domains/cats/services/stores/ports/AuthorizationRuleStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface AuthorizationRoutesOptions {
  authManager: AuthorizationManager;
  ruleStore: IAuthorizationRuleStore;
  auditStore: IAuthorizationAuditStore;
  socketManager: SocketManager;
}

function resolveAuthorizationUserId(request: {
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  const fromPrimary = request.headers['x-cat-cafe-user'];
  if (typeof fromPrimary === 'string' && fromPrimary.trim().length > 0) return fromPrimary.trim();
  if (Array.isArray(fromPrimary) && typeof fromPrimary[0] === 'string' && fromPrimary[0].trim().length > 0) {
    return fromPrimary[0].trim();
  }

  // Legacy compatibility: old clients used x-user-id
  const fromLegacy = request.headers['x-user-id'];
  if (typeof fromLegacy === 'string' && fromLegacy.trim().length > 0) return fromLegacy.trim();
  if (Array.isArray(fromLegacy) && typeof fromLegacy[0] === 'string' && fromLegacy[0].trim().length > 0) {
    return fromLegacy[0].trim();
  }

  return null;
}

const respondSchema = z.object({
  requestId: z.string().min(1),
  granted: z.boolean(),
  scope: z.enum(['once', 'thread', 'global']),
  reason: z.string().max(1000).optional(),
});

const addRuleSchema = z.object({
  catId: z.string().min(1),
  action: z.string().min(1).max(200),
  scope: z.enum(['thread', 'global']),
  decision: z.enum(['allow', 'deny']),
  threadId: z.string().optional(),
  reason: z.string().max(1000).optional(),
});

export const authorizationRoutes: FastifyPluginAsync<AuthorizationRoutesOptions> = async (app, opts) => {
  const { authManager, ruleStore, auditStore, socketManager } = opts;

  // POST /api/authorization/respond — 铲屎官审批
  app.post('/api/authorization/respond', async (request, reply) => {
    const userId = resolveAuthorizationUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parseResult = respondSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { requestId, granted, scope, reason } = parseResult.data;
    const updated = await authManager.respond(requestId, granted, scope, userId, reason);
    if (!updated) {
      reply.status(404);
      return { error: 'Request not found or already resolved' };
    }

    // Broadcast resolution to frontend
    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'authorization:response', {
      requestId,
      status: updated.status,
      scope,
      ...(reason ? { reason } : {}),
    });

    return { status: 'ok', record: updated };
  });

  // GET /api/authorization/pending — 待审批列表
  app.get('/api/authorization/pending', async (request, reply) => {
    const userId = resolveAuthorizationUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const threadId = (request.query as Record<string, string>).threadId;
    const pending = await authManager.getPending(threadId);
    return { pending };
  });

  // GET /api/authorization/rules — 规则列表
  app.get('/api/authorization/rules', async (request, reply) => {
    const userId = resolveAuthorizationUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const query = request.query as Record<string, string>;
    const rules = await ruleStore.list({
      ...(query.catId ? { catId: query.catId as CatId } : {}),
      ...(query.threadId ? { threadId: query.threadId } : {}),
    });
    return { rules };
  });

  // POST /api/authorization/rules — 手动添加规则
  app.post('/api/authorization/rules', async (request, reply) => {
    const userId = resolveAuthorizationUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parseResult = addRuleSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { catId, action, scope, decision, threadId, reason } = parseResult.data;
    const rule = await ruleStore.add({
      catId: catId as CatId,
      action,
      scope,
      decision,
      ...(scope === 'thread' && threadId ? { threadId } : {}),
      createdBy: userId,
      ...(reason ? { reason } : {}),
    });

    return { status: 'ok', rule };
  });

  // DELETE /api/authorization/rules/:id — 删除规则
  app.delete('/api/authorization/rules/:id', async (request, reply) => {
    const userId = resolveAuthorizationUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const { id } = request.params as { id: string };
    const removed = await ruleStore.remove(id);
    if (!removed) {
      reply.status(404);
      return { error: 'Rule not found' };
    }

    return { status: 'ok' };
  });

  // GET /api/authorization/audit — 审计日志
  app.get('/api/authorization/audit', async (request, reply) => {
    const userId = resolveAuthorizationUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const query = request.query as Record<string, string>;
    const entries = await auditStore.list({
      ...(query.catId ? { catId: query.catId as CatId } : {}),
      ...(query.threadId ? { threadId: query.threadId } : {}),
      ...(query.limit ? { limit: parseInt(query.limit, 10) } : {}),
    });
    return { entries };
  });
};
