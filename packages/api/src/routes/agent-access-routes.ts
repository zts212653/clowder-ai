import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessReadiness,
  type AgentAccessRoleMutation,
  type AgentAccessRoleMutationResult,
  agentAccessClientDirectorySchema,
  agentAccessDetectionSchema,
  agentAccessDetectRequestSchema,
  agentAccessRoleMutationResultSchema,
} from '@clowder-ai/agent-contract';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MemberConfigurationConflict } from '../config/member-config-revision.js';
import { MemberCreateConflict } from '../config/member-create-receipt.js';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../domains/plugin/carrier/plugin-owner-request-context.js';
import type { PluginRuntimeCarrierRouter } from '../domains/plugin/carrier/runtime-carrier.js';
import type { InventoryAuthority, PluginInventoryStore } from '../domains/plugin/host-inventory/ports.js';
import type { PluginInstanceRecord } from '../domains/plugin/host-inventory/types.js';
import { InvalidDshProfile } from './native-dsh-profile.js';
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
  app.get('/api/agent-access/v1/clients', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    const result = await readAgentAccess(request, reply, access.operator, 'configure', {});
    if ('readiness' in result) return { readiness: result.readiness, clients: [] };
    const directory = agentAccessClientDirectorySchema.safeParse(result.value);
    return directory.success
      ? { readiness: { state: 'ready' }, ...directory.data }
      : { readiness: { state: 'failed', action: 'retry' }, clients: [] };
  });

  app.post('/api/agent-access/v1/detect', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    const parsed = agentAccessDetectRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid Agent access detection request' });

    const unavailable = (readiness: AgentAccessReadiness) => ({ readiness, candidates: [] });
    const result = await readAgentAccess(request, reply, access.operator, 'detect', parsed.data);
    if ('readiness' in result) return unavailable(result.readiness);
    const detection = agentAccessDetectionSchema.safeParse(result.value);
    return detection.success
      ? { readiness: { state: 'ready' }, ...detection.data }
      : unavailable({ state: 'failed', action: 'retry' });
  });

  async function readAgentAccess(
    request: FastifyRequest,
    reply: FastifyReply,
    operator: string,
    method: 'detect' | 'configure',
    input: unknown,
  ): Promise<{ readiness: AgentAccessReadiness } | { value: unknown }> {
    const current = currentAgentAccess(await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID));
    if ('readiness' in current) return current;
    const { pluginInstanceId, packageDigest, lifecycleRevision } = current;
    const result = await invokeOwnerAgentAccess(request, reply, current, operator, 'read', method, input, runtime);
    const after = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (
      after?.pluginInstanceId !== pluginInstanceId ||
      after.packageDigest !== packageDigest ||
      after.lifecycleRevision !== lifecycleRevision ||
      after.runtimeState !== 'healthy'
    )
      return { readiness: { state: 'starting' } };
    if (result.status === 'returned') return { value: result.value };
    request.log.warn({ pluginInstanceId, packageDigest, method }, 'Agent access read failed');
    return { readiness: { state: 'failed', action: 'retry' } };
  }
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

export type AgentRoleWrite = (
  request: FastifyRequest,
  reply: FastifyReply,
  mutation: AgentAccessRoleMutation,
) => Promise<Extract<AgentAccessRoleMutationResult, { status: 'committed' | 'bound' }>>;

export function createAgentRoleWrite(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'attemptInvoke'>,
): AgentRoleWrite {
  return async (request, reply, mutation) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) throw Object.assign(new Error(access.error), { statusCode: access.status });
    const instance = currentAgentAccess(await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID));
    if ('readiness' in instance)
      throw Object.assign(new Error('Agent 插件未就绪，请在插件页检查状态后重试。'), { statusCode: 503 });
    const result = await invokeOwnerAgentAccess(
      request,
      reply,
      instance,
      access.operator,
      'write',
      'writeRole',
      mutation,
      runtime,
    );
    if (result.status === 'failed') throw result.error;
    const value = agentAccessRoleMutationResultSchema.parse(result.value);
    if (value.status === 'conflict') throw new MemberConfigurationConflict();
    if (value.status === 'invalid_dsh_profile')
      throw new InvalidDshProfile('DSH 的现有 ACP profile 无效，请先在客户端修复配置。');
    if (value.status === 'creation_conflict') throw new MemberCreateConflict(value.message);
    return value;
  };
}

async function invokeOwnerAgentAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  instance: PluginInstanceRecord,
  userId: string,
  operation: 'read' | 'write',
  method: string,
  input: unknown,
  runtime: Pick<PluginRuntimeCarrierRouter, 'attemptInvoke'>,
) {
  const lifetime = requestLifetime(request, reply);
  const { pluginInstanceId } = instance;
  try {
    return await withPluginOwnerRequest(
      { pluginId: AGENT_ACCESS_PLUGIN_ID, contributionId: method, userId, operation, signal: lifetime.signal },
      () =>
        withPluginOwnerWebhook(
          AGENT_ACCESS_PLUGIN_ID,
          method,
          pluginInstanceId,
          false,
          () => {},
          () => runtime.attemptInvoke(pluginInstanceId, method, input),
        ),
    );
  } finally {
    lifetime.close();
  }
}
