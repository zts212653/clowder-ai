/**
 * Callback Limb Routes — F126 四肢控制面 MCP 回调端点
 *
 * POST /api/callback/limb/list  — 列出可用四肢节点
 * POST /api/callback/limb/invoke — 调用四肢节点能力
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LimbPairingStore } from '../domains/limb/LimbPairingStore.js';
import type { LimbRegistry } from '../domains/limb/LimbRegistry.js';
import { RemoteLimbNode } from '../domains/limb/RemoteLimbNode.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const limbListSchema = z.object({
  capability: z.string().optional(),
});

const limbInvokeSchema = z.object({
  nodeId: z.string().min(1),
  command: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

const limbPairApproveSchema = z.object({
  requestId: z.string().min(1),
});

export interface CallbackLimbRoutesOptions {
  limbRegistry: LimbRegistry;
  pairingStore?: LimbPairingStore;
}

export function registerCallbackLimbRoutes(
  app: FastifyInstance,
  { limbRegistry, pairingStore }: CallbackLimbRoutesOptions,
): void {
  app.post('/api/callback/limb/list', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = limbListSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { capability } = parsed.data;

    const nodes = capability ? limbRegistry.findByCapability(capability) : limbRegistry.listAvailable();

    return reply.send({
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        displayName: n.displayName,
        platform: n.platform,
        capabilities: n.capabilities,
        status: n.status,
      })),
    });
  });

  app.post('/api/callback/limb/invoke', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = limbInvokeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { nodeId, command, params } = parsed.data;

    const result = await limbRegistry.invoke(nodeId, command, params ?? {}, {
      catId: record.catId,
      invocationId: record.invocationId,
    });
    return reply.send(result);
  });

  // Phase C: Pairing callback routes (for MCP tools)
  if (pairingStore) {
    app.post('/api/callback/limb/pair/list', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;

      return reply.send({ requests: pairingStore.getPending() });
    });

    app.post('/api/callback/limb/pair/approve', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;

      const parsed = limbPairApproveSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

      const req = pairingStore.approve(parsed.data.requestId);
      if (!req) return reply.status(404).send({ error: 'Pairing request not found' });

      // Register RemoteLimbNode if not already registered
      if (!limbRegistry.getNode(req.nodeId)) {
        const remoteNode = new RemoteLimbNode({
          nodeId: req.nodeId,
          displayName: req.displayName,
          platform: req.platform,
          capabilities: req.capabilities,
          endpointUrl: req.endpointUrl,
          apiKey: req.apiKey,
        });
        await limbRegistry.register(remoteNode);
      }

      return reply.send({ status: 'approved', nodeId: req.nodeId });
    });
  }
}
