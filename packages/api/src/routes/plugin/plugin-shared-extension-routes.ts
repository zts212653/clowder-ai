import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  PluginSharedExtensionError,
  type PluginSharedExtensionService,
} from '../../domains/plugin/shared-extension/plugin-shared-extension.js';

const rpcRequest = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().max(128), z.number(), z.null()]),
    method: z.string().min(1).max(100),
    params: z.unknown().optional(),
  })
  .strict();

export const pluginSharedExtensionRoutes: FastifyPluginAsync<{ service: PluginSharedExtensionService }> = async (
  app,
  options,
) => {
  app.post('/api/plugin-runtime/shared/handle', { bodyLimit: 15 * 1024 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (request.headers.authorization || request.headers['x-invocation-id'] || request.headers['x-callback-token']) {
      return reply.code(403).send({ error: 'shared_identity_rejected' });
    }
    const secret = String(request.headers['x-agent-key-secret'] ?? '');
    if (!secret) return reply.code(401).send({ error: 'shared_authentication_required' });
    const parsed = rpcRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    }
    try {
      return await options.service.handle(secret, parsed.data);
    } catch (error) {
      if (error instanceof PluginSharedExtensionError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      request.log.warn({ error }, 'Shared extension request failed');
      return reply.code(503).send({ error: 'shared_extension_unavailable' });
    }
  });
};
