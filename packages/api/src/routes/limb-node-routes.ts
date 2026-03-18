/**
 * Limb Node Routes — F126 Phase C 远程节点注册/配对/心跳
 *
 * These routes are called BY remote nodes (not by cats).
 * Cats use MCP callback tools (limb_list_available, limb_invoke, limb_pair_approve).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LimbPairingStore } from '../domains/limb/LimbPairingStore.js';
import type { LimbRegistry } from '../domains/limb/LimbRegistry.js';
import { RemoteLimbNode } from '../domains/limb/RemoteLimbNode.js';

const registerSchema = z.object({
  nodeId: z.string().min(1),
  displayName: z.string().min(1),
  platform: z.string().min(1),
  endpointUrl: z.string().url(),
  capabilities: z.array(
    z.object({
      cap: z.string().min(1),
      commands: z.array(z.string().min(1)),
      authLevel: z.enum(['free', 'leased', 'gated']),
    }),
  ),
  /** Required for reconnect of approved nodes — prevents endpoint hijacking */
  apiKey: z.string().min(1).optional(),
});

const heartbeatSchema = z.object({
  apiKey: z.string().min(1),
  nodeId: z.string().min(1),
});

export interface LimbNodeRoutesOptions {
  limbRegistry: LimbRegistry;
  pairingStore: LimbPairingStore;
}

export function registerLimbNodeRoutes(
  app: FastifyInstance,
  { limbRegistry, pairingStore }: LimbNodeRoutesOptions,
): void {
  // Remote node registers itself → creates pairing request OR reconnects
  app.post('/api/limb/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const req = pairingStore.createRequest(parsed.data);

    // Reconnect: approved node → verify apiKey before allowing endpoint change
    if (req.status === 'approved') {
      // Security: reconnect of approved nodes requires matching apiKey
      if (!parsed.data.apiKey || parsed.data.apiKey !== req.apiKey) {
        return reply.status(403).send({ error: 'Reconnect requires valid apiKey' });
      }
      const endpointChanged = req.endpointUrl !== parsed.data.endpointUrl;
      // Update pairing record endpoint if changed
      if (endpointChanged) {
        req.endpointUrl = parsed.data.endpointUrl;
      }

      const existing = limbRegistry.getNode(req.nodeId);
      const needsRebuild = !existing || existing.status === 'offline' || endpointChanged;

      if (needsRebuild) {
        // Remove stale entry if present
        if (existing) limbRegistry.deregister(req.nodeId);

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
    }

    return reply.send({
      requestId: req.requestId,
      apiKey: req.apiKey,
      status: req.status,
    });
  });

  // Remote node sends heartbeat (must be approved)
  app.post('/api/limb/heartbeat', async (request, reply) => {
    const parsed = heartbeatSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { apiKey, nodeId } = parsed.data;
    const pairing = pairingStore.findByApiKey(apiKey);
    if (!pairing || pairing.nodeId !== nodeId) {
      return reply.status(403).send({ error: 'Invalid or unapproved credentials' });
    }

    limbRegistry.recordHeartbeat(nodeId);
    return reply.send({ status: 'ok' });
  });

  // Remote node deregisters itself
  app.post('/api/limb/deregister', async (request, reply) => {
    const parsed = heartbeatSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { apiKey, nodeId } = parsed.data;
    const pairing = pairingStore.findByApiKey(apiKey);
    if (!pairing || pairing.nodeId !== nodeId) {
      return reply.status(403).send({ error: 'Invalid credentials' });
    }

    limbRegistry.deregister(nodeId);
    return reply.send({ status: 'ok' });
  });

  // Pairing approve/reject/pending are ONLY available via MCP callback routes
  // (with invocationId + callbackToken auth). No public routes for approval —
  // prevents remote nodes from self-approving (砚砚 review P1-1).
}
