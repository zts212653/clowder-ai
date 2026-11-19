import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessCodexAppServerThreadRequest,
  type AgentAccessCodexAppServerTurnRequest,
  agentAccessCodexAppServerThreadPlanSchema,
  agentAccessCodexAppServerTurnPlanSchema,
} from '@clowder-ai/agent-contract';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

/**
 * Host seam for Codex app-server params.
 *
 * The package owns the JSON-RPC parameter shape; the Host retains the physical
 * process, credentials, native thread/turn identity validation, approvals,
 * cancellation and host-pool authority.
 */
function createPlanner<
  Request extends { operation: string },
  Plan,
>(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
  action: 'planCodexAppServerThread' | 'planCodexAppServerTurn',
  parse: (value: unknown) => Plan,
) {
  return async (request: Request): Promise<Plan & { assertCurrent: () => Promise<void> }> => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');

    const { pluginInstanceId, packageDigest, lifecycleRevision } = instance;
    const result = await runtime.invoke(pluginInstanceId, action, request);
    async function assertCurrent() {
      const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
      if (
        current?.pluginInstanceId !== pluginInstanceId ||
        current.packageDigest !== packageDigest ||
        current.lifecycleRevision !== lifecycleRevision ||
        current.runtimeState !== 'healthy'
      )
        throw new Error('session_implementation_unavailable');
    }
    return { ...parse(result), assertCurrent };
  };
}

export function createAgentAccessCodexAppServerThreadPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return createPlanner<AgentAccessCodexAppServerThreadRequest, ReturnType<typeof parseThread>>(
    inventory,
    runtime,
    'planCodexAppServerThread',
    (value) => agentAccessCodexAppServerThreadPlanSchema.parse(value),
  );
}

function parseThread(value: unknown) {
  return agentAccessCodexAppServerThreadPlanSchema.parse(value);
}

export function createAgentAccessCodexAppServerTurnPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return createPlanner<AgentAccessCodexAppServerTurnRequest, ReturnType<typeof parseTurn>>(
    inventory,
    runtime,
    'planCodexAppServerTurn',
    (value) => agentAccessCodexAppServerTurnPlanSchema.parse(value),
  );
}

function parseTurn(value: unknown) {
  return agentAccessCodexAppServerTurnPlanSchema.parse(value);
}
