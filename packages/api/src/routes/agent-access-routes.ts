import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessReadiness,
  agentAccessDetectionSchema,
  agentAccessDetectRequestSchema,
} from '@clowder-ai/agent-contract';
import type { FastifyInstance } from 'fastify';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../domains/plugin/carrier/plugin-owner-request-context.js';
import type { PluginRuntimeCarrierRouter } from '../domains/plugin/carrier/runtime-carrier.js';
import type { InventoryAuthority, PluginInventoryStore } from '../domains/plugin/host-inventory/ports.js';
import type { PluginInstanceRecord } from '../domains/plugin/host-inventory/types.js';
import { requestLifetime } from './plugin/plugin-webhook-forwarding-routes.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export function registerAgentAccessRoutes(
  app: FastifyInstance,
  {
    inventory,
    runtime,
  }: {
    inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>;
    runtime: Pick<PluginRuntimeCarrierRouter, 'attemptInvoke'>;
  },
): void {
  app.post('/api/agent-access/v1/detect', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    const parsed = agentAccessDetectRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid Agent access detection request' });

    const unavailable = (readiness: AgentAccessReadiness) => ({ readiness, candidates: [] });
    const current = currentAgentAccess(await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID));
    if ('readiness' in current) return unavailable(current.readiness);
    const { pluginInstanceId, packageDigest, lifecycleRevision } = current;
    const lifetime = requestLifetime(request, reply);
    try {
      const result = await withPluginOwnerRequest(
        {
          pluginId: AGENT_ACCESS_PLUGIN_ID,
          contributionId: 'detect',
          userId: access.operator,
          operation: 'read',
          signal: lifetime.signal,
        },
        () =>
          withPluginOwnerWebhook(
            AGENT_ACCESS_PLUGIN_ID,
            'detect',
            pluginInstanceId,
            false,
            () => {},
            () => runtime.attemptInvoke(pluginInstanceId, 'detect', parsed.data),
          ),
      );

      const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
      if (
        current?.pluginInstanceId !== pluginInstanceId ||
        current.packageDigest !== packageDigest ||
        current.lifecycleRevision !== lifecycleRevision ||
        current.runtimeState !== 'healthy'
      )
        return unavailable({ state: 'starting' });

      const detection = result.status === 'returned' ? agentAccessDetectionSchema.safeParse(result.value) : undefined;
      if (!detection?.success) {
        request.log.warn({ pluginInstanceId, packageDigest }, 'Agent access detection failed');
        return unavailable({ state: 'failed', action: 'retry' });
      }
      return { readiness: { state: 'ready' }, ...detection.data };
    } finally {
      lifetime.close();
    }
  });
}

function currentAgentAccess(
  authority: InventoryAuthority | undefined,
): PluginInstanceRecord | { readiness: AgentAccessReadiness } {
  const instance = authority?.instance;
  if (!instance || instance.lifecycleState !== 'installed')
    return { readiness: { state: 'missing', action: 'install' } };
  if (!authority.packageRecord?.manifest) return { readiness: { state: 'incompatible', action: 'repair' } };
  if (instance.activationState === 'disabled' || instance.activationState === 'disabling')
    return { readiness: { state: 'disabled', action: 'enable' } };
  if (
    instance.activationState === 'error' ||
    instance.runtimeState === 'crashed' ||
    instance.configReadiness !== 'ready'
  )
    return { readiness: { state: 'failed', action: 'repair' } };
  if (instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
    return { readiness: { state: 'starting' } };
  return instance;
}
