import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { withoutPluginCallContext } from '../../domains/plugin/carrier/plugin-call-context.js';
import { withPluginOwnerRequest } from '../../domains/plugin/carrier/plugin-owner-request-context.js';
import type { DeclaredPluginUi } from '../../domains/plugin/declared/declared-plugin-ui.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from '../plugin-access-guards.js';

export const pluginUiRoutes: FastifyPluginAsync<{ ui: DeclaredPluginUi }> = async (app, { ui }) => {
  app.get('/api/plugin-ui', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    return { entries: ui.list() };
  });
  app.post<{ Params: { instanceId: string; commandId: string }; Body: { generation: string; input: unknown } }>(
    '/api/plugin-ui/:instanceId/:commandId',
    { bodyLimit: 24_000_000 },
    async (request, reply) => {
      const access = requirePluginOwnerLocalAccess(request, 'write');
      if ('error' in access) return pluginAccessError(reply, access);
      const { instanceId, commandId } = request.params;
      const pluginId = ui.pluginId(instanceId);
      if (!pluginId || typeof request.body?.generation !== 'string')
        return reply.status(409).send({ error: '插件入口已失效，请重新打开' });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const timer = setTimeout(cancel, 180_000);
      request.raw.once('aborted', cancel);
      reply.raw.once('close', cancel);
      try {
        const result = await withoutPluginCallContext(() =>
          withPluginOwnerRequest(
            {
              pluginId,
              contributionId: commandId,
              userId: access.operator,
              operation: 'write',
              signal: controller.signal,
              requestIdentity: {
                requestId: randomUUID(),
                transportRequestId: request.id,
                method: 'POST',
                declaredPath: '/api/plugin-ui/:instanceId/:commandId',
                path: request.url,
                bodyDigest: createHash('sha256').update(JSON.stringify(request.body)).digest('hex'),
                queryDigest: createHash('sha256').update('{}').digest('hex'),
              },
            },
            () => ui.call(instanceId, commandId, request.body.generation, request.body.input),
          ),
        );
        if (Buffer.byteLength(JSON.stringify(result) ?? '') > 24_000_000)
          throw new Error('Plugin UI response exceeds budget');
        return { result };
      } catch (error) {
        // Do not serialize plugin stacks, arbitrary thrown data, or credentials.
        const message =
          error instanceof Error && /^[\u3400-\u9fff]/.test(error.message) && error.message.length < 180
            ? error.message
            : '插件操作未完成；草稿已保留，请重新检查状态';
        return reply.status(409).send({ error: message });
      } finally {
        clearTimeout(timer);
        request.raw.off('aborted', cancel);
        reply.raw.off('close', cancel);
      }
    },
  );
};
