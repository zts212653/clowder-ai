/**
 * Callback Limb Routes — F126 四肢控制面 MCP 回调端点
 *
 * POST /api/callback/limb/list       — 列出可用 limb 及其 tool 名
 * POST /api/callback/limb/list-tools — 查询指定 limb 的 tool 详细 schema
 * POST /api/callback/limb/invoke     — 调用 limb 上的指定 tool
 */

import type { LimbInvocationContext } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRecord as CallbackInvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { LimbEmbodimentBindingStore } from '../domains/limb/LimbEmbodimentBindingStore.js';
import {
  LimbPairingOwnershipConflictError,
  type LimbPairingStore,
  type PairingRequest,
} from '../domains/limb/LimbPairingStore.js';
import type { LimbRegistry } from '../domains/limb/LimbRegistry.js';
import { RemoteLimbNode } from '../domains/limb/RemoteLimbNode.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const limbListSchema = z.object({
  capability: z.string().optional(),
});

const limbListToolsSchema = z.object({
  nodeId: z.string().min(1),
  command: z.string().optional(),
});

const limbInvokeSchema = z.object({
  nodeId: z.string().min(1),
  command: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

const limbPairApproveSchema = z.object({
  requestId: z.string().min(1),
});

const limbBindEmbodimentSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    expressionRef: z.string().min(1).max(128),
    voiceProfileRef: z.string().min(1).max(128),
    volumePercent: z.number().int().min(0).max(100),
  })
  .strict();

export interface CallbackLimbRoutesOptions {
  limbRegistry: LimbRegistry;
  pairingStore?: LimbPairingStore;
  bindingStore?: LimbEmbodimentBindingStore;
  invocationRecordStore?: Pick<IInvocationRecordStore, 'get'>;
  messageStore?: Pick<IMessageStore, 'getById'>;
}

async function resolveLimbInvocationContext(
  record: CallbackInvocationRecord,
  invocationRecordStore?: Pick<IInvocationRecordStore, 'get'>,
  messageStore?: Pick<IMessageStore, 'getById'>,
): Promise<LimbInvocationContext> {
  const context: LimbInvocationContext = {
    catId: record.catId,
    invocationId: record.invocationId,
    userId: record.userId,
    threadId: record.threadId,
  };

  // A2A callbacks and invocations without a durable parent can never arm an
  // owner-authorized local UI action. Passive commands remain backward compatible.
  if (!record.parentInvocationId || record.a2aTriggerMessageId || !invocationRecordStore || !messageStore) {
    return context;
  }

  const invocation = await invocationRecordStore.get(record.parentInvocationId);
  if (!invocation?.userMessageId || invocation.userId !== record.userId || invocation.threadId !== record.threadId) {
    return context;
  }

  const message = await messageStore.getById(invocation.userMessageId);
  if (!message || message.catId !== null || message.userId !== record.userId || message.threadId !== record.threadId) {
    return context;
  }

  return { ...context, userMessageId: message.id };
}

function isApprovedByUser(pairingStore: LimbPairingStore, nodeId: string, userId: string): boolean {
  const approved = pairingStore.findApprovedByNodeId(nodeId);
  return approved?.approvedByUserId === userId;
}

export function registerCallbackLimbRoutes(
  app: FastifyInstance,
  { limbRegistry, pairingStore, bindingStore, invocationRecordStore, messageStore }: CallbackLimbRoutesOptions,
): void {
  app.post('/api/callback/limb/list', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = limbListSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { capability } = parsed.data;

    const nodes = capability ? limbRegistry.findByCapability(capability) : limbRegistry.listAvailable();

    // Discovery only — return tool names via capabilities.commands, not detailed schemas.
    // Agents call limb_list_tools for param schemas.
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

  app.post('/api/callback/limb/list-tools', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = limbListToolsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { nodeId, command } = parsed.data;
    const node = limbRegistry.getNode(nodeId);
    if (!node) return reply.send({ tools: {}, error: `Unknown node: ${nodeId}` });

    const schemas = node.commandSchemas ?? {};
    if (command) {
      const single = schemas[command];
      return reply.send({ tools: single ? { [command]: single } : {}, nodeId });
    }
    return reply.send({ tools: schemas, nodeId });
  });

  app.post('/api/callback/limb/invoke', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = limbInvokeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { nodeId, command, params } = parsed.data;

    let context: LimbInvocationContext;
    try {
      context = await resolveLimbInvocationContext(record, invocationRecordStore, messageStore);
    } catch (error) {
      request.log.warn({ error }, 'Failed to resolve trusted limb invocation provenance');
      context = {
        catId: record.catId,
        invocationId: record.invocationId,
        userId: record.userId,
        threadId: record.threadId,
      };
    }

    const result = await limbRegistry.invoke(nodeId, command, params ?? {}, context);
    return reply.send(result);
  });

  // Phase C: Pairing callback routes (for MCP tools)
  if (pairingStore) {
    app.post('/api/callback/limb/pair/list', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;

      // Pairing API keys authenticate the remote node and must never enter an
      // agent-visible tool result/message timeline. Project an explicit public
      // shape so future private fields also stay closed by default.
      return reply.send({
        requests: pairingStore.getPending().map((pending) => ({
          requestId: pending.requestId,
          nodeId: pending.nodeId,
          displayName: pending.displayName,
          platform: pending.platform,
          endpointUrl: pending.endpointUrl,
          capabilities: pending.capabilities,
          status: pending.status,
          createdAt: pending.createdAt,
        })),
      });
    });

    app.post('/api/callback/limb/pair/approve', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;

      const parsed = limbPairApproveSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

      let req: PairingRequest | null;
      try {
        req = await pairingStore.approve(parsed.data.requestId, record.userId);
      } catch (error) {
        if (error instanceof LimbPairingOwnershipConflictError) {
          return reply.status(403).send({ error: 'Pairing request belongs to another user' });
        }
        throw error;
      }
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

  if (pairingStore && bindingStore) {
    app.post('/api/callback/limb/embodiment/bind', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;

      const parsed = limbBindEmbodimentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

      const context = await resolveLimbInvocationContext(record, invocationRecordStore, messageStore);
      if (!context.userMessageId) {
        return reply.status(403).send({ error: 'Owner-initiated invocation required' });
      }

      if (!isApprovedByUser(pairingStore, parsed.data.nodeId, record.userId)) {
        return reply.status(403).send({ error: 'Body is not approved by this user' });
      }
      if (!limbRegistry.getNode(parsed.data.nodeId)) {
        return reply.status(409).send({ error: 'Approved body is not online' });
      }

      await bindingStore.put({
        ...parsed.data,
        userId: record.userId,
        threadId: record.threadId,
        catId: record.catId,
        updatedAt: Date.now(),
      });
      return reply.send({
        status: 'bound',
        nodeId: parsed.data.nodeId,
        threadId: record.threadId,
        catId: record.catId,
      });
    });
  }
}
