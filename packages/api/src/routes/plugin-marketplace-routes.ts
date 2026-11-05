import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GitMarketplaceSources } from '../domains/plugin/manager/marketplace/git-marketplace-sources.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export function registerPluginMarketplaceRoutes(app: FastifyInstance, sources: GitMarketplaceSources): void {
  app.get('/api/plugin-manager/marketplaces', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    return { sources: await sources.list() };
  });
  app.post('/api/plugin-manager/marketplaces/refresh', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return pluginAccessError(reply, access);
    return { sources: await sources.refresh() };
  });
  app.post('/api/plugin-manager/marketplaces', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return pluginAccessError(reply, access);
    const body = z
      .object({ url: z.string().trim().min(1).max(4096), branch: z.string().trim().max(255).optional() })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: '请输入插件仓库地址。' });
    try {
      return { sources: await sources.add(body.data.url, body.data.branch) };
    } catch {
      return reply.status(422).send({ error: '无法添加插件仓库，请确认地址及本机 Git 访问权限。' });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/plugin-manager/marketplaces/:id', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return pluginAccessError(reply, access);
    if (!/^[a-f0-9]{24}$/.test(request.params.id)) return reply.status(400).send({ error: '无效的仓库。' });
    try {
      return { sources: await sources.remove(request.params.id) };
    } catch {
      return reply.status(409).send({ error: '默认或部署预置的仓库不能在这里移除。' });
    }
  });
}
