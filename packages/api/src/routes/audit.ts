/**
 * Audit Route
 * GET /api/audit/thread/:threadId — 返回指定 thread 的审计事件
 *
 * 安全:
 * - logPath 绝对路径仅在 EXPOSE_LOG_PATH=true 或 NODE_ENV!=production 时返回
 *   (铲屎官需要 VSCode 跳转; 生产部署应关闭以避免路径泄露)
 * - 通过 resolveUserId 解析身份 (header > query fallback)
 * - 校验 userId 与 thread.createdBy 一致 (ownership guard)
 */

import type { FastifyPluginAsync } from 'fastify';
import { getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface AuditRoutesOptions {
  threadStore: IThreadStore;
}

export const auditRoutes: FastifyPluginAsync<AuditRoutesOptions> = async (app, opts) => {
  const { threadStore } = opts;

  app.get<{ Params: { threadId: string } }>('/api/audit/thread/:threadId', async (request, reply) => {
    const { threadId } = request.params;
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });

    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    if (thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const auditLog = getEventAuditLog();
    const events = await auditLog.readByThread(threadId, { days: 7 });
    const logFiles = await auditLog.listFiles();

    // logPath 仅在开发环境或显式开关下暴露 (避免生产路径泄露)
    const env = process.env;
    const exposePath = env.EXPOSE_LOG_PATH === 'true' || env.NODE_ENV !== 'production';
    const logPath = exposePath ? auditLog.getLogPath() : null;

    return { events, logPath, logFiles };
  });
};
