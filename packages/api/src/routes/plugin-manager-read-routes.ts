import type { FastifyInstance } from 'fastify';
import { PluginManagerPackageAssetError } from '../domains/plugin/index.js';
import { pluginAccessError, requirePluginOwnerLocalAccess, requirePluginReadAccess } from './plugin-access-guards.js';
import {
  invalidRequest,
  packageAssetStatus,
  pluginIdSchema,
  searchQuerySchema,
  sendContributionError,
  sendManagerError,
} from './plugin-manager-route-contract.js';
import type { PluginManagerRouteOptions } from './plugin-manager-routes.js';

export function registerPluginManagerReadRoutes(app: FastifyInstance, options: PluginManagerRouteOptions): void {
  const accessOptions = { allowVerifiedCallbackPrincipal: true } as const;
  app.get('/api/plugin-manager/plugins', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    try {
      return await options.manager.list();
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.get('/api/plugin-manager/plugins/search', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply);
    try {
      return await options.manager.search(parsed.data.q);
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.get('/api/plugin-manager/plugins/_local', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    try {
      return await options.manager.listLocal();
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.get('/api/plugin-manager/plugins/_local/search', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply);
    try {
      return await options.manager.searchLocal(parsed.data.q);
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.get<{ Params: { pluginId: string } }>('/api/plugin-manager/plugins/_local/:pluginId', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
    if (!parsedId.success) return invalidRequest(reply);
    try {
      const detail = await options.manager.getLocal(parsedId.data);
      if (options.bindings && detail.plugin.artifact === 'installed') {
        const owner = request.callbackPrincipal?.userId ?? access.operator;
        detail.plugin = { ...detail.plugin, bindings: await options.bindings.list(parsedId.data, owner) };
      }
      return detail;
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.get<{ Params: { pluginId: string } }>('/api/plugin-manager/plugins/:pluginId/icon', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
    if (!parsedId.success) return invalidRequest(reply);
    if (!options.asset) {
      return reply.status(503).send({ error: 'Plugin package assets are unavailable', code: 'ASSET_UNAVAILABLE' });
    }
    try {
      const asset = await options.asset.readIcon(parsedId.data);
      return reply
        .type(asset.contentType)
        .header('ETag', asset.etag)
        .header('Cache-Control', 'private, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .header('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
        .send(asset.bytes);
    } catch (error) {
      if (error instanceof PluginManagerPackageAssetError) {
        return reply.status(packageAssetStatus(error.code)).send({ error: error.message, code: error.code });
      }
      return reply.status(500).send({ error: 'Plugin package asset failed', code: 'ASSET_FAILED' });
    }
  });

  app.get<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/documentation',
    async (request, reply) => {
      const access = requirePluginOwnerLocalAccess(request, 'read');
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      if (!parsedId.success) return invalidRequest(reply);
      if (!options.documentation) {
        return reply
          .status(503)
          .send({ error: 'Plugin package documentation is unavailable', code: 'DOCUMENTATION_UNAVAILABLE' });
      }
      try {
        const readmeMarkdown = await options.documentation.readReadme(parsedId.data);
        return readmeMarkdown === undefined ? {} : { readmeMarkdown };
      } catch (error) {
        if (error instanceof PluginManagerPackageAssetError) {
          return reply.status(packageAssetStatus(error.code)).send({ error: error.message, code: error.code });
        }
        return reply.status(500).send({ error: 'Plugin package documentation failed', code: 'DOCUMENTATION_FAILED' });
      }
    },
  );

  app.get<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/contributions/tools',
    async (request, reply) => {
      const access = requirePluginReadAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      if (!parsedId.success) return invalidRequest(reply);
      if (!options.contributions) {
        return reply
          .status(503)
          .send({ error: 'Plugin contributions are unavailable', code: 'CONTRIBUTION_UNAVAILABLE' });
      }
      try {
        return { pluginId: parsedId.data, tools: await options.contributions.listPluginTools(parsedId.data) };
      } catch (error) {
        return sendContributionError(reply, error);
      }
    },
  );

  app.get<{ Params: { pluginId: string } }>('/api/plugin-manager/plugins/:pluginId', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
    if (!parsedId.success) return invalidRequest(reply);
    try {
      const detail = await options.manager.get(parsedId.data);
      if (options.bindings && detail.plugin.artifact === 'installed') {
        const owner = request.callbackPrincipal?.userId ?? access.operator;
        detail.plugin = { ...detail.plugin, bindings: await options.bindings.list(parsedId.data, owner) };
      }
      return detail;
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });
}
