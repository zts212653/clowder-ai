import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DotConnectionService } from '../domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export function registerDotConnectionRoutes(
  app: FastifyInstance,
  options: {
    connection: DotConnectionService;
    publicBaseUrl: () => string | undefined;
  },
) {
  const endpoint = () => {
    const base = options.publicBaseUrl();
    if (!base) return null;
    try {
      const url = new URL(base);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
      return new URL('/mcp', url).href;
    } catch {
      return null;
    }
  };
  app.get('/api/plugins/chatgpt-dot/connection', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    reply.header('cache-control', 'no-store');
    try {
      return { ...(await options.connection.status(access.operator)), endpointUrl: endpoint() };
    } catch {
      return reply.code(403).send({ error: 'dot 连接属于另一个账号', code: 'DOT_OWNER_MISMATCH' });
    }
  });
  app.post('/api/plugins/chatgpt-dot/prepare', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return pluginAccessError(reply, access);
    const body = z
      .object({ reconnect: z.boolean().optional() })
      .strict()
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid dot connection request' });
    const url = endpoint();
    if (!url) return reply.code(409).send({ error: '云端连接地址尚未配置', code: 'DOT_ENDPOINT_UNAVAILABLE' });
    try {
      const setup = await options.connection.begin(access.operator, body.data.reconnect);
      reply.header('cache-control', 'no-store');
      // Reuse the account's existing ChatGPT connection. Its token is never rotated or copied here.
      const { credentialSecret: _credential, ...safe } = setup;
      return { ...safe, endpointUrl: url };
    } catch {
      return reply
        .code(409)
        .send({ error: '无法准备 dot 连接，请核对安装与当前账号', code: 'DOT_CONNECTION_UNAVAILABLE' });
    }
  });
  app.post('/api/plugins/chatgpt-dot/disconnect', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return pluginAccessError(reply, access);
    try {
      return await options.connection.disconnect(access.operator);
    } catch {
      return reply.code(409).send({ error: '连接状态已变化，请刷新', code: 'DOT_CONNECTION_STALE' });
    }
  });
}
