import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessKimiLaunch,
  agentAccessNativeLaunchArgumentsSchema,
} from '@clowder-ai/agent-contract';
import type { PluginRuntimeCarrierRouter } from './carrier/runtime-carrier.js';
import type { PluginInventoryStore } from './host-inventory/ports.js';

export function createAgentAccessKimiLaunchPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return async (launch: AgentAccessKimiLaunch) => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');
    const result = await runtime.invoke(instance.pluginInstanceId, 'configure', {
      operation: 'plan_native_launch',
      client: 'kimi',
      launch,
    });
    return {
      ...agentAccessNativeLaunchArgumentsSchema.parse(result),
      async assertCurrent() {
        const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
        if (
          current?.pluginInstanceId !== instance.pluginInstanceId ||
          current.packageDigest !== instance.packageDigest ||
          current.lifecycleRevision !== instance.lifecycleRevision ||
          current.runtimeState !== 'healthy'
        )
          throw new Error('session_implementation_unavailable');
      },
    };
  };
}
