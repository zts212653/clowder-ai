import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DotConnectionService } from '../domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { type DotDispatchStore } from '../domains/cats/services/cloud-bridge/dot/DotDispatchStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export function registerDotTestRoutes(
  app: FastifyInstance,
  options: {
    connection: DotConnectionService;
    dispatches: DotDispatchStore;
    startTest: (ownerUserId: string) => Promise<unknown>;
    threads: Pick<IThreadStore, 'get'>;
  },
) {
  app.get<{ Params: { eventId: string } }>('/api/plugins/chatgpt-dot/delivery/:eventId', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    if (!/^dot_evt_[a-f0-9]{64}$/.test(request.params.eventId)) return reply.code(404).send();
    const record = await options.dispatches.read(request.params.eventId);
    const thread = record ? await options.threads.get(record.threadId) : null;
    if (
      !record ||
      record.ownerUserId !== access.operator ||
      !thread ||
      thread.deletedAt ||
      thread.createdBy !== access.operator
    )
      return reply.code(404).send();
    const current = await options.connection.current();
    reply.header('cache-control', 'no-store');
    return {
      threadId: record.threadId,
      receivedAt: record.webhookAcknowledgedAt,
      readAt: record.sourceReadAt,
      replyMessageId: record.replyMessageId,
      stale: current?.attemptId !== record.attemptId || current?.revokedAt != null,
    };
  });
  app.get('/api/plugins/chatgpt-dot/test', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    const state = await options.connection.current();
    if (!state || state.ownerUserId !== access.operator) return reply.code(404).send({ tests: [] });
    reply.header('cache-control', 'no-store');
    return {
      tests: await Promise.all(
        state.testEventIds.map(async (id) => {
          const record = await options.dispatches.read(id);
          return record
            ? {
                eventId: id,
                threadId: record.threadId,
                receivedAt: record.webhookAcknowledgedAt,
                readAt: record.sourceReadAt,
                replyMessageId: record.replyMessageId,
                imageCount: record.imagePublicationIds.length,
              }
            : { eventId: id, unavailable: true };
        }),
      ),
    };
  });
  app.post('/api/plugins/chatgpt-dot/test', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return pluginAccessError(reply, access);
    if (
      !z
        .object({})
        .strict()
        .safeParse(request.body ?? {}).success
    )
      return reply.code(400).send({ error: 'Invalid test request' });
    try {
      return await options.startTest(access.operator);
    } catch {
      return reply.code(409).send({ error: '请核对当前订阅后重试；已有测试不会重复派发。' });
    }
  });
}
