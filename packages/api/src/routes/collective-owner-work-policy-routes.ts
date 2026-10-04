import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

const adoptInput = z.object({ expectedPolicyRevision: z.number().int().positive() }).strict();
const revokeInput = z.object({ grantRefs: z.array(z.string().trim().min(1).max(240)).min(1).max(100) }).strict();
type Request = { Params: { connectionId: string }; Body: unknown };
type Action = 'read' | 'adopt' | 'revoke';

/** Only a direct authenticated local owner can consume registered authority or contract it. */
export function registerCollectiveOwnerWorkPolicyRoutes(
  app: FastifyInstance,
  connector: () => CollectiveConnector | undefined,
) {
  const base = '/api/plugins/collective-connector/:connectionId/work-policy';
  for (const action of ['read', 'adopt', 'revoke'] as const)
    app.route<Request>({
      method: action === 'read' ? 'GET' : 'POST',
      url: action === 'read' ? base : `${base}/${action}`,
      handler: async (request, reply) => {
        try {
          const auth = await authorize(request, reply, connector(), action);
          if (!auth) return;
          return await applyOwnerAction(auth.connector, request.params.connectionId, auth.owner, action, request.body);
        } catch (error) {
          return policyError(reply, error);
        }
      },
    });
}

async function authorize(
  request: FastifyRequest<Request>,
  reply: FastifyReply,
  connector: CollectiveConnector | undefined,
  action: Action,
) {
  const access = requirePluginOwnerLocalAccess(request, action === 'read' ? 'read' : 'write');
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
async function applyOwnerAction(
  connector: CollectiveConnector,
  connectionId: string,
  owner: string,
  action: Action,
  body: unknown,
) {
  if (action === 'read') return connector.readWorkPolicyStatus(connectionId);
  if (action === 'adopt')
    return {
      policy: await connector.adoptWorkPolicy(connectionId, owner, adoptInput.parse(body).expectedPolicyRevision),
    };
  await connector.revokeWorkGrants(connectionId, owner, revokeInput.parse(body).grantRefs);
  return { disposition: 'revocation_confirmed' };
}
function policyError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_WORK_POLICY_REQUEST' });
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'WORK_POLICY_UNAVAILABLE';
  return reply
    .code(409)
    .send({ code, error: error instanceof Error ? error.message : 'Current owner policy is unavailable' });
}
