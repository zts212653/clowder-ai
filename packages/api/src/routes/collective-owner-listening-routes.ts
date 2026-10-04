import { type CollectiveConnector, channelListeningInputSchema } from '@cat-cafe/collective-connector';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendCollectiveOwnerError } from './collective-owner-errors.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

type Request = { Params: { connectionId: string }; Body: unknown };
export function registerCollectiveOwnerListeningRoutes(
  app: FastifyInstance,
  connector: () => CollectiveConnector | undefined,
) {
  const url = '/api/plugins/collective-connector/:connectionId/listening';
  for (const method of ['GET', 'POST'] as const)
    app.route<Request>({
      method,
      url,
      handler: async (request, reply) => {
        try {
          const auth = await authorize(request, reply, connector(), method === 'GET' ? 'read' : 'write');
          if (!auth) return;
          const route =
            method === 'GET'
              ? await auth.connector.getHostRoute(request.params.connectionId)
              : await auth.connector.setChannelListening(
                  request.params.connectionId,
                  auth.owner,
                  channelListeningInputSchema.parse(request.body),
                );
          return { channelListening: route?.channelListening ?? {}, attentionRevision: route?.attentionRevision ?? 0 };
        } catch (error) {
          return sendCollectiveOwnerError(reply, error, 'INVALID_LISTENING_REQUEST', 'LISTENING_UNAVAILABLE');
        }
      },
    });
}
async function authorize(
  request: FastifyRequest<Request>,
  reply: FastifyReply,
  connector: CollectiveConnector | undefined,
  operation: 'read' | 'write',
) {
  const access = requirePluginOwnerLocalAccess(request, operation);
  if ('error' in access) {
    pluginAccessError(reply, access);
    return;
  }
  if (!connector) {
    reply.code(409).send({ code: 'CONNECTOR_INACTIVE' });
    return;
  }
  const route = await connector.getHostRoute(request.params.connectionId);
  if (route?.localOwnerUserId !== access.operator) {
    reply.code(403).send({ code: 'CONNECTOR_OWNER_MISMATCH' });
    return;
  }
  return { connector, owner: access.operator };
}
