import type { CollectiveConnector, ConnectorProjection, VerifiedAgent } from '@cat-cafe/collective-connector';
import { collectiveAgentMessageRequestSchema, collectivePairingIntentSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireCapabilityWriteOwner } from '../config/capabilities/capability-write-guards.js';
import type { CollectiveConnectorBuiltinRuntime } from '../domains/plugin/builtin-runtime/collective-connector-runtime.js';
import {
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

const pairBodySchema = z
  .object({
    serviceUrl: z.string().url(),
    endpointLabel: z.string().trim().min(1).max(160),
    intent: collectivePairingIntentSchema,
  })
  .strict();

const agentMessageBodySchema = collectiveAgentMessageRequestSchema.omit({
  serviceInstanceId: true,
  collectiveId: true,
  connectionId: true,
  agent: true,
});

const hostRouteBodySchema = z
  .object({
    defaultIngressThreadId: z.string().trim().min(1).max(240),
    humanNotificationThreadId: z.string().trim().min(1).max(240),
    agentRoutes: z.record(
      z.string(),
      z
        .object({
          catId: z.string().trim().min(1).max(120),
          threadId: z.string().trim().min(1).max(240),
        })
        .strict(),
    ),
  })
  .strict();

interface CollectiveConnectorRouteOptions {
  readonly runtime: Pick<CollectiveConnectorBuiltinRuntime, 'connector'>;
  readonly callbackRegistry: CallbackAuthRegistry;
  readonly resolveAgentIdentity: (catId: string) => Omit<VerifiedAgent, 'sessionRef'> | undefined;
  readonly threadStore: {
    get(
      threadId: string,
    ):
      | { id: string; createdBy: string; participants: readonly string[]; deletedAt?: number | null }
      | null
      | Promise<{ id: string; createdBy: string; participants: readonly string[]; deletedAt?: number | null } | null>;
  };
  readonly isCatAvailable: (catId: string) => boolean;
}

interface ConnectionRequest {
  readonly Params: { connectionId: string };
}

interface AgentMessageRequest extends ConnectionRequest {
  readonly Body: unknown;
}

interface HostRouteRequest extends ConnectionRequest {
  readonly Body: unknown;
}

function requireAccess(request: FastifyRequest, reply: FastifyReply, operation: 'read' | 'write') {
  const access = requirePluginOwnerLocalAccess(request, operation);
  if ('error' in access) {
    pluginAccessError(reply, access);
    return undefined;
  }
  return access;
}

function activeConnector(
  runtime: CollectiveConnectorRouteOptions['runtime'],
  reply: FastifyReply,
): CollectiveConnector | undefined {
  const connector = runtime.connector();
  if (!connector) {
    reply.status(409).send({
      error: 'Collective Connector is not active',
      code: 'CONNECTOR_INACTIVE',
    });
  }
  return connector;
}

function operationError(reply: FastifyReply, error: unknown) {
  if (error instanceof Error && error.message === 'Host could not verify the Agent/session binding') {
    return reply.status(422).send({
      error: error.message,
      code: 'AGENT_PROVENANCE_UNVERIFIED',
    });
  }
  if (error instanceof Error && error.message === 'Collective connection was not found') {
    return reply.status(404).send({ error: error.message, code: 'CONNECTION_NOT_FOUND' });
  }
  if (error instanceof Error && error.message === 'Collective Host route belongs to another local owner') {
    return reply.status(403).send({ error: error.message, code: 'CONNECTOR_OWNER_MISMATCH' });
  }
  return reply.status(502).send({
    error: 'Collective Connector operation failed',
    code: 'CONNECTOR_OPERATION_FAILED',
  });
}

export function registerCollectiveConnectorRoutes(
  app: FastifyInstance,
  options: CollectiveConnectorRouteOptions,
): void {
  app.get('/api/plugins/collective-connector', async (request, reply) => {
    if (!requireAccess(request, reply, 'read')) return;
    const connector = options.runtime.connector();
    if (!connector) return { runtimeStatus: 'inactive', connections: [] };
    return {
      runtimeStatus: 'active',
      connections: await connector.listConnections(),
    };
  });

  app.post<{ Body: unknown }>('/api/plugins/collective-connector/pair', async (request, reply) => {
    if (!requireAccess(request, reply, 'write')) return;
    const parsed = pairBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid pairing request' });
    if (!request.headers.origin || new URL(parsed.data.intent.hostOrigin).origin !== request.headers.origin) {
      return reply.status(403).send({
        error: 'Pairing intent is not bound to this Clowder AI origin',
        code: 'PAIRING_ORIGIN_MISMATCH',
      });
    }
    const connector = activeConnector(options.runtime, reply);
    if (!connector) return;
    try {
      return await connector.pair(parsed.data);
    } catch (error) {
      return operationError(reply, error);
    }
  });

  app.post<ConnectionRequest>('/api/plugins/collective-connector/:connectionId/reconnect', async (request, reply) =>
    mutateConnection(request, reply, options.runtime, 'sync'),
  );
  app.post<ConnectionRequest>('/api/plugins/collective-connector/:connectionId/revoke', async (request, reply) =>
    mutateConnection(request, reply, options.runtime, 'revoke'),
  );

  app.get<ConnectionRequest>('/api/plugins/collective-connector/:connectionId/route', async (request, reply) => {
    const access = requireAccess(request, reply, 'read');
    if (!access) return;
    const connector = activeConnector(options.runtime, reply);
    if (!connector) return;
    try {
      const route = await connector.getHostRoute(request.params.connectionId);
      if (!route) return reply.status(404).send({ error: 'Collective Host route is not configured' });
      if (route.localOwnerUserId !== access.operator) {
        return reply.status(403).send({ error: 'Collective Host route belongs to another local owner' });
      }
      return route;
    } catch (error) {
      return operationError(reply, error);
    }
  });

  app.put<HostRouteRequest>('/api/plugins/collective-connector/:connectionId/route', async (request, reply) => {
    const access = requireAccess(request, reply, 'write');
    if (!access) return;
    const parsed = hostRouteBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid Collective Host route' });
    const connector = activeConnector(options.runtime, reply);
    if (!connector) return;
    try {
      const connection = await connector.getProjection(request.params.connectionId);
      if (!connection.authorizedHumanId) {
        return reply.status(409).send({
          error: 'Collective connection must be paired again before routing',
          code: 'IDENTITY_REBIND_REQUIRED',
        });
      }
      const routeError = await validateHostRoute(options, access.operator, connection.authorizedHumanId, parsed.data);
      if (routeError) return reply.status(422).send(routeError);
      return await connector.setHostRoute(request.params.connectionId, {
        localOwnerUserId: access.operator,
        ...parsed.data,
      });
    } catch (error) {
      return operationError(reply, error);
    }
  });

  app.register(async (callbackApp) => {
    registerCallbackAuthHook(callbackApp, options.callbackRegistry);
    callbackApp.post<AgentMessageRequest>(
      '/api/callbacks/collective-connector/:connectionId/send',
      async (request, reply) => {
        const auth = requireCallbackAuth(request, reply);
        if (!auth) return;
        const ownerError = requireCapabilityWriteOwner(auth.userId, { allowMissingOwner: true });
        if (ownerError) {
          return reply.status(ownerError.status).send({
            error: 'Collective Agent signals require configured owner authorization',
            code: 'CONNECTOR_OWNER_MISMATCH',
          });
        }
        const parsed = agentMessageBodySchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid Agent signal' });
        const identity = options.resolveAgentIdentity(auth.catId);
        if (!identity) {
          return reply.status(422).send({
            error: 'Host could not resolve the callback-authenticated Cat identity',
            code: 'AGENT_PROVENANCE_UNVERIFIED',
          });
        }
        const connector = activeConnector(options.runtime, reply);
        if (!connector) return;
        try {
          const connection = await connector.queueAgentMessage(request.params.connectionId, {
            ...parsed.data,
            agent: { ...identity, sessionRef: auth.invocationId },
          });
          return reply.status(202).send({ disposition: 'queued', connection });
        } catch (error) {
          return operationError(reply, error);
        }
      },
    );
  });

  app.get<ConnectionRequest>('/api/plugins/collective-connector/:connectionId/inbox', async (request, reply) => {
    if (!requireAccess(request, reply, 'read')) return;
    const connector = activeConnector(options.runtime, reply);
    if (!connector) return;
    try {
      return { events: await connector.listInbox(request.params.connectionId) };
    } catch (error) {
      return operationError(reply, error);
    }
  });
}

async function validateHostRoute(
  options: CollectiveConnectorRouteOptions,
  ownerUserId: string,
  authorizedHumanId: string,
  route: z.infer<typeof hostRouteBodySchema>,
): Promise<{ error: string; code: string } | undefined> {
  const destinationIds = new Set([route.defaultIngressThreadId, route.humanNotificationThreadId]);
  for (const [targetKey, agentRoute] of Object.entries(route.agentRoutes)) {
    if (!targetKey.startsWith(`${authorizedHumanId}:`)) {
      return { error: 'Agent route target does not belong to the paired Human', code: 'TARGET_NOT_LOCAL' };
    }
    const targetAgentId = targetKey.slice(authorizedHumanId.length + 1);
    if (!targetAgentId) {
      return { error: 'Agent route requires an exact Collective Agent target', code: 'AGENT_ROUTE_MISMATCH' };
    }
    if (!options.isCatAvailable(agentRoute.catId)) {
      return { error: 'Configured Cat is unavailable', code: 'ROUTE_CAT_UNAVAILABLE' };
    }
    destinationIds.add(agentRoute.threadId);
  }
  const threads = new Map<string, Awaited<ReturnType<CollectiveConnectorRouteOptions['threadStore']['get']>>>();
  for (const threadId of destinationIds) {
    const thread = await options.threadStore.get(threadId);
    if (!thread || thread.deletedAt || thread.createdBy !== ownerUserId) {
      return { error: 'Configured Thread is unavailable to this owner', code: 'ROUTE_THREAD_UNAVAILABLE' };
    }
    threads.set(threadId, thread);
  }
  for (const agentRoute of Object.values(route.agentRoutes)) {
    if (!threads.get(agentRoute.threadId)?.participants.includes(agentRoute.catId)) {
      return {
        error: 'Configured Cat is not a participant in the destination Thread',
        code: 'ROUTE_CAT_NOT_IN_THREAD',
      };
    }
  }
  return undefined;
}

async function mutateConnection(
  request: FastifyRequest<ConnectionRequest>,
  reply: FastifyReply,
  runtime: CollectiveConnectorRouteOptions['runtime'],
  operation: 'sync' | 'revoke',
): Promise<ConnectorProjection | undefined> {
  if (!requireAccess(request, reply, 'write')) return;
  const connector = activeConnector(runtime, reply);
  if (!connector) return;
  try {
    return await connector[operation](request.params.connectionId);
  } catch (error) {
    operationError(reply, error);
    return undefined;
  }
}
